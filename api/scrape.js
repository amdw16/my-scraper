/*************************************************************************
 * Scribely Alt‑Text Checker – v10
 *  • Matching‑Nearby‑Content: 50‑word window (300 when deep=1)
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────── helpers ───────*/
const chooseSrc = g => {
  const raw = g('data-srcset') || g('srcset') ||
              g('data-src')    || g('data-lazy') ||
              g('data-original') || g('src') || '';
  return raw.split(',')[0].trim().split(' ')[0];
};
const bgUrl    = s => { const m=/url\(["']?(.*?)["']?\)/i.exec(s||''); return m?m[1]:''; };
const normSize = s => s.replace(/\{width\}x\{height\}/gi,'600x');
const tinyGif  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

/* ±N words before+after using Cheerio siblings */
function wordsAround($, $node, limit) {
  const collect = dir => {
    const w = []; let cur = $node[dir]();
    while (cur.length && w.length < limit) {
      const txt = (cur[0].type === 'text')
        ? cur[0].data
        : (cur[0].type === 'tag' ? cur.text() : '');
      if (txt && txt.trim()) w.push(...txt.trim().split(/\s+/));
      cur = cur[dir]();
    }
    return w;
  };
  const before = collect('prev'), after = collect('next');
  return [...before.slice(-limit), ...after.slice(0, limit)].join(' ').toLowerCase();
}

function bucket(imgs,url){
  const groups={ 'Missing Alt Text':[], 'File Name':[],
                 'Matching Nearby Content':[], 'Manual Check':[] };
  const ext=/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
  imgs.forEach(it=>{
    try{ it.src=new URL(it.src,url).toString(); }catch{}
    if(!it.src)return;
    const al=it.alt.toLowerCase();
    const base=(it.src.split('/').pop()||'').split('.')[0];
    if(!it.alt) groups['Missing Alt Text'].push(it);
    else if(it.dup) groups['Matching Nearby Content'].push(it);
    else if(al===base.toLowerCase()||ext.test(al))
      groups['File Name'].push(it);
    else groups['Manual Check'].push(it);
  });
  return{ totalImages:imgs.length, errorGroups:groups };
}
function filterPlaceholders(list){
  const freq=Object.create(null);
  list.forEach(i=>{ if(i.src) freq[i.src]=(freq[i.src]||0)+1; });
  return list.filter(i=>{
    if(!i.src||i.tooSmall||tinyGif(i.src))return false;
    const d=freq[i.src]||0, gif=/\.gif/i.test(i.src), svg=/\.svg/i.test(i.src);
    if(d>=10&&(!i.alt||gif))return false;
    if(d>=5&&!i.alt&&svg)   return false;
    return true;
  });
}

/*──────── HTML fast path ───────*/
async function scrapeHTML(url, wordLimit, runDup){
  const html=await(await fetch(url,{timeout:6000})).text();
  const $=cheerio.load(html);
  const raw=[];
  $('img,source,[style*="background-image"]').each((_,el)=>{
    const $e=$(el),t=el.tagName.toLowerCase();
    let s='',a='',too=false;
    if(t==='img'){
      s=chooseSrc(a=>$e.attr(a)); a=$e.attr('alt')||'';
      const w=+$e.attr('width')||0,h=+$e.attr('height')||0; too=w&&h&&(w*h<=9);
    }else if(t==='source'){
      s=chooseSrc(a=>$e.attr(a)); a=$e.parent('picture').find('img').attr('alt')||'';
    }else{ s=bgUrl($e.attr('style')); }
    raw.push({src:normSize(s),alt:a.trim(),tooSmall:too,$el:$e});
  });
  const clean=filterPlaceholders(raw);

  /* duplicate rule */
  if(runDup){
    clean.forEach(it=>{
      if(it.alt){
        const around=wordsAround($, it.$el, wordLimit);
        if(around.includes(it.alt.toLowerCase())) it.dup=true;
      }
    });
  }
  return{
    report : bucket(clean,url),
    metrics: { raw:raw.length, kept:clean.length }
  };
}

/*──────── JS‑DOM path ──────────*/
async function scrapeDOM(url, wordLimit, runDup){
  const exec=await chromium.executablePath();
  async function run({jsOn,timeout,ua}){
    const browser=await puppeteer.launch({
      executablePath:exec, headless:chromium.headless,
      args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox']
    });
    try{
      const page=await browser.newPage();
      await page.setJavaScriptEnabled(jsOn);
      await page.setUserAgent(ua);
      await page.setRequestInterception(true);
      const block=new Set(['image','stylesheet','font','media']);
      page.on('request',r=>block.has(r.resourceType())?r.abort():r.continue());
      await page.goto(url,{waitUntil:'domcontentloaded',timeout});
      if(jsOn){
        let prev=0;
        for(let i=0;i<12;i++){
          const len=await page.$$eval('img,source,[style*="background-image"]',e=>e.length);
          if(len-prev<5)break; prev=len;
          await page.evaluate(()=>window.scrollBy(0,window.innerHeight*0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }
      const raw=await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els, runDup, wordLimit) => els.map(el=>{
          const g=a=>el.getAttribute(a)||'', bg=()=>{
            const m=/url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage||'');return m?m[1]:'';
          };
          const tag=el.tagName.toLowerCase(); let s='',a='',too=false;
          if(tag==='img'){
            s=g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
              g('data-original')||g('src')||'';
            a=g('alt'); too=el.width&&el.height&&(el.width*el.height<=9);
          }else if(tag==='source'){
            s=g('data-srcset')||g('srcset')||''; a=el.parentElement.querySelector('img')?.alt||'';
          }else{ s=bg(); }
          let dup=false;
          if(runDup && a){
            const collect=(dir)=>{
              const w=[]; let n=el[dir];
              while(n && w.length<wordLimit){
                if(n.nodeType===3 && n.textContent.trim())
                  w.push(...n.textContent.trim().split(/\s+/));
                else if(n.nodeType===1){
                  const t=n.textContent.trim(); if(t) w.push(...t.split(/\s+/));
                }
                n=n[dir];
              }
              return w;
            };
            const before=collect('previousSibling'), after=collect('nextSibling');
            const around=[...before.slice(-wordLimit),...after.slice(0,wordLimit)].join(' ').toLowerCase();
            dup=around.includes(a.toLowerCase());
          }
          return{src:s,alt:a.trim(),tooSmall:too,dup};
        }), runDup, wordLimit
      );
      await browser.close();
      const clean=filterPlaceholders(raw).map(i=>({...i,src:normSize(i.src)}));
      return bucket(clean,url);
    }catch(e){await browser.close(); throw e;}
  }
  const UA_PC='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36',
        UA_MB='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '+
              'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  try{ return await run({jsOn:true, timeout:7000, ua:UA_PC}); }
  catch(e){ if(!/Timeout/i.test(e.message))throw e;
            return await run({jsOn:false, timeout:10000, ua:UA_MB}); }
}

/*──────── HTTP handler ─────────*/
module.exports=async(req,res)=>{
  const ok=[
    'https://scribely-v2.webflow.io','https://scribely.com',
    'https://www.scribely.com','https://scribelytribe.com',
    'https://www.scribelytribe.com'];
  const o=req.headers.origin||'*';
  res.setHeader('Access-Control-Allow-Origin',ok.includes(o)?o:'*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(200).end();
  if(req.method!=='POST')    return res.status(405).json({error:'POST only'});

  let{url,deep}=req.body||{}; if(!url) return res.status(400).json({error:'Missing url'});
  if(!/^https?:\/\//i.test(url)) url='https://'+url;

  const deepFlag = deep === 1;
  const wordLimit = deepFlag ? 300 : 50;

  try{
    const {report:first,metrics}=await scrapeHTML(url, wordLimit, true);
    const placeholderRatio=1-metrics.kept/(metrics.raw||1);
    const needDom=placeholderRatio>=0.8 || first.totalImages<20;
    if(!needDom) return res.status(200).json({...first,engine:'html'});

    const domReport=await scrapeDOM(url, wordLimit, deepFlag || first.totalImages<=400);
    if(domReport.totalImages<20){
      return res.status(200).json({
        ...first, engine:'html', blocked:true,
        note:'Site blocks headless browsers; only server‑rendered images analysed.'
      });
    }
    return res.status(200).json({...domReport,engine:'js-dom'});

  }catch(err){
    console.error('fatal:',err.message);
    return res.status(200).json({ blocked:true,
      note:'Site blocks headless browsers; only server‑rendered images analysed.',
      totalImages:0, errorGroups:{}, engine:'none'});
  }
};
