/*************************************************************************
 *  Scribely Alt-Text Checker – v12
 *  ------------------------------------------------------------
 *  • “Deep scan” option removed (duplicate-text detection is always on)
 *  • Supports Nike-style attributes (data-landscape-url / data-portrait-url)
 *  • Front-end displays thumbnails with referrerPolicy="no-referrer"
 *************************************************************************/

const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*──────────────────────── helper utilities ────────────────────────*/
const chooseSrc = g => {
  const raw = g('data-srcset')       || g('srcset') ||
              g('data-src')          || g('data-lazy') ||
              g('data-original')     || g('data-landscape-url') ||
              g('data-portrait-url') || g('src') || '';
  return raw.split(',')[0].trim().split(' ')[0];
};
const bgUrl = s => (s || '').match(/url\(["']?(.*?)["']?\)/i)?.[1] || '';
const norm  = s => s.replace(/\{width\}x\{height\}/gi, '600x');
const tiny  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

/* ±N words before+after a node */
function wordsAround($, $el, limit) {
  const grab = dir => {
    const out = [];
    let cur   = $el[dir]();
    while (cur.length && out.length < limit) {
      const txt = cur[0].type === 'text'
        ? cur[0].data
        : (cur[0].type === 'tag' ? cur.text() : '');
      if (txt && txt.trim()) out.push(...txt.trim().split(/\s+/));
      cur = cur[dir]();
    }
    return out;
  };
  const before = grab('prev');
  const after  = grab('next');
  return [...before.slice(-limit), ...after.slice(0, limit)].join(' ').toLowerCase();
}

/* bucket images into result groups */
function bucket(raw, url) {
  const groups = {
    'Missing Alt Text': [],
    'File Name'       : [],
    'Matching Nearby Content': [],
    'Manual Check'    : []
  };
  const extRE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  raw.forEach(img => {
    if (!img.src) return;
    try { img.src = new URL(img.src, url).toString(); } catch {}

    const altLower = img.alt.toLowerCase();
    const baseName = (img.src.split('/').pop() || '').split('.')[0];

    const clean = { src: img.src, alt: img.alt };
    if (img.matchingSnippet) clean.matchingSnippet = img.matchingSnippet;

    if (!img.alt)                                    groups['Missing Alt Text'].push(clean);
    else if (img.dup)                                groups['Matching Nearby Content'].push(clean);
    else if (altLower === baseName || extRE.test(altLower))
                                                    groups['File Name'].push(clean);
    else                                             groups['Manual Check'].push(clean);
  });

  return { totalImages: raw.length, errorGroups: groups };
}

/* deduplicate & quality filter */
function filter(list) {
  const freq = Object.create(null);
  list.forEach(i => { if (i.src) freq[i.src] = (freq[i.src] || 0) + 1; });

  return list.filter(i => {
    if (!i.src || i.tooSmall || tiny(i.src)) return false;
    const d   = freq[i.src] || 0;
    const gif = /\.gif/i.test(i.src);
    const svg = /\.svg/i.test(i.src);
    if (d >= 10 && (!i.alt || gif)) return false;
    if (d >= 5  && !i.alt && svg)  return false;
    return true;
  });
}

/*────────────────────── HTML quick pass ──────────────────────*/
async function scrapeHTML(url, limit) {
  const resp = await fetch(url, { timeout: 6000 });
  if (!resp.ok) throw new Error('typo');

  const $   = cheerio.load(await resp.text());
  const raw = [];

  $('img,source,[style*="background-image"]').each((_, el) => {
    const $e = $(el);
    const tag = el.tagName.toLowerCase();

    let src = '', alt = '', too = false;
    if (tag === 'img') {
      src = chooseSrc(attr => $e.attr(attr));
      alt = $e.attr('alt') || '';
      const w = +$e.attr('width')  || 0;
      const h = +$e.attr('height') || 0;
      too = w && h && (w * h <= 9);
    } else if (tag === 'source') {
      src = chooseSrc(attr => $e.attr(attr));
      alt = $e.parent('picture').find('img').attr('alt') || '';
    } else {
      src = bgUrl($e.attr('style'));
    }
    raw.push({ src: norm(src), alt: alt.trim(), tooSmall: too, $el: $e });
  });

  const clean = filter(raw);
  clean.forEach(i => {
    if (i.alt && wordsAround($, i.$el, limit).includes(i.alt.toLowerCase()))
      i.dup = true;
  });

  return {
    report : bucket(clean, url),
    metrics: { raw: raw.length, kept: clean.length }
  };
}

/*──────────────────── JS-DOM pass (with scrolling) ───────────────────*/
async function scrapeDOM(url, limit) {
  const exe = await chromium.executablePath();

  async function run({ jsOn, timeout, ua }) {
    const browser = await puppeteer.launch({
      executablePath: exe,
      headless: chromium.headless,
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(jsOn);
      await page.setUserAgent(ua);
      await page.setRequestInterception(true);
      const block = new Set(['image','stylesheet','font','media']);
      page.on('request', r => block.has(r.resourceType()) ? r.abort() : r.continue());

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

      /* trigger infinite-scroll / lazy images */
      if (jsOn) {
        let prev = 0;
        for (let i = 0; i < 12; i++) {
          const len = await page.$$eval(
            'img,source,[style*="background-image"]', els => els.length
          );
          if (len - prev < 5) break;
          prev = len;
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }

      const raw = await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els, lim) => els.map(el => {
          const tag = el.tagName.toLowerCase();
          const g   = a => el.getAttribute(a) || '';

          let src = '', alt = '', too = false, dup = false;
          if (tag === 'img') {
            src = g('data-srcset') || g('srcset') ||
                  g('data-src')    || g('data-lazy') ||
                  g('data-original') || g('data-landscape-url') ||
                  g('data-portrait-url') || g('src') || '';
            alt = g('alt');
            too = el.width && el.height && (el.width * el.height <= 9);
          } else if (tag === 'source') {
            src = g('data-srcset') || g('srcset') ||
                  g('data-landscape-url') || g('data-portrait-url') || '';
            alt = el.parentElement.querySelector('img')?.alt || '';
          } else {
            const m = /url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage || '');
            src = m ? m[1] : '';
          }

          /* duplicate-text detection */
          if (alt) {
            const grab = dir => {
              const w = []; let n = el[dir];
              while (n && w.length < lim) {
                if (n.nodeType === 3 && n.textContent.trim())
                  w.push(...n.textContent.trim().split(/\s+/));
                else if (n.nodeType === 1) {
                  const t = n.textContent.trim();
                  if (t) w.push(...t.split(/\s+/));
                }
                n = n[dir];
              }
              return w;
            };
            const around = [...grab('previousSibling').slice(-lim),
                            ...grab('nextSibling').slice(0, lim)]
                           .join(' ').toLowerCase();
            dup = around.includes(alt.toLowerCase());
          }

          return { src, alt: alt.trim(), tooSmall: too, dup };
        }), limit
      );

      await browser.close();
      return bucket(filter(raw).map(i => ({ ...i, src: norm(i.src) })), url);
    } catch (e) {
      await browser.close();
      throw e;
    }
  }

  const UA_PC = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36';
  const UA_MB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  try {
    return await run({ jsOn: true,  timeout: 7000,  ua: UA_PC });
  } catch (e) {
    if (!/Timeout/i.test(e.message)) throw e;          // different error → propagate
    return await run({ jsOn: false, timeout: 10000, ua: UA_MB });
  }
}

/*───────────────────────── HTTP handler ─────────────────────────*/
module.exports = async (req, res) => {
  const ok = [
    'https://scribely-v2.webflow.io',
    'https://scribely.com',          'https://www.scribely.com',
    'https://scribelytribe.com',     'https://www.scribelytribe.com'
  ];
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', ok.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  let { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;   // ← fixed regex

  const WORD_WINDOW = 50;

  try {
    /* 1️⃣ plain-HTML pass */
    const { report: first, metrics } = await scrapeHTML(url, WORD_WINDOW);

    /* decide if DOM pass is worthwhile */
    const placeholderRatio = 1 - (metrics.kept / (metrics.raw || 1));
    const needDom = placeholderRatio >= 0.8 || first.totalImages < 20;

    if (!needDom) {
      return res.status(200).json({ ...first, engine: 'html' });
    }

    /* 2️⃣ JS-enabled / fallback pass */
    const domReport = await scrapeDOM(url, WORD_WINDOW);
    if (domReport.totalImages < 20) {
      return res.status(200).json({
        ...first,
        engine : 'html',
        blocked: true,
        note   : 'Site blocks headless browsers; only server-rendered images analysed.'
      });
    }
    return res.status(200).json({ ...domReport, engine: 'js-dom' });

  } catch (err) {
    if (err.message === 'typo')
      return res.status(400).json({ error: 'typo' });

    if (err.message.includes('blocked'))
      return res.status(403).json({ error: 'blocked' });

    console.error('fatal:', err);
    return res.status(500).json({ error: 'internal' });
  }
};
