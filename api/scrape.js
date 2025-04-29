/*************************************************************************
 * Scribely Alt-Text Checker — v20 (2025-04-29)
 *
 *  • “Blocked” = 0 images (no more <20 rule)
 *  • “Matching Nearby Content” now checks the **300-character window
 *    before + after** every image/ source/ BG-image
 *  • The first Puppeteer pass no longer blocks <img> requests
 *************************************************************************/
const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/* ────────── tiny helpers ────────── */
const chooseSrc = g => (
  (g('data-srcset')||g('srcset')||g('data-src')||g('data-lazy')||
   g('data-original')||g('data-landscape-url')||g('data-portrait-url')||
   g('src')||'').trim().split(/\s+/)[0]);

const bgUrl = s => (s||'').match(/url\(["']?(.*?)["']?\)/i)?.[1] || '';
const norm  = s => s.replace(/\{width\}x\{height\}/gi,'600x');
const tiny  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

const charAround = ($, $el, max) => {
  const collect = (node, dir) => {
    let txt = '', cur = $(node)[dir]();
    while (cur.length && txt.length < max) {
      const t = cur.text();
      if (t) txt = dir === 'prev' ? `${t}${txt}` : `${txt}${t}`;
      cur = cur[dir]();
    }
    return txt.slice(0, max);
  };
  return (collect($el, 'prev') + collect($el, 'next')).toLowerCase();
};

const filterImages = list => {
  const freq = Object.create(null);
  list.forEach(i => { if (i.src) freq[i.src] = (freq[i.src] || 0) + 1; });

  return list.filter(i => {
    if (!i.src || i.tooSmall || tiny(i.src)) return false;
    const cnt = freq[i.src] || 0;
    const gif = /\.gif/i.test(i.src);
    const svg = /\.svg/i.test(i.src);

    if (cnt >= 10 && (!i.alt || gif)) return false;
    if (cnt >= 5  && !i.alt && svg)   return false;
    return true;
  });
};

/* group → report object */
const bucket = (raw, url) => {
  const g = {
    'Missing Alt Text'       : [],
    'File Name'              : [],
    'Matching Nearby Content': [],
    'Manual Check'           : []
  };
  const ext = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  raw.forEach(img => {
    if (!img.src) return;
    try { img.src = new URL(img.src, url).toString(); } catch {}

    const low  = img.alt.toLowerCase();
    const base = (img.src.split('/').pop() || '').split('.')[0];
    const rec  = { src: img.src, alt: img.alt };
    if (img.matchingSnippet) rec.matchingSnippet = img.matchingSnippet;

    if (!img.alt)                      g['Missing Alt Text'].push(rec);
    else if (img.dup)                  g['Matching Nearby Content'].push(rec);
    else if (low === base || ext.test(low))
                                       g['File Name'].push(rec);
    else                               g['Manual Check'].push(rec);
  });

  return { totalImages: raw.length, errorGroups: g };
};

/* ────────── HTML quick probe (≈12 s) ────────── */
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function scrapeHTML(url) {
  const resp = await fetch(url, {
    timeout: 12000,
    headers: {
      'User-Agent'      : UA_PC,
      'Accept-Language' : 'en-US,en;q=0.9'
    }
  }).catch(() => { throw new Error('blocked'); });

  if (resp.status >= 400 && resp.status < 500) {
    const body = await resp.text().catch(() => '');
    const blocked = resp.status === 401 || resp.status === 403 ||
                    resp.status === 429 ||
                    /access\s+denied|captcha|cloudflare|akamai/i.test(body);
    throw new Error(blocked ? 'blocked' : 'typo');
  }
  if (!resp.ok) throw new Error('internal');

  const $   = cheerio.load(await resp.text());
  const raw = [];

  $('img,source,[style*="background-image"]').each((_, el) => {
    const $e  = $(el);
    const tag = el.tagName.toLowerCase();
    let src = '', alt = '', too = false;

    if (tag === 'img') {
      src = chooseSrc(a => $e.attr(a));
      alt = $e.attr('alt') || '';
      const w = +$e.attr('width')  || 0;
      const h = +$e.attr('height') || 0;
      too = w && h && (w * h <= 9);
    } else if (tag === 'source') {
      src = chooseSrc(a => $e.attr(a));
      alt = $e.parent('picture').find('img').attr('alt') || '';
    } else {
      src = bgUrl($e.attr('style'));
    }

    raw.push({
      src : norm(src),
      alt : alt.trim(),
      tooSmall: too,
      $el : $e
    });
  });

  const clean = filterImages(raw);
  const strip = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '');

  clean.forEach(i => {
    if (i.alt) {
      const around = charAround($, i.$el, 300);
      i.dup  = strip(around).includes(strip(i.alt));
      if (i.dup) i.matchingSnippet = around.slice(0, 300);
    }
  });

  return bucket(clean, url);
}

/* ────────── JS-DOM fallback (≈20 s) ────────── */
async function scrapeDOM(url) {
  const exe = await chromium.executablePath();

  /* inner runner (one pass, configurable) */
  async function run({ jsOn, timeout, ua }) {
    const browser = await puppeteer.launch({
      executablePath: exe,
      headless      : chromium.headless,
      args          : [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(jsOn);
      await page.setUserAgent(ua);

      /* keep images allowed on **both** passes now */
      await page.setRequestInterception(true);
      const blocked = new Set(['stylesheet', 'font', 'media']);
      page.on('request', r =>
        blocked.has(r.resourceType()) ? r.abort() : r.continue());

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      /* simple lazy-load scroll when JS is on */
      if (jsOn) {
        let prev = 0;
        for (let i = 0; i < 12; i++) {
          const len = await page.$$eval(
            'img,source,[style*="background-image"]', els => els.length);
          if (len - prev < 5) break;
          prev = len;
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(800);
      }

      const raw = await page.$$eval(
        ['img', 'source', '[style*="background-image"]'].join(','),
        (els) => {
          const norm  = s => s.replace(/\{width\}x\{height\}/gi, '600x');
          const token = s => s.trim().split(/\s+/)[0];
          const strip = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '');

          const grabTxt = (n, dir, max) => {
            let txt = '', cur = n[dir];
            while (cur && txt.length < max) {
              if (cur.nodeType === 3 && cur.textContent.trim())
                txt = dir === 'previousSibling'
                    ? `${cur.textContent}${txt}`
                    : `${txt}${cur.textContent}`;
              else if (cur.nodeType === 1 && cur.textContent.trim())
                txt = dir === 'previousSibling'
                    ? `${cur.textContent}${txt}`
                    : `${txt}${cur.textContent}`;
              cur = cur[dir];
            }
            return txt.slice(0, max);
          };

          return els.map(el => {
            const tag = el.tagName.toLowerCase();
            const g   = a => el.getAttribute(a) || '';
            let src = '', alt = '', too = false, dup = false, snippet = '';

            if (tag === 'img') {
              src = g('data-srcset') || g('srcset') || g('data-src') ||
                    g('data-lazy')   || g('data-original') ||
                    g('data-landscape-url') || g('data-portrait-url') ||
                    g('src') || '';
              alt = g('alt');
              too = el.width && el.height && (el.width * el.height <= 9);
            } else if (tag === 'source') {
              src = g('data-srcset') || g('srcset') ||
                    g('data-landscape-url') || g('data-portrait-url') || '';
              alt = el.parentElement.querySelector('img')?.alt || '';
            } else {  // background
              const m = /url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage || '');
              src = m ? m[1] : '';
            }

            if (alt) {
              const around = (grabTxt(el, 'previousSibling', 300) +
                              grabTxt(el, 'nextSibling',     300)).toLowerCase();
              dup = strip(around).includes(strip(alt));
              if (dup) snippet = around.slice(0, 300);
            }

            return {
              src : norm(token(src)),
              alt : alt.trim(),
              tooSmall: too,
              dup,
              matchingSnippet: snippet
            };
          });
        }
      );

      await browser.close();
      return bucket(filterImages(raw), url);

    } catch (e) {
      await browser.close();
      throw e;
    }
  }

  /* try JS-off (mobile UA) first — often succeeds with Nike, eBay, etc. */
  const UA_MB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
                'Mobile/15E148 Safari/604.1';
  try {
    return await run({ jsOn: false, timeout: 20000, ua: UA_MB });
  } catch (e) {
    if (!/Timeout|blocked/i.test(e.message)) throw e;
    /* second (and last) pass: full JS, desktop UA */
    return await run({ jsOn: true, timeout: 20000, ua: UA_PC });
  }
}

/* ────────── Vercel/Netlify handler ────────── */
module.exports = async (req, res) => {
  /* CORS for authorised front-ends */
  const ok = [
    'https://scribely-v2.webflow.io',
    'https://scribely.com', 'https://www.scribely.com',
    'https://scribelytribe.com', 'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', ok.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;

  try {
    /* 1️⃣  Quick HTML */
    let report;
    try {
      report = await scrapeHTML(url);
      if (report.totalImages > 0) return res.status(200).json({ ...report, engine: 'html' });
      throw new Error('blocked');              // 0 images ⇒ try DOM
    } catch (e) {
      if (e.message !== 'blocked') throw e;    // typo / internal
      /* 2️⃣  Puppeteer fallback */
      report = await scrapeDOM(url);
      if (report.totalImages > 0) return res.status(200).json({ ...report, engine: 'js-dom' });
      throw new Error('blocked');
    }

  } catch (err) {
    if (/timeout/i.test(err.message)) err.message = 'blocked';

    if (err.message === 'typo')    return res.status(400).json({ error: 'typo'    });
    if (err.message === 'blocked') return res.status(403).json({ error: 'blocked' });

    console.error('fatal:', err);
    return res.status(500).json({ error: 'internal' });
  }
};
