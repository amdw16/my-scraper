/*************************************************************************
 * Scribely Alt‑Text Checker – v6.2  (robust, ≤ 6 s, GIF + {width}x fix)
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────── Shared helpers ─────────────────────────────────────────────*/
function chooseSrc(get) {
  return (
    get('data-srcset')  || get('data-src') ||
    get('data-lazy')    || get('data-original') ||
    get('src') || ''
  );
}

/* Replace Shopify-size token with a safe default (600 px) */
function normaliseSizeToken(src) {
  return src.replace(/\{width\}x\{height\}/gi, '600x');
}

function buildReport(imgs, pageUrl) {
  const groups = {
    'Missing Alt Text': [], 'File Name': [],
    'Matching Nearby Content': [], 'Manual Check': []
  };
  const ext = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  imgs.forEach(it => {
    try { it.src = new URL(it.src, pageUrl).toString(); } catch {}
    if (!it.src) return;

    const al   = it.alt.toLowerCase();
    const base = (it.src.split('/').pop() || '').split('.')[0];

    if (!it.alt)                                           return groups['Missing Alt Text'].push(it);
    if (al === base.toLowerCase() || ext.test(al))         return groups['File Name'].push(it);
    groups['Manual Check'].push(it);
  });
  return { totalImages: imgs.length, errorGroups: groups };
}

/*──────── Placeholder filter (shared) ───────────────────────────────*/
function filterPlaceholders(list) {
  const freq = Object.create(null);
  list.forEach(it => { if (it.src) freq[it.src] = (freq[it.src] || 0) + 1; });

  return list.filter(it => {
    if (!it.src || it.tooSmall) return false;

    const dups   = freq[it.src] || 0;
    const isGif  = /\.gif(?:$|\?)/i.test(it.src);
    if (dups >= 10 && (!it.alt || isGif)) return false;

    return true;
  });
}

/*──────── Stage 1: fast HTML scrape (≤ 3 s) ─────────────────────────*/
async function scrapeHtml(url) {
  const html = await (await fetch(url, { timeout: 6000 })).text();
  const $ = cheerio.load(html);

  const raw = $('img').map((_, el) => {
    const $el = $(el);
    const w = Number($el.attr('width'))  || 0;
    const h = Number($el.attr('height')) || 0;
    return {
      src: normaliseSizeToken( chooseSrc(attr => $el.attr(attr)) ),
      alt: ($el.attr('alt') || '').trim(),
      tooSmall: w && h && (w * h <= 9)
    };
  }).get();

  const cleaned = filterPlaceholders(raw);

  return {
    report: buildReport(cleaned, url),
    metrics: {
      totalRaw: raw.length,
      discarded: raw.length - cleaned.length,
      htmlSample: html.slice(0, 5000)
    }
  };
}

/*──────── Stage 2: JS‑DOM pass (≤ 3 s, media blocked) ──────────────*/
async function scrapeJsDom(url) {
  const execPath = await chromium.executablePath();
  const browser  = await puppeteer.launch({
    executablePath: execPath,
    headless: chromium.headless,
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36');
    await page.setRequestInterception(true);
    const block = new Set(['image', 'stylesheet', 'font', 'media']);
    page.on('request', r => block.has(r.resourceType()) ? r.abort() : r.continue());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(2000); // let client JS hydrate

    const raw = await page.$$eval('img', els => {
      function pick(el, a) { return el.getAttribute(a) || ''; }
      return els.map(el => {
        const src = pick(el,'data-srcset') || pick(el,'data-src') ||
                    pick(el,'data-lazy')   || pick(el,'data-original') ||
                    pick(el,'src') || '';
        const w = el.width || 0, h = el.height || 0;
        return {
          src,
          alt: (el.getAttribute('alt') || '').trim(),
          tooSmall: w && h && (w * h <= 9)
        };
      });
    });

    await browser.close();
    const fixed = raw.map(it => ({ ...it, src: normaliseSizeToken(it.src) }));
    return buildReport(filterPlaceholders(fixed), url);

  } catch (e) {
    await browser.close();
    throw e;
  }
}

/*──────── HTTP handler ─────────────────────────────────────────────*/
module.exports = async (req, res) => {
  /* CORS */
  const ok = [
    'https://scribely-v2.webflow.io', 'https://scribely.com',
    'https://www.scribely.com', 'https://scribelytribe.com',
    'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', ok.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  /* Input */
  let { url } = req.body || {};
  if (!url)                       return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    /* Stage 1 */
    const { report: first, metrics } = await scrapeHtml(url);

    const placeholderRatio = metrics.discarded / (metrics.totalRaw || 1);
    const hasLazyAttr      = /loading\s*=\s*["']lazy["']|data-src/i.test(metrics.htmlSample);

    const needJs =
      placeholderRatio >= 0.3 || metrics.totalRaw < 15 || hasLazyAttr;

    if (!needJs) {
      return res.status(200).json({ ...first, engine: 'html' });
    }

    /* Stage 2 */
    const second = await scrapeJsDom(url);
    return res.status(200).json({ ...second, engine: 'js-dom' });

  } catch (err) {
    console.error('alt‑checker fatal:', err);
    return res.status(500).json({ error: 'Unable to analyse this URL.' });
  }
};
