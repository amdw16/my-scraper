/*************************************************************************
 * Scribely Alt-Text Checker – v15
 * ------------------------------------------------------------
 *  • HTML fetch sends Chrome UA + Accept-Language (fixes eBay 400/403)
 *  • 403/401/429 ⇒ “blocked”, other 4xx ⇒ “typo”
 *  • If HTML pass fails, automatically try DOM pass before erroring out
 *  • chooseSrc() keeps commas inside Nike-style URLs
 *************************************************************************/

const chromium  = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio   = require('cheerio');
const fetch     = require('node-fetch');

/*───────────────── helper utilities ─────────────────*/
const chooseSrc = g => {
  /* first whitespace-separated token, *do not* split on commas */
  const raw = g('data-srcset')       || g('srcset') ||
              g('data-src')          || g('data-lazy') ||
              g('data-original')     || g('data-landscape-url') ||
              g('data-portrait-url') || g('src') || '';
  return raw.trim().split(/\s+/)[0];
};
const bgUrl = s => (s || '').match(/url\(["']?(.*?)["']?\)/i)?.[1] || '';
const norm  = s => s.replace(/\{width\}x\{height\}/gi, '600x');
const tiny  = u => /^data:image\/gif;base64,/i.test(u) && u.length < 200;

/* grab ±N words around a node */
function wordsAround($, $el, N) {
  const grab = dir => {
    const out = []; let cur = $el[dir]();
    while (cur.length && out.length < N) {
      const txt = cur[0].type === 'text'
        ? cur[0].data
        : (cur[0].type === 'tag' ? cur.text() : '');
      if (txt && txt.trim()) out.push(...txt.trim().split(/\s+/));
      cur = cur[dir]();
    }
    return out;
  };
  return [...grab('prev').slice(-N), ...grab('next').slice(0, N)]
           .join(' ').toLowerCase();
}

/* bucket into result groups */
function bucket(raw, url) {
  const grp = {
    'Missing Alt Text'        : [],
    'File Name'               : [],
    'Matching Nearby Content' : [],
    'Manual Check'            : []
  };
  const extRE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

  raw.forEach(i => {
    if (!i.src) return;
    try { i.src = new URL(i.src, url).toString(); } catch {}

    const lower = i.alt.toLowerCase();
    const base  = (i.src.split('/').pop() || '').split('.')[0];

    const clean = { src: i.src, alt: i.alt };
    if (i.matchingSnippet) clean.matchingSnippet = i.matchingSnippet;

    if (!i.alt)                    grp['Missing Alt Text'].push(clean);
    else if (i.dup)                grp['Matching Nearby Content'].push(clean);
    else if (lower === base || extRE.test(lower))
                                   grp['File Name'].push(clean);
    else                           grp['Manual Check'].push(clean);
  });
  return { totalImages: raw.length, errorGroups: grp };
}

/* simple quality filter */
function filter(list) {
  const freq = Object.create(null);
  list.forEach(i => { if (i.src) freq[i.src] = (freq[i.src] || 0) + 1; });

  return list.filter(i => {
    if (!i.src || i.tooSmall || tiny(i.src)) return false;
    const d = freq[i.src] || 0, gif = /\.gif/i.test(i.src), svg = /\.svg/i.test(i.src);
    if (d >= 10 && (!i.alt || gif)) return false;
    if (d >= 5  && !i.alt && svg)  return false;
    return true;
  });
}

/*──────────────────── HTML quick pass ───────────────────*/
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

async function scrapeHTML(url, N) {
  const resp = await fetch(url, {
    timeout : 7000,
    headers : {
      'User-Agent'      : UA_PC,
      'Accept-Language' : 'en-US,en;q=0.9'
    }
  });

  if (resp.status === 403 || resp.status === 401 || resp.status === 429)
    throw new Error('blocked');
  if (resp.status >= 400 && resp.status < 500)
    throw new Error('typo');
  if (!resp.ok)
    throw new Error('internal');

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
    raw.push({ src: norm(src), alt: alt.trim(), tooSmall: too, $el: $e });
  });

  const clean = filter(raw);
  clean.forEach(i => {
    if (i.alt && wordsAround($, i.$el, N).includes(i.alt.toLowerCase()))
      i.dup = true;
  });

  return {
    report : bucket(clean, url),
    metrics: { raw: raw.length, kept: clean.length }
  };
}

/*───────────────── JS-DOM pass (lazy-load / SPA) ───────────────*/
async function scrapeDOM(url, N) {
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

      if (jsOn) {
        let prev = 0;
        for (let i = 0; i < 12; i++) {
          const len = await page.$$eval('img,source,[style*="background-image"]', els => els.length);
          if (len - prev < 5) break;
          prev = len;
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
          await page.waitForTimeout(700);
        }
        await page.waitForTimeout(600);
      }

      const raw = await page.$$eval(
        ['img','source','[style*="background-image"]'].join(','),
        (els, N) => {
          const norm = s => s.replace(/\{width\}x\{height\}/gi, '600x');
          const firstToken = s => s.trim().split(/\s+/)[0];

          return els.map(el => {
            const tag = el.tagName.toLowerCase();
            const g   = a => el.getAttribute(a) || '';

            let src = '', alt = '', too = false, dup = false;
            if (tag === 'img') {
              src = g('data-srcset') || g('srcset') || g('data-src') || g('data-lazy') ||
                    g('data-original') || g('data-landscape-url') || g('data-portrait-url') ||
                    g('src') || '';
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

            /* duplicate-text check */
            if (alt) {
              const words = (node, dir, arr = []) => {
                let n = node[dir];
                while (n && arr.length < N) {
                  if (n.nodeType === 3 && n.textContent.trim())
                    arr.push(...n.textContent.trim().split(/\s+/));
                  else if (n.nodeType === 1) {
                    const t = n.textContent.trim(); if (t) arr.push(...t.split(/\s+/));
                  }
                  n = n[dir];
                }
                return arr;
              };
              const around = [...words(el,'previousSibling').slice(-N),
                              ...words(el,'nextSibling').slice(0, N)]
                             .join(' ').toLowerCase();
              dup = around.includes(alt.toLowerCase());
            }

            return { src: norm(firstToken(src)), alt: alt.trim(), tooSmall: too, dup };
          });
        }, N
      );

      await browser.close();
      return bucket(filter(raw), url);

    } catch (e) {
      await browser.close();
      throw e;
    }
  }

  try {
    return await run({ jsOn: true,  timeout: 8000, ua: UA_PC });
  } catch (e) {
    if (!/Timeout/i.test(e.message)) throw e;
    /* fallback: JS disabled + mobile UA */
    return await run({
      jsOn   : false,
      timeout: 10000,
      ua     : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
               'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
               'Mobile/15E148 Safari/604.1'
    });
  }
}

/*────────────────────── HTTP HANDLER ───────────────────*/
module.exports = async (req, res) => {
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

  const WORD_WINDOW = 50;

  /* First: quick HTML pass */
  try {
    const { report, metrics } = await scrapeHTML(url, WORD_WINDOW);
    const placeholderRatio = 1 - (metrics.kept / (metrics.raw || 1));
    const needDom = placeholderRatio >= 0.8 || report.totalImages < 20;

    if (!needDom) return res.status(200).json({ ...report, engine:'html' });

    /* Second: JS-DOM pass */
    const dom = await scrapeDOM(url, WORD_WINDOW);
    if (dom.totalImages < 20) {
      return res.status(200).json({
        ...report,
        engine : 'html',
        blocked: true,
        note   : 'Site blocks headless browsers; only server-rendered images analysed.'
      });
    }
    return res.status(200).json({ ...dom, engine:'js-dom' });

  } catch (err) {

    /* If HTML pass failed, try DOM before giving up */
    if (err.message === 'blocked' || err.message === 'typo') {
      try {
        const dom = await scrapeDOM(url, WORD_WINDOW);
        return res.status(200).json({ ...dom, engine:'js-dom (fallback)' });
      } catch (err2) { err = err2; }        // use the second error if DOM fails
    }

    if (err.message === 'typo')    return res.status(400).json({ error: 'typo' });
    if (err.message === 'blocked') return res.status(403).json({ error: 'blocked' });

    console.error('fatal:', err);
    return res.status(500).json({ error: 'internal' });
  }
};
