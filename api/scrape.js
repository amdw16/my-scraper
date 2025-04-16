// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// 1) Utility: highlight the matched alt text (for snippet display)
function createHighlightedSnippet(fullText, matchStr, radius = 50) {
  const fullLower = fullText.toLowerCase();
  const matchLower = matchStr.toLowerCase();

  const idx = fullLower.indexOf(matchLower);
  if (idx === -1) {
    return "";
  }
  const start = Math.max(0, idx - radius);
  const end   = Math.min(fullText.length, idx + matchStr.length + radius);

  let snippet = fullText.slice(start, end);

  // Replace the first occurrence, case-insensitive
  const altRegex = new RegExp(matchStr, "i");
  snippet = snippet.replace(altRegex, `**${matchStr}**`);

  if (start > 0) {
    snippet = "..." + snippet;
  }
  if (end < fullText.length) {
    snippet += "...";
  }
  return snippet;
}

// 2) Collect words *before* the <img> (up to maxWords)
function collectWordsBefore($, $img, maxWords) {
  const words = [];
  let $current = $img.prev(); // previous sibling

  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const textParts = $current[0].data.trim().split(/\s+/);
      words.unshift(...textParts);
    } else if ($current[0].type === 'tag') {
      const txt = $current.text().trim();
      if (txt) {
        const textParts = txt.split(/\s+/);
        words.unshift(...textParts);
      }
    }
    $current = $current.prev();
  }
  return words.slice(-maxWords);
}

// 3) Collect words *after* the <img> (up to maxWords)
function collectWordsAfter($, $img, maxWords) {
  const words = [];
  let $current = $img.next(); // next sibling

  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const textParts = $current[0].data.trim().split(/\s+/);
      words.push(...textParts);
    } else if ($current[0].type === 'tag') {
      const txt = $current.text().trim();
      if (txt) {
        const textParts = txt.split(/\s+/);
        words.push(...textParts);
      }
    }
    $current = $current.next();
  }
  return words.slice(0, maxWords);
}

// 4) Combine before+after text for a single <img>
function getNearbyText($, $img, wordsBefore = 300, wordsAfter = 300) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after  = collectWordsAfter($, $img, wordsAfter);
  return [...before, ...after].join(" ");
}

// Helper: convert a relative URL to absolute
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (_) {
    return src; // fallback if invalid
  }
}

// 5) autoScroll: scroll so lazy-loaded images appear
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  });
}

module.exports = async (req, res) => {
  // --- BEGIN CORS HEADERS ---
  const allowedOrigins = [
    "https://scribely-v2.webflow.io",
    "https://scribely.com",
    "https://scribelytribe.com",
    "https://www.scribely.com",
    "https://www.scribelytribe.com"
  ];
  const origin = req.headers.origin || "";
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  // --- END CORS HEADERS ---

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }
  // If user didn't provide http/https, prepend https
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let browser = null;
  try {
    // 1) Launch Puppeteer (serverless-friendly)
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
    });

    // 2) Create page & navigate
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // 3) Scroll to load lazy images
    await autoScroll(page);

    // 4) Get final HTML (DOM after JS is done)
    const html = await page.content();

    // 5) Close browser
    await browser.close();
    browser = null;

    // 6) Parse with Cheerio
    const $ = cheerio.load(html);

    // 7) Collect <img> elements
    const images = [];
    $('img').each((_, el) => {
      const alt = ($(el).attr('alt') || '').trim();
      const rawSrc = $(el).attr('src') || '';
      const finalSrc = toAbsoluteUrl(rawSrc, url);

      // We'll also keep a reference to this cheerio element for local text checks
      images.push({
        src: finalSrc,
        alt,
        $el: $(el)
      });
    });

    // 8) Error groups
    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Manual Check": []
    };

    // 9) Categorize
    images.forEach(img => {
      const altLower = img.alt.toLowerCase();

      // 1) Missing alt?
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }

      // 2) File name?
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (
        altLower === srcFileName.toLowerCase() ||
        extRegex.test(altLower)
      ) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }

      // 3) Matching Nearby Content?
      const localText = getNearbyText($, img.$el, 300, 300);
      if (localText.toLowerCase().includes(altLower)) {
        const snippet = createHighlightedSnippet(localText, img.alt, 50);
        errorGroups["Matching Nearby Content"].push({
          src: img.src,
          alt: img.alt,
          matchingSnippet: snippet
        });
        return;
      }

      // 4) Otherwise => Manual Check
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    });

    // 10) Return the result
    return res.status(200).json({
      totalImages: images.length,
      errorGroups
    });

  } catch (err) {
    console.error("Error scraping with Puppeteer:", err);
    if (browser) await browser.close();
    return res.status(500).json({
      error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
    });
  }
};
