/*************************************************************************
 * Scribely Alt‑Text Checker – v6  (robust, 6 s budget, no hard‑coded lists)
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────────────────── Shared helpers ───────────────────*/
function chooseSrc(elAttr) {
  /* attr getter injected so this works in both Cheerio and DOM */
  const get = elAttr;
  return (
    get('data-srcset')  || get('data-src') ||
    get('data-lazy')    || get('data-original') ||
    get('src')          || ''
  );
}

function buildReport(rawImgs, pageUrl) {
  const groups = {
    'Missing Alt Text': [], 'File Name': [],
    'Matching Nearby Content': [], 'Manual Check': []
  };
  const ext = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  rawImgs.forEach(it => {
    try { it.src = new URL(it.src, pageUrl).toString(); } catch {}
    if (!it.src) return;

    const al = it.alt.toLowerCase();
    const base = (it.src.split('/').pop() || '').split('.')[0];

    if (!it.alt)                                           return groups['Missing Alt Text'].push(it);
    if (al === base.toLowerCase() || ext.test(al))         return groups['File Name'].push(it);
    groups['Manual Check'].push(it);
  });

  return { totalImages: rawImgs.length, errorGroups: groups };
}

/*──────────────────── Stage 1: HTML scrape (≤ 3 s) ─────*/
async function scrapeHtml(url) {
  const html = await (await fetch(url, { timeout: 6000 })).text();
  const $ = cheerio.load(html);

  const freq = Object.create(null);
  const imgs = $('img').map((_, el) => {
    const $el = $(el);
    const src = chooseSrc(attr => $el.attr(attr));
    if (src) freq[src] = (freq[src] || 0) + 1;

    const w = Number($el.attr('width'))  || 0;
    const h = Number($el.attr('height')) || 0;
    const tooSmall = w && h && (w * h <= 9);   // ≤ 3 × 3 px

    return { src, alt: ($el.attr('alt') || '').trim(), tooSmall };
  }).get();

  /* filter placeholders */
  const cleaned = imgs.filter(it =>
    it.src &&
    !it.tooSmall &&
    !(freq[it.src] >= 10 && !it.alt)      // high‑dup dup & no alt → skip
  );

  return {
    report: buildReport(cleaned, url),
    metrics: {
      totalRaw: imgs.length,
      discarded: imgs.length - cleaned.length,
      htmlSample: html.slice(0, 5000)
    }
  };
}

/*──────────────────── Stage 2: JS‑DOM pass (≤ 3 s) ─────*/
async function scrapeJsDom(url) {
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args: [...chromium.args, '--no-sandbox','--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36');
    await page.setRequestInterception(true);
    const block = new Set(['image','stylesheet','font','media']);
    page.on('request', r => block.has(r.resourceType()) ? r.abort() : r.continue());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(2000);       // let JS hydrate alts / data-src

    const raw = await page.$$eval('img', els => {
      const freq = Object.create(null);
      /* first pass: collect & count */
      const tmp = els.map(el => {
        const pick = (a) => el.getAttribute(a) || '';
        const src  = (pick('data-srcset') || pick('data-src') ||
                      pick('data-lazy')   || pick('data-original') ||
                      pick('src')         || '');
        if (src) freq[src] = (freq[src] || 0) + 1;
        const w = el.width || 0, h = el.height || 0;
        return { src, alt: (el.getAttribute('alt') || '').trim(), tooSmall: w && h && (w*h<=9) };
      });
      /* second pass: filter */
      return tmp.filter(it =>
        it.src &&
        !it.tooSmall &&
        !(freq[it.src] >= 10 && !it.alt)
      );
    });

    await browser.close();
    return buildReport(raw, url);

  } catch (e) {
    await browser.close();
    throw e;
  }
}

/*──────────────────── HTTP handler ─────────────────────*/
module.exports = async (req, res) => {
  /* CORS */
  const okOrigins = [
    'https://scribely-v2.webflow.io', 'https://scribely.com',
    'https://www.scribely.com', 'https://scribelytribe.com',
    'https://www.scribelytribe.com'
  ];
  const o = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', okOrigins.includes(o) ? o : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  /* input */
  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    /* Stage 1 */
    const { report: first, metrics } = await scrapeHtml(url);

    const placeholderRatio = metrics.discarded / (metrics.totalRaw || 1);
    const hasLazyAttr      = /loading\s*=\s*["']lazy["']|data-src/i.test(metrics.htmlSample);

    const needJsPass =
      placeholderRatio >= 0.3 || metrics.totalRaw < 15 || hasLazyAttr;

    if (!needJsPass) {
      return res.status(200).json({ ...first, engine:'html' });
    }

    /* Stage 2 */
    const second = await scrapeJsDom(url);
    return res.status(200).json({ ...second, engine:'js-dom' });

  } catch (err) {
    console.error('alt‑checker fatal:', err);
    return res.status(500).json({ error: 'Unable to analyse this URL.' });
  }
};
