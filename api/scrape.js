/*************************************************************************
 * Scribely Alt‑Text Checker – v5‑fix (HTML → light‑JS)
 *  - Handles OPTIONS correctly
 *  - ≤ 6 s for JS‑heavy sites, ≤ 3 s for plain HTML sites
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────────────── Shared rule engine ───────────────*/
function buildReport(imgs, pageUrl) {
  const groups = {
    'Missing Alt Text': [], 'File Name': [],
    'Matching Nearby Content': [], 'Manual Check': []
  };
  const ext = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  imgs.forEach(it => {
    try { it.src = new URL(it.src, pageUrl).toString(); } catch {}
    if (!it.src) return;

    const al = it.alt.toLowerCase();
    const base = (it.src.split('/').pop() || '').split('.')[0];

    if (!it.alt)                                           return groups['Missing Alt Text'].push(it);
    if (al === base.toLowerCase() || ext.test(al))         return groups['File Name'].push(it);
    groups['Manual Check'].push(it);
  });

  return { totalImages: imgs.length, errorGroups: groups };
}

/*──────────────── Stage 1: raw‑HTML scrape (1‑3 s) ───*/
async function scrapeHtml(url) {
  const html = await (await fetch(url, { timeout: 6000 })).text();
  const $ = cheerio.load(html);
  const imgs = $('img').map((_, el) => {
    const $e = $(el);
    return {
      src: $e.attr('src') ||
           $e.attr('data-src') || $e.attr('data-lazy') || $e.attr('data-original') || '',
      alt: ($e.attr('alt') || '').trim(),
      nearby: ''
    };
  }).get();
  return buildReport(imgs, url);
}

/*──────────────── Stage 2: JS‑DOM, blocking heavy bytes (≤ 6 s) ──*/
async function scrapeJsDom(url) {
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args: [...chromium.args, '--no-sandbox','--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36');
    await page.setRequestInterception(true);
    const block = new Set(['image','stylesheet','font','media']);
    page.on('request', r => block.has(r.resourceType()) ? r.abort() : r.continue());

    // 8 s hard nav timeout
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });

    // Give client JS a moment (≤ 2 s) to hydrate <img> attrs
    await new Promise(r => setTimeout(r, 2000));

    const imgs = await page.$$eval('img', els => els.map(img => ({
      src: img.currentSrc || img.src ||
           img.dataset?.src || img.dataset?.lazy || img.dataset?.original || '',
      alt: (img.getAttribute('alt') || '').trim(),
      nearby: ''
    })));

    await browser.close();
    return buildReport(imgs, url);

  } catch (e) {
    await browser.close();
    throw e;
  }
}

/*──────────────── HTTP handler ───────────────────────*/
module.exports = async (req, res) => {
  /* CORS */
  const okOrigins = [
    'https://scribely-v2.webflow.io',
    'https://scribely.com',        'https://www.scribely.com',
    'https://scribelytribe.com',   'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin',
                okOrigins.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  /* Pre‑flight must exit early */
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });

  /* Input */
  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    /* 1 — fast pass */
    const first = await scrapeHtml(url);

    const emptyRatio =
      (first.errorGroups['Missing Alt Text'].length || 0) /
      (first.totalImages || 1);

    /* 2 — JS‑DOM only if needed */
    if (first.totalImages < 20 || emptyRatio > 0.7) {
      const second = await scrapeJsDom(url);
      if (second.totalImages >= 5)
        return res.status(200).json({ ...second, engine:'js-dom' });
    }

    /* Good enough */
    return res.status(200).json({ ...first, engine:'html' });

  } catch (err) {
    console.error('alt‑checker fatal:', err);
    return res.status(500).json({ error: 'Unable to analyse this URL.' });
  }
};
