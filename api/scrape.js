/*************************************************************************
 * Scribely Alt‑Text Checker – v8.2
 *  • srcset + <source> + background-image parser
 *  • deeper lazy‑scroll (12x)
 *  • filters tiny data‑URL GIF placeholders
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────────────────── Helpers ───────────────────────────*/
const chooseSrc = g => {
  const raw =
    g('data-srcset') || g('srcset') ||
    g('data-src')    || g('data-lazy') ||
    g('data-original') || g('src') || '';
  return raw.split(',')[0].trim().split(' ')[0];      // first token
};
const extractBgUrl = style =>{
  const m = /background-image\s*:\s*url\(["']?(.*?)["']?\)/i.exec(style||'');
  return m ? m[1] : '';
};
const normaliseSizeToken = s => s.replace(/\{width\}x\{height\}/gi,'600x');

function buildReport(imgs,pageUrl){
  const groups={'Missing Alt Text':[],'File Name':[],
                'Matching Nearby Content':[],'Manual Check':[]};
  const ext=/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
  imgs.forEach(it=>{
    try{it.src=new URL(it.src,pageUrl).toString();}catch{}
    if(!it.src)return;
    const al=it.alt.toLowerCase();
    const base=(it.src.split('/').pop()||'').split('.')[0];
    if(!it.alt)                               return groups['Missing Alt Text'].push(it);
    if(al===base.toLowerCase()||ext.test(al)) return groups['File Name'].push(it);
    groups['Manual Check'].push(it);
  });
  return{totalImages:imgs.length,errorGroups:groups};
}
function filterPlaceholders(list){
  const freq=Object.create(null);
  list.forEach(it=>{if(it.src)freq[it.src]=(freq[it.src]||0)+1;});
  return list.filter(it=>{
    if(!it.src||it.tooSmall)return false;
    const d=freq[it.src]||0,
          gif=/\.gif(?:$|\?)/i.test(it.src),
          svg=/\.svg(?:$|\?)/i.test(it.src),
          tinyData=/^data:image\/gif;base64,/i.test(it.src)&&it.src.length<200;
    if(d>=10&&(!it.alt||gif))return false;
    if(d>=5&&!it.alt&&svg)   return false;
    if(tinyData)            return false;
    return true;
  });
}

/*──────────────────── Stage 1: fast HTML ───────────────*/
async function scrapeHtml(url){
  const html=await(await fetch(url,{timeout:6000})).text();
  const $=cheerio.load(html);
  const raw=[];
  $('img,source,[style*="background-image"]').each((_,el)=>{
    const $el=$(el),tag=el.tagName.toLowerCase();
    let src='',alt='',tooSmall=false;
    if(tag==='img'){
      const w=+$el.attr('width')||0,h=+$el.attr('height')||0;
      tooSmall=w&&h&&(w*h<=9);
      src=chooseSrc(a=>$el.attr(a));
      alt=($el.attr('alt')||'').trim();
    }else if(tag==='source'){
      src=chooseSrc(a=>$el.attr(a));
      alt=$el.parent('picture').find('img').attr('alt')||'';
    }else{
      src=extractBgUrl($el.attr('style'));
      alt='';
    }
    src=normaliseSizeToken(src);
    raw.push({src,alt,tooSmall});
  });
  const cleaned=filterPlaceholders(raw);
  return{
    report:buildReport(cleaned,url),
    metrics:{
      totalRaw:raw.length,
      discarded:raw.length-cleaned.length,
      htmlSample:html.slice(0,5000)
    }
  };
}

/*──────────────────── Stage 2: adaptive JS‑DOM ─────────*/
async function scrapeJsDom(url){
  const exec=await chromium.executablePath();
  async function runPass({jsOn,timeout,ua}){
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
          if(len-prev<5)break;
          prev=len;
          await page.evaluate(()=>window.scrollBy(0,window.innerHeight*0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }
      const raw=await page.$$eval('img,source,[style*="background-image"]',els=>{
        function pick(el,a){return el.getAttribute(a)||'';}
        function bg(el){const m=/url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage||'');return m?m[1]:'';}
        return els.map(el=>{
          const tag=el.tagName.toLowerCase();
          let src='',alt='',tooSmall=false;
          if(tag==='img'){
            src=pick(el,'data-srcset')||pick(el,'srcset')||
                pick(el,'data-src')||pick(el,'data-lazy')||
                pick(el,'data-original')||pick(el,'src')||'';
            alt=pick(el,'alt');
            const w=el.width||0,h=el.height||0;tooSmall=w&&h&&(w*h<=9);
          }else if(tag==='source'){
            src=pick(el,'data-srcset')||pick(el,'srcset')||'';
            alt=el.parentElement.querySelector('img')?.alt||'';
          }else{ src=bg(el); }
          return{src,alt:alt.trim(),tooSmall};
        });
      });
      await browser.close();
      const fixed=raw.map(it=>({...it,src:normaliseSizeToken(it.src)}));
      const report=buildReport(filterPlaceholders(fixed),url);
      if(jsOn&&raw.length>=120)report.partial=true;
      return report;
    }catch(e){await browser.close();throw e;}
  }
  const UA_PC   ='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36';
  const UA_MOB  ='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '+
                 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  try{ return await runPass({jsOn:true, timeout:7000, ua:UA_PC}); }
  catch(e){ if(!/Timeout/i.test(e.message))throw e;
            return await runPass({jsOn:false, timeout:10000, ua:UA_MOB}); }
}

/*──────────────────── HTTP handler (unchanged) ─────────────────────*/
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
  let{url}=req.body||{};
  if(!url)                       return res.status(400).json({error:'Missing url'});
  if(!/^https?:\/\//i.test(url)) url='https://'+url;
  try{
    const {report:first,metrics}=await scrapeHtml(url);
    const ratio=metrics.discarded/(metrics.totalRaw||1);
    const hasLazy=/loading\s*=\s*["']lazy["']|data-src/i.test(metrics.htmlSample);
    const needJs=ratio>=0.3||metrics.totalRaw<15||hasLazy;
    if(!needJs) return res.status(200).json({...first,engine:'html'});
    const second=await scrapeJsDom(url);
    return res.status(200).json({...second,engine:'js-dom'});
  }catch(err){
    console.error('alt‑checker fatal:',err);
    return res.status(500).json({error:'Unable to analyse this URL.'});
  }
};
