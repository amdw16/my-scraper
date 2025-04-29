/*************************************************************************
 * Scribely Alt-Text Checker – v20  (2025-04-29)
 *  · Fix: treat a page as “blocked” only when **zero** images are found,
 *    so low-image sub-pages no longer trigger the security-measure alert.
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/* ───────── helpers ───────── */
const chooseSrc = g => (
  (g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
   g('data-original')||g('data-landscape-url')||g('data-portrait-url')||
   g('src')||'').trim().split(/\s+/)[0]
);
const bgUrl = s => (s||'').match(/url\(["']?(.*?)["']?\)/i)?.[1] || '';
const norm  = s => s.replace(/\{width\}x\{height\}/gi,'600x');
const tiny  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

const wordsAround = ($,$el,N)=>{
  const grab=dir=>{
    const out=[]; let cur=$el[dir]();
    while(cur.length&&out.length<N){
      const txt=cur[0].type==='text'?cur[0].data:
               (cur[0].type==='tag'?cur.text():'');
      if(txt&&txt.trim()) out.push(...txt.trim().split(/\s+/));
      cur=cur[dir]();
    }
    return out;
  };
  return [...grab('prev').slice(-N),...grab('next').slice(0,N)]
         .join(' ').toLowerCase();
};

const bucket=(raw,url)=>{
  const g={
    'Missing Alt Text':[],
    'File Name':[],
    'Matching Nearby Content':[],
    'Manual Check':[]
  };
  const ext=/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
  raw.forEach(i=>{
    if(!i.src) return;
    try{ i.src=new URL(i.src,url).toString(); }catch{}
    const low=i.alt.toLowerCase();
    const base=(i.src.split('/').pop()||'').split('.')[0];
    const rec={src:i.src,alt:i.alt};
    if(i.matchingSnippet) rec.matchingSnippet=i.matchingSnippet;

    if(!i.alt)                      g['Missing Alt Text'].push(rec);
    else if(i.dup)                  g['Matching Nearby Content'].push(rec);
    else if(low===base||ext.test(low))
                                   g['File Name'].push(rec);
    else                            g['Manual Check'].push(rec);
  });
  return { totalImages:raw.length,errorGroups:g };
};

const filter=list=>{
  const freq=Object.create(null);
  list.forEach(i=>{ if(i.src) freq[i.src]=(freq[i.src]||0)+1; });
  return list.filter(i=>{
    if(!i.src||i.tooSmall||tiny(i.src)) return false;
    const d=freq[i.src]||0, gif=/\.gif/i.test(i.src), svg=/\.svg/i.test(i.src);
    if(d>=10&&(!i.alt||gif)) return false;
    if(d>=5 &&!i.alt&&svg)   return false;
    return true;
  });
};

/* ───────── HTML quick pass ───────── */
const UA_PC='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '+
            '(KHTML, like Gecko) Chrome/123 Safari/537.36';

async function scrapeHTML(url,N){
  let resp;
  try{
    resp=await fetch(url,{
      timeout:12000,
      headers:{
        'User-Agent':UA_PC,
        'Accept-Language':'en-US,en;q=0.9'
      }
    });
  }catch{ throw new Error('blocked'); }

  if(resp.status>=400&&resp.status<500){
    const body=await resp.text().catch(()=>'');

    const blocked=resp.status===403||resp.status===401||resp.status===429||
      /access\s+denied|request\s+blocked|captcha|cloudflare|akamai/i.test(body);

    throw new Error(blocked?'blocked':'typo');
  }
  if(!resp.ok) throw new Error('internal');

  const html=await resp.text();
  const $=cheerio.load(html);
  const raw=[];

  $('img,source,[style*="background-image"]').each((_,el)=>{
    const $e=$(el),tag=el.tagName.toLowerCase();
    let src='',alt='',too=false;
    if(tag==='img'){
      src=chooseSrc(a=>$e.attr(a));
      alt=$e.attr('alt')||'';
      const w=+$e.attr('width')||0, h=+$e.attr('height')||0;
      too=w&&h&&(w*h<=9);
    }else if(tag==='source'){
      src=chooseSrc(a=>$e.attr(a));
      alt=$e.parent('picture').find('img').attr('alt')||'';
    }else{
      src=bgUrl($e.attr('style'));
    }
    raw.push({src:norm(src),alt:alt.trim(),tooSmall:too,$el:$e});
  });

  const clean=filter(raw);
  const strip=s=>s.toLowerCase().replace(/[^a-z0-9 ]+/g,'').trim();
  clean.forEach(i=>{
    if(i.alt){
      const around=wordsAround($,i.$el,N);
      i.dup=strip(around).includes(strip(i.alt));
    }
  });
  return{report:bucket(clean,url),metrics:{raw:raw.length,kept:clean.length}};
}

/* ───────── JS-DOM pass ───────── */
async function scrapeDOM(url,N){
  const exe=await chromium.executablePath();
  async function run({jsOn,timeout,ua}){
    const browser=await puppeteer.launch({
      executablePath:exe,
      headless:chromium.headless,
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
          const len=await page.$$eval(
            'img,source,[style*="background-image"]',els=>els.length
          );
          if(len-prev<5) break;
          prev=len;
          await page.evaluate(()=>window.scrollBy(0,window.innerHeight*0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(800);
      }

      const raw=await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els,N)=>{
          const norm=s=>s.replace(/\{width\}x\{height\}/gi,'600x');
          const tok =s=>s.trim().split(/\s+/)[0];
          const strip=s=>s.toLowerCase().replace(/[^a-z0-9 ]+/g,'').trim();
          return els.map(el=>{
            const tag=el.tagName.toLowerCase();
            const g=a=>el.getAttribute(a)||'';
            let src='',alt='',too=false,dup=false;

            if(tag==='img'){
              src=g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
                  g('data-original')||g('data-landscape-url')||
                  g('data-portrait-url')||g('src')||'';
              alt=g('alt');
              too=el.width&&el.height&&(el.width*el.height<=9);
            }else if(tag==='source'){
              src=g('data-srcset')||g('srcset')||g('data-landscape-url')||
                  g('data-portrait-url')||'';
              alt=el.parentElement.querySelector('img')?.alt||'';
            }else{
              const m=/url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage||'');
              src=m?m[1]:'';
            }

            if(alt){
              const grab=(node,dir,out=[])=>{
                let n=node[dir];
                while(n&&out.length<N){
                  if(n.nodeType===3&&n.textContent.trim())
                    out.push(...n.textContent.trim().split(/\s+/));
                  else if(n.nodeType===1){
                    const t=n.textContent.trim(); if(t) out.push(...t.split(/\s+/));
                  }
                  n=n[dir];
                }
                return out;
              };
              const around=[...grab(el,'previousSibling').slice(-N),
                            ...grab(el,'nextSibling').slice(0,N)].join(' ');
              dup=strip(around).includes(strip(alt));
            }
            return{src:norm(tok(src)),alt:alt.trim(),tooSmall:too,dup};
          });
        },N
      );
      await browser.close();
      return bucket(filter(raw),url);
    }catch(e){ await browser.close(); throw e; }
  }

  try{
    /* mobile UA first (often unblocked) */
    const UA_MB='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '+
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 '+
                'Mobile/15E148 Safari/604.1';
    return await run({jsOn:false,timeout:20000,ua:UA_MB});
  }catch(e){
    if(!/Timeout/i.test(e.message)) throw e;
    return await run({jsOn:true,timeout:20000,ua:UA_PC});
  }
}

/* ───────── request handler ───────── */
module.exports=async(req,res)=>{
  const ok=[
    'https://scribely-v2.webflow.io','https://scribely.com','https://www.scribely.com',
    'https://scribelytribe.com','https://www.scribelytribe.com'
  ];
  const origin=req.headers.origin||'*';
  res.setHeader('Access-Control-Allow-Origin',ok.includes(origin)?origin:'*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST')    return res.status(405).json({error:'POST only'});

  let {url}=req.body||{};
  if(!url) return res.status(400).json({error:'Missing url'});
  if(!/^[a-z]+:\/\//i.test(url)) url='https://'+url;

  const WORDS=50, MIN_IMG=20;

  try{
    /* ---------- quick HTML probe ---------- */
    let htmlReport, metrics;
    try{
      const r=await scrapeHTML(url,WORDS);
      htmlReport=r.report; metrics=r.metrics;
    }catch(htmlErr){
      if(htmlErr.message!=='blocked') throw htmlErr;   /* typo / internal */
      /* HTML blocked → try JS-DOM before giving up */
      const dom=await scrapeDOM(url,WORDS);
      if(dom.totalImages>0)              /* ← accept any non-zero result */
        return res.status(200).json({...dom,engine:'js-dom'});
      throw htmlErr;                     /* still blocked */
    }

    /* decide if we need a DOM pass at all */
    const placeholder = 1 - (metrics.kept/(metrics.raw||1));
    const needDom = placeholder>=0.8 || htmlReport.totalImages<MIN_IMG;

    if(!needDom)
      return res.status(200).json({...htmlReport,engine:'html'});

    /* ---------- detailed DOM probe ---------- */
    const dom=await scrapeDOM(url,WORDS);

    /* NEW RULE: treat as blocked only when **zero** images returned */
    if(dom.totalImages===0) throw new Error('blocked');

    return res.status(200).json({...dom,engine:'js-dom'});

  }catch(err){
    if(/timeout/i.test(err.message)) err.message='blocked';

    if(err.message==='typo')    return res.status(400).json({error:'typo'});
    if(err.message==='blocked') return res.status(403).json({error:'blocked'});

    console.error('fatal:',err);
    return res.status(500).json({error:'internal'});
  }
};
