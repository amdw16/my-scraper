/*************************************************************************
 * Scribely Alt‑Text Checker – v10
 *  • Missing Alt, File‑name, Manual.
 *  • Matching‑Nearby‑Content:
 *      – 50‑word window by default
 *      – 300‑word window when POST body { deep:1 }
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────── helper utilities ───────*/
const chooseSrc = g=>{
  const raw=g('data-srcset')||g('srcset')||
            g('data-src')||g('data-lazy')||
            g('data-original')||g('src')||'';
  return raw.split(',')[0].trim().split(' ')[0];
};
const bgUrl = s=>{const m=/url\(["']?(.*?)["']?\)/i.exec(s||'');return m?m[1]:'';};
const norm  = s=>s.replace(/\{width\}x\{height\}/gi,'600x');
const tiny  = u=>/^data:image\/gif;base64,/i.test(u)&&u.length<200;

/* ±N words before+after (Cheerio siblings) */
function wordsAround($,$node,limit){
  const grab=dir=>{
    const w=[];let cur=$node[dir]();
    while(cur.length&&w.length<limit){
      const txt=(cur[0].type==='text')?cur[0].data
               :(cur[0].type==='tag'?cur.text():'');
      if(txt&&txt.trim())w.push(...txt.trim().split(/\s+/));
      cur=cur[dir]();
    }
    return w;
  };
  const before=grab('prev'),after=grab('next');
  return [...before.slice(-limit),...after.slice(0,limit)].join(' ').toLowerCase();
}

/* bucket by rule */
function bucket(list,url){
  const g={'Missing Alt Text':[],'File Name':[],
           'Matching Nearby Content':[],'Manual Check':[]};
  const ext=/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
  list.forEach(i=>{
    try{i.src=new URL(i.src,url).toString();}catch{}
    if(!i.src)return;
    const al=i.alt.toLowerCase(),base=(i.src.split('/').pop()||'').split('.')[0];
    if(!i.alt)g['Missing Alt Text'].push(i);
    else if(i.dup)g['Matching Nearby Content'].push(i);
    else if(al===base.toLowerCase()||ext.test(al))g['File Name'].push(i);
    else g['Manual Check'].push(i);
  });
  return{totalImages:list.length,errorGroups:g};
}
function filter(list){
  const freq=Object.create(null);
  list.forEach(i=>{if(i.src)freq[i.src]=(freq[i.src]||0)+1;});
  return list.filter(i=>{
    if(!i.src||i.tooSmall||tiny(i.src))return false;
    const d=freq[i.src]||0,gif=/\.gif/i.test(i.src),svg=/\.svg/i.test(i.src);
    if(d>=10&&(!i.alt||gif))return false;
    if(d>=5&&!i.alt&&svg)   return false;
    return true;
  });
}

/*──────── HTML quick pass ───────*/
async function scrapeHTML(url,limit,dup){
  const html=await(await fetch(url,{timeout:6000})).text();
  const $=cheerio.load(html); const raw=[];
  $('img,source,[style*="background-image"]').each((_,el)=>{
    const $e=$(el),t=el.tagName.toLowerCase();let s='',a='',too=false;
    if(t==='img'){
      s=chooseSrc(a=>$e.attr(a));a=$e.attr('alt')||'';
      const w=+$e.attr('width')||0,h=+$e.attr('height')||0;too=w&&h&&(w*h<=9);
    }else if(t==='source'){
      s=chooseSrc(a=>$e.attr(a));a=$e.parent('picture').find('img').attr('alt')||'';
    }else s=bgUrl($e.attr('style'));
    raw.push({src:norm(s),alt:a.trim(),tooSmall:too,$el:$e});
  });
  const clean=filter(raw);
  if(dup){
    clean.forEach(it=>{
      if(it.alt&&wordsAround($,it.$el,limit).includes(it.alt.toLowerCase()))
        it.dup=true;
    });
  }
  return{report:bucket(clean,url),
         metrics:{raw:raw.length,kept:clean.length}};
}

/*──────── JS‑DOM detailed pass ───────*/
async function scrapeDOM(url,limit,dup){
  const exe=await chromium.executablePath();
  async function run({jsOn,timeout,ua}){
    const browser=await puppeteer.launch({
      executablePath:exe,headless:chromium.headless,
      args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox']});
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
          if(len-prev<5)break;prev=len;
          await page.evaluate(()=>window.scrollBy(0,window.innerHeight*0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }
      const raw=await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els,dupFlg,lim)=>{
          const bg=el=>{
            const m=/url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage||'');return m?m[1]:'';
          };
          return els.map(el=>{
            const g=a=>el.getAttribute(a)||'',tag=el.tagName.toLowerCase();
            let s='',a='',too=false,dup=false;
            if(tag==='img'){
              s=g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
                g('data-original')||g('src')||'';
              a=g('alt');too=el.width&&el.height&&(el.width*el.height<=9);
            }else if(tag==='source'){
              s=g('data-srcset')||g('srcset')||'';
              a=el.parentElement.querySelector('img')?.alt||'';
            }else s=bg(el);

            if(dupFlg&&a){
              const grab=(dir)=>{
                const w=[];let n=el[dir];
                while(n&&w.length<lim){
                  if(n.nodeType===3&&n.textContent.trim())
                    w.push(...n.textContent.trim().split(/\s+/));
                  else if(n.nodeType===1){
                    const t=n.textContent.trim();if(t)w.push(...t.split(/\s+/));
                  }
                  n=n[dir];
                }
                return w;
              };
              const before=grab('previousSibling'),after=grab('nextSibling');
              const around=[...before.slice(-lim),...after.slice(0,lim)].join(' ').toLowerCase();
              dup=around.includes(a.toLowerCase());
            }
            return{src:s,alt:a.trim(),tooSmall:too,dup};
          });
        },dup,limit);
      await browser.close();
      const clean=filter(raw).map(i=>({...i,src:norm(i.src)}));
      return bucket(clean,url);
    }catch(e){await browser.close();throw e;}
  }
  const UA_PC='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36',
        UA_MB='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '+
              'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  try{ return await run({jsOn:true,timeout:7000,ua:UA_PC}); }
  catch(e){ if(!/Timeout/i.test(e.message))throw e;
            return await run({jsOn:false,timeout:10000,ua:UA_MB}); }
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

  const deepFlag  = deep === 1;
  const wordLimit = deepFlag ? 300 : 50;

  try{
    const {report:first,metrics}=await scrapeHTML(url,wordLimit,true);
    const placeholderRatio=1-metrics.kept/(metrics.raw||1);
    const needDom=placeholderRatio>=0.8 || first.totalImages<20;
    if(!needDom) return res.status(200).json({...first,engine:'html'});

    const domReport=await scrapeDOM(url,wordLimit,deepFlag||first.totalImages<=400);
    if(domReport.totalImages<20){
      return res.status(200).json({
        ...first,engine:'html',blocked:true,
        note:'Site blocks headless browsers; only server‑rendered images analysed.'});
    }
    return res.status(200).json({...domReport,engine:'js-dom'});

  }catch(err){
    console.error('fatal:',err.message);
    return res.status(200).json({blocked:true,
      note:'Site blocks headless browsers; only server‑rendered images analysed.',
      totalImages:0,errorGroups:{},engine:'none'});
  }
};
