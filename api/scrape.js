// api/scrape.js  –  2025‑04‑16 patched edition
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio  = require('cheerio');

// hard caps
const PAGE_TIMEOUT_MS   = 15000;   // navigation + scrolling total
const NETWORK_IDLE_MS   = 1500;    // consider idle when no requests > this long
const SCROLL_STEPS      = 6;       // how many viewport‑heights to scroll

module.exports = async (req, res) => {
  /*──────────────────────── 0. CORS & input ────────────────────────*/
  const okOrigins = [
    'https://scribely-v2.webflow.io',
    'https://scribely.com',       'https://www.scribely.com',
    'https://scribelytribe.com',  'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin',
                okOrigins.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')     return res.status(405).json({error:'POST only'});

  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({error:'Missing url'});
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  /*──────────────────────── 1. Launch trimmed Chromium ─────────────*/
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args: [
      ...chromium.args,
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      // recent stable UA string prevents simple bot blocks
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});

    /*── 1‑a  Abort downloads we never need ─────────────────────────*/
    await page.setRequestInterception(true);
    const abortTypes = new Set(['stylesheet','font','media','other']);
    page.on('request', req => {
      if (abortTypes.has(req.resourceType())) return req.abort();
      req.continue();
    });

    /*── 1‑b  Navigate ──────────────────────────────────────────────*/
    await page.goto(url, {waitUntil:'domcontentloaded',timeout:PAGE_TIMEOUT_MS});

    /*── 1‑c  Force‑load lazy images ────────────────────────────────*/
    // Manual many‑viewport scroll – cheaper than evaluate(infinite‑scroll)
    for (let i = 0; i < SCROLL_STEPS; i++) {
      await page.evaluate(_=>window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(150);            // small easing
    }
    // wait for network to settle OR the hard cap
    await Promise.race([
      page.waitForNetworkIdle({idleTime:NETWORK_IDLE_MS}),
      page.waitForTimeout(PAGE_TIMEOUT_MS)
    ]);

    /*──────────────────────── 2. Collect data inside the page ──────*/
    const raw = await page.evaluate(() => {
      function nearestText(node, dir) {
        let cur = node[dir];
        let words = [];
        while (cur && words.length < 300) {
          if (cur.nodeType === 3 && cur.textContent.trim()) {
            words.push(...cur.textContent.trim().split(/\s+/));
          } else if (cur.nodeType === 1) {
            const txt = cur.textContent.trim();
            if (txt) words.push(...txt.split(/\s+/));
          }
          cur = cur[dir];
        }
        return words;
      }

      return Array.from(document.images).map(img => {
        const rawSrc =
           img.currentSrc || img.src ||
           img.dataset?.src || img.dataset?.lazy || img.dataset?.original || '';
        const before = nearestText(img,'previousSibling');
        const after  = nearestText(img,'nextSibling');
        return {
          src: rawSrc,
          alt: (img.getAttribute('alt') || '').trim(),
          nearby: [...before,...after].join(' ')
        };
      });
    });

    /*──────────────────────── 3. Post‑process (cheap JS) ───────────*/
    const errorGroups = {
      'Missing Alt Text':        [],
      'File Name':               [],
      'Matching Nearby Content': [],
      'Manual Check':            []
    };
    const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

    raw.forEach(it => {
      // normalise src
      try { it.src = new URL(it.src, url).toString(); }
      catch { /* keep as‑is */ }

      // ignore tracking pixels
      if (!it.src || it.src.includes('bat.bing.com/action/0')) return;

      const altLower  = it.alt.toLowerCase();
      const fileBase  = (it.src.split('/').pop() || '').split('.')[0];

      if (!it.alt) {
        errorGroups['Missing Alt Text'].push(it); return;
      }
      if (altLower === fileBase.toLowerCase() || extRegex.test(altLower)) {
        errorGroups['File Name'].push(it); return;
      }
      if (altLower && it.nearby.toLowerCase().includes(altLower)) {
        // create small highlighted snippet
        const idx = it.nearby.toLowerCase().indexOf(altLower);
        const slice = it.nearby.slice(Math.max(0, idx-50), idx+altLower.length+50);
        it.matchingSnippet = slice.replace(
          new RegExp(it.alt,'i'), m=>'**'+m+'**');
        errorGroups['Matching Nearby Content'].push(it); return;
      }
      errorGroups['Manual Check'].push(it);
    });

    await browser.close();
    return res.status(200).json({
      totalImages: raw.length,
      errorGroups
    });

  } catch (err) {
    console.error('alt‑checker error:', err.message);
    await browser.close();

    /*── Fallback: try plain HTML fetch + Cheerio so user still
         gets something instead of the generic 500.            */
    try {
      const fetch   = require('node-fetch');
      const htmlRes = await fetch(url,{timeout:7000});
      const html    = await htmlRes.text();
      const $       = cheerio.load(html);
      const imgCnt  = $('img').length;
      return res.status(200).json({
        totalImages: imgCnt,
        errorGroups: {
          'Missing Alt Text': [], 'File Name': [],
          'Matching Nearby Content': [], 'Manual Check': []
        },
        fallback: true
      });
    } catch(e) {
      return res.status(500).json({
        error:'Unable to analyse this URL (site may be blocking headless browsers).'
      });
    }
  }
};
