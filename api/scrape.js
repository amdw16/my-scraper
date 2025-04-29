/*************************************************************************
 * Scribely Alt-Text Checker – v12
 * • Deep-scan flag removed (always runs duplicate-text detection)
 * • Supports Nike’s data-landscape-url / data-portrait-url attributes
 *************************************************************************/

const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────────────── helper utilities ────────────────*/
const chooseSrc = g => {
  const raw = g('data-srcset')       || g('srcset') ||
              g('data-src')          || g('data-lazy') ||
              g('data-original')     || g('data-landscape-url') ||
              g('data-portrait-url') || g('src') || '';
  return raw.split(',')[0].trim().split(' ')[0];
};
const bgUrl = s => (s || '').match(/url\(["']?(.*?)["']?\)/i)?.[1] || '';
const norm  = s => s.replace(/\{width\}x\{height\}/gi,'600x');
const tiny  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

/* grab ±N words around an element */
function wordsAround($,$el,N){
  const grab=dir=>{
    const w=[];let cur=$el[dir]();
    while(cur.length&&w.length<N){
      const txt=cur[0].type==='text'?cur[0].data:(cur[0].type==='tag'?cur.text():'');
      if(txt&&txt.trim())w.push(...txt.trim().split(/\s+/));
      cur=cur[dir]();
    }
    return w;
  };
  return [...grab('prev').slice(-N),...grab('next').slice(0,N)].join(' ').toLowerCase();
}

/* bucket images into result groups */
function bucket(raw,url){
  const g={ 'Missing Alt Text':[], 'File Name':[], 'Matching Nearby Content':[], 'Manual Check':[] };
  const extRE=/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  raw.forEach(i=>{
    if(!i.src)return;
    try{i.src=new URL(i.src,url).toString();}catch{}
    const alt=i.alt.toLowerCase();
    const base=(i.src.split('/').pop()||'').split('.')[0];
    const clean={src:i.src,alt:i.alt};
    if(i.matchingSnippet)clean.matchingSnippet=i.matchingSnippet;

    if(!i.alt)g['Missing Alt Text'].push(clean);
    else if(i.dup)g['Matching Nearby Content'].push(clean);
    else if(alt===base||extRE.test(alt))g['File Name'].push(clean);
    else g['Manual Check'].push(clean);
  });
  return{totalImages:raw.length,errorGroups:g};
}

function filter(list){
  const freq=Object.create(null);
  list.forEach(i=>{if(i.src)freq[i.src]=(freq[i.src]||0)+1;});
  return list.filter(i=>{
    if(!i.src||i.tooSmall||tiny(i.src))return false;
    const d=freq[i.src]||0,gif=/\.gif/i.test(i.src),svg=/\.svg/i.test(i.src);
    if(d>=10&&(!i.alt||gif))return false;
    if(d>=5&&!i.alt&&svg)return false;
    return true;
  });
}

/*──────── HTML quick pass ───────*/
async function scrapeHTML(url,N){
  const resp=await fetch(url,{timeout:6000});
  if(!resp.ok)throw new Error('typo');
  const $=cheerio.load(await resp.text());
  const raw=[];

  $('img,source,[style*="background-image"]').each((_,el)=>{
    const $e=$(el),t=el.tagName.toLowerCase();
    let s='',a='',too=false;
    if(t==='img'){
      s=chooseSrc(attr=>$e.attr(attr));a=$e.attr('alt')||'';
      const w=+$e.attr('width')||0,h=+$e.attr('height')||0;
      too=w&&h&&(w*h<=9);
    }else if(t==='source'){
      s=chooseSrc(attr=>$e.attr(attr));
      a=$e.parent('picture').find('img').attr('alt')||'';
    }else s=bgUrl($e.attr('style'));
    raw.push({src:norm(s),alt:a.trim(),tooSmall:too,$el:$e});
  });

  const clean=filter(raw);
  clean.forEach(i=>{
    if(i.alt&&wordsAround($,i.$el,N).includes(i.alt.toLowerCase()))i.dup=true;
  });
  return{report:bucket(clean,url),metrics:{raw:raw.length,kept:clean.length}};
}

/*──────── JS-DOM detailed pass ───────*/
async function scrapeDOM(url,N){
  const exe=await chromium.executablePath();
  async function run({jsOn,timeout,ua}){
    const browser=await puppeteer.launch({
      executablePath:exe,headless:chromium.headless,
      args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox']
    });
    try{
      const page=await browser.newPage();
      await page.setJavaScriptEnabled(jsOn);await page.setUserAgent(ua);
      await page.setRequestInterception(true);
      const block=new Set(['image','stylesheet','font','media']);
      page.on('request',r=>block.has(r.resourceType())?r.abort():r.continue());
      await page.goto(url,{waitUntil:'domcontentloaded',timeout});

      if(jsOn){ /* lazy-load scroll */
        let prev=0;
        for(let i=0;i<12;i++){
          const len=await page.$$eval('img,source,[style*="background-image"]',els=>els.length);
          if(len-prev<5)break;prev=len;
          await page.evaluate(()=>window.scrollBy(0,window.innerHeight*0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }

      const raw=await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els,N)=>els.map(el=>{
          const tag=el.tagName.toLowerCase();const g=a=>el.getAttribute(a)||'';
          let s='',a='',too=false,dup=false;
          if(tag==='img'){
            s=g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
              g('data-original')||g('data-landscape-url')||g('data-portrait-url')||g('src')||'';
            a=g('alt');too=el.width&&el.height&&(el.width*el.height<=9);
          }else if(tag==='source'){
            s=g('data-srcset')||g('srcset')||g('data-landscape-url')||g('data-portrait-url')||'';
            a=el.parentElement.querySelector('img')?.alt||'';
          }else{
            const m=/url\\([\"']?(.*?)[\"']?\\)/.exec(el.style.backgroundImage||'');s=m?m[1]:'';
          }
          if(a){
            const grab=dir=>{
              const w=[];let n=el[dir];
              while(n&&w.length<N){
                if(n.nodeType===3&&n.textContent.trim())w.push(...n.textContent.trim().split(/\\s+/));
                else if(n.nodeType===1){
                  const t=n.textContent.trim();if(t)w.push(...t.split(/\\s+/));
                }
                n=n[dir];
              }
              return w;
            };
            const around=[...grab('previousSibling').slice(-N),...grab('nextSibling').slice(0,N)].join(' ').toLowerCase();
            dup=around.includes(a.toLowerCase());
          }
          return{src:s,alt:a.trim(),tooSmall:too,dup};
        }),N
      );

      await browser.close();
      return bucket(filter(raw).map(i=>({...i,src:norm(i.src)})),url);
    }catch(e){await browser.close();throw e;}
  }

  try{return await run({jsOn:true,timeout:7000,ua:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36'});}
  catch(e){
    if(!/Timeout/i.test(e.message))throw e;
    return await run({jsOn:false,timeout:10000,ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
  }
}

/*──────── HTTP handler ───────*/
module.exports = async (req,res)=>{
  const ok=[
    'https://scribely-v2.webflow.io','https://scribely.com','https://www.scribely.com',
    'https://scribelytribe.com','https://www.scribelytribe.com'
  ];
  const origin=req.headers.origin||'*';
  res.setHeader('Access-Control-Allow-Origin',ok.includes(origin)?origin:'*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='POST')    return res.status(405).json({error:'POST only'});

  let {url}=req.body||{};
  if(!url) return res.status(400).json({error:'Missing url'});
  if(!/^[a-z]+:\\/\\//i.test(url)) url='https://'+url;

  const N=50; /* words for duplicate-match window */

  try{
    const {report:first,metrics}=await scrapeHTML(url,N);
    const placeholderRatio=1-(metrics.kept/(metrics.raw||1));
    const needDom=placeholderRatio>=0.8||first.totalImages<20;

    if(!needDom) return res.status(200).json({...first,engine:'html'});

    const dom=await scrapeDOM(url,N);
    if(dom.totalImages<20){
      return res.status(200).json({
        ...first,engine:'html',blocked:true,
        note:'Site blocks headless browsers; only server-rendered images analysed.'
      });
    }
    return res.status(200).json({...dom,engine:'js-dom'});
  }catch(err){
    if(err.message==='typo')        return res.status(400).json({error:'typo'});
    if(err.message.includes('blocked')) return res.status(403).json({error:'blocked'});
    console.error('fatal:',err);
    return res.status(500).json({error:'internal'});
  }
};
