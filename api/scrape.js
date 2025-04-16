/*************************************************************************
 *  Scribely Alt‑Text Checker – v3 (2025‑04‑16)
 *  * Fast – never downloads image bytes
 *  * 100 % free ‑ fits Vercel’s 30 s / 1 GB limits
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');

/*───────── Tunables ─────────────────────────────────────────*/
const NAV_TIMEOUT_MS  = 10000;   // page.goto cap
const SCROLL_STEPS    = 5;       // viewport scrolls to trigger lazy‑load JS
const IDLE_WAIT_MS    = 800;     // network‑idle quiet window
const OVERALL_CAP_MS  = 18000;   // absolut max inside Puppeteer
const sleep = ms => new Promise(r => setTimeout(r, ms));

/*───────── Handler ─────────────────────────────────────────*/
module.exports = async (req, res) => {
  /* 0. CORS & input ------------------------------------------------*/
  const okOrigins = [
    'https://scribely-v2.webflow.io',
    'https://scribely.com',       'https://www.scribely.com',
    'https://scribelytribe.com',  'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin',
                okOrigins.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();   // ← log #1
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  /* 1. Launch headless Chrome -------------------------------------*/
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args: [
      ...chromium.args,
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/123.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    /* 1‑a. Abort every heavyweight asset (including **images**)  ----*/
    await page.setRequestInterception(true);
    const abort = new Set(['stylesheet','font','media','image','other']);
    page.on('request', r => abort.has(r.resourceType()) ? r.abort() : r.continue());

    /* 1‑b. Navigate (DOM only, 10 s cap) ---------------------------*/
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    /* 1‑c. Nudge any IntersectionObserver lazy‑load JS ------------*/
    for (let i = 0; i < SCROLL_STEPS; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await sleep(120);
    }
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: IDLE_WAIT_MS }),
      sleep(OVERALL_CAP_MS - NAV_TIMEOUT_MS)
    ]);

    /* 2. Harvest <img> data in‑page (zero downloads) --------------*/
    const raw = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      function neighborWords(node, dir) {
        let cur = node[dir], words = [];
        while (cur && words.length < 300) {
          if (cur.nodeType === 3 && cur.textContent.trim()) {
            words.push(...cur.textContent.trim().split(/\s+/));
          } else if (cur.nodeType === 1) {
            const t = cur.textContent.trim(); if (t) words.push(...t.split(/\s+/));
          }
          cur = cur[dir];
        }
        return words;
      }
      return imgs.map(img => {
        const src = img.currentSrc || img.src ||
                    img.dataset?.src || img.dataset?.lazy || img.dataset?.original || '';
        const before = neighborWords(img,'previousSibling');
        const after  = neighborWords(img,'nextSibling');
        return {
          src,
          alt: (img.getAttribute('alt') || '').trim(),
          nearby: [...before,...after].join(' ')
        };
      });
    });

    /* 3. Rule engine ----------------------------------------------*/
    const errorGroups = {
      'Missing Alt Text':        [],
      'File Name':               [],
      'Matching Nearby Content': [],
      'Manual Check':            []
    };
    const extRE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

    raw.forEach(it => {
      try { it.src = new URL(it.src, url).toString(); } catch {}
      if (!it.src || it.src.includes('bat.bing.com/action/0')) return;

      const altLower = it.alt.toLowerCase();
      const baseName = (it.src.split('/').pop() || '').split('.')[0];

      if (!it.alt)                                 return errorGroups['Missing Alt Text'].push(it);
      if (altLower === baseName.toLowerCase() ||
          extRE.test(altLower))                    return errorGroups['File Name'].push(it);
      if (altLower && it.nearby.toLowerCase().includes(altLower)) {
        const i = it.nearby.toLowerCase().indexOf(altLower);
        it.matchingSnippet = it.nearby
          .slice(Math.max(0, i-50), i+altLower.length+50)
          .replace(new RegExp(it.alt,'i'), m=>'**'+m+'**');
        return errorGroups['Matching Nearby Content'].push(it);
      }
      errorGroups['Manual Check'].push(it);
    });

    await browser.close();
    return res.status(200).json({             // ← log #2
      totalImages: raw.length,
      errorGroups
    });

  } catch (err) {
    console.error('alt‑checker fail:', err.message);
    await browser.close();

    /* 4. Fallback to plain HTML (no JS) so user still gets *something* */
    try {
      const fetch = require('node-fetch');
      const html  = await (await fetch(url,{ timeout: 7000 })).text();
      return res.status(200).json({
        totalImages: cheerio.load(html)('img').length,
        errorGroups: {
          'Missing Alt Text': [], 'File Name': [],
          'Matching Nearby Content': [], 'Manual Check': []
        },
        fallback: true
      });
    } catch {
      return res.status(500).json({ error: 'Site blocks headless browsers.' });
    }
  }
};
