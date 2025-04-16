/*************************************************************************
 * Scribely Alt‑Text Checker – v5 (HTML → light‑JS → full fallback)
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────── Shared rule engine ─────────────────────────────*/
function buildReport(imgs, pageUrl) {
  /* … identical to v4 … */
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

    if (!it.alt) return groups['Missing Alt Text'].push(it);
    if (al === base.toLowerCase() || ext.test(al))
      return groups['File Name'].push(it);
    groups['Manual Check'].push(it);
  });
  return { totalImages: imgs.length, errorGroups: groups };
}

/*──────── Stage 1: raw HTML (1‑3 s) ─────────────────────*/
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

/*──────── Stage 2: JS‑enabled DOM, heavy bytes blocked (≤ 6 s) ─────*/
async function scrapeJsDom(url) {
  const start = Date.now();
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    // let JS run briefly but stay under 6 s total
    while (Date.now() - start < 5500) {
      if (page._networkManager._networkIdleTimer) break;  // idle
      await new Promise(r => setTimeout(r, 100));
    }
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

/*──────── HTTP handler ───────────────────────────────────*/
module.exports = async (req, res) => {
  /* CORS + method (same as before)… */
  /* … (snipped for brevity) … */

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const first = await scrapeHtml(url);

    const emptyRatio =
      (first.errorGroups['Missing Alt Text'].length || 0) / (first.totalImages || 1);

    // If few images or mostly missing alts → run JS‑DOM pass
    if (first.totalImages < 20 || emptyRatio > 0.7) {
      const second = await scrapeJsDom(url);
      if (second.totalImages >= 5)        // success with JS
        return res.status(200).json({ ...second, engine:'js-dom' });
    }

    return res.status(200).json({ ...first, engine:'html' });

  } catch (err) {
    console.error('alt‑checker fatal:', err.message);
    return res.status(500).json({ error: 'Unable to analyse this URL.' });
  }
};
