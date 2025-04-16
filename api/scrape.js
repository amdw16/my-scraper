/*************************************************************************
 * Scribely Alt‑Text Checker – v4  (two‑stage: fast HTML → light Chrome)
 * – Primary path: node‑fetch + Cheerio (no browser) … 1‑3 s
 * – Fallback : headless Chrome with JS disabled & all requests aborted
 *              … +4‑5 s, still <30 s total, <128 MB RAM
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────── Rule engine (shared) ─────────────────────────────*/
function buildReport(imgs, pageUrl) {
  const groups = {
    'Missing Alt Text':        [],
    'File Name':               [],
    'Matching Nearby Content': [],
    'Manual Check':            []
  };
  const extRE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  imgs.forEach(it => {
    try { it.src = new URL(it.src, pageUrl).toString(); } catch {}
    if (!it.src || it.src.includes('bat.bing.com/action/0')) return;

    const altLower = it.alt.toLowerCase();
    const baseName = (it.src.split('/').pop() || '').split('.')[0];

    if (!it.alt)                                        return groups['Missing Alt Text'].push(it);
    if (altLower === baseName.toLowerCase() || extRE.test(altLower))
                                                       return groups['File Name'].push(it);
    if (altLower && it.nearby.toLowerCase().includes(altLower)) {
      const i = it.nearby.toLowerCase().indexOf(altLower);
      it.matchingSnippet = it.nearby
        .slice(Math.max(0, i-50), i+altLower.length+50)
        .replace(new RegExp(it.alt,'i'), m=>'**'+m+'**');
      return groups['Matching Nearby Content'].push(it);
    }
    groups['Manual Check'].push(it);
  });

  return { totalImages: imgs.length, errorGroups: groups };
}

/*──────── Primary: fast HTML scrape (≤3 s) ────────────────*/
async function fastHtmlPass(url) {
  const html = await (await fetch(url, { timeout: 6000, headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ScribelyBot/1.0; +https://scribely.com)',
    'Accept-Language': 'en-US,en;q=0.9'
  }})).text();

  const $ = cheerio.load(html);
  const imgs = $('img').map((_, el) => {
    const $el = $(el);
    const src = $el.attr('src')
            || $el.attr('data-src') || $el.attr('data-lazy') || $el.attr('data-original') || '';
    const alt = ($el.attr('alt') || '').trim();
    return { src, alt, nearby: '' };   // no nearby text in fast path
  }).get();

  return buildReport(imgs, url);
}

/*──────── Fallback: light Chrome (JS disabled, 4‑5 s) ─────*/
async function lightChromePass(url) {
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
    await page.setJavaScriptEnabled(false);         // ← saves huge time/ram
    await page.setRequestInterception(true);
    page.on('request', r => r.abort());             // abort everything, need HTML only
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const html = await page.content();
    const $ = cheerio.load(html);
    const imgs = $('img').map((_, el) => {
      const $el = $(el);
      const src = $el.attr('src')
              || $el.attr('data-src') || $el.attr('data-lazy') || $el.attr('data-original') || '';
      const alt = ($el.attr('alt') || '').trim();
      return { src, alt, nearby: '' };
    }).get();
    await browser.close();
    return buildReport(imgs, url);

  } catch (e) {
    await browser.close();
    throw e;
  }
}

/*──────── HTTP handler ───────────────────────────────────*/
module.exports = async (req, res) => {
  /* CORS + method */
  const okOrigins = [
    'https://scribely-v2.webflow.io',  'https://scribely.com',
    'https://www.scribely.com',        'https://scribelytribe.com',
    'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin',
                okOrigins.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    /* 1. Fast pass */
    const quick = await fastHtmlPass(url);

    /* If we already found plenty of images, ship it */
    if (quick.totalImages >= 20) {
      return res.status(200).json({ ...quick, engine: 'fast-html' });
    }

    /* 2. Fallback to light Chrome */
    const deep = await lightChromePass(url);
    return res.status(200).json({ ...deep, engine: 'light-chrome' });

  } catch (err) {
    console.error('alt‑checker fatal:', err.message);
    return res.status(500).json({ error: 'Unable to analyse this URL.' });
  }
};
