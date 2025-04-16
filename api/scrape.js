// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// Utility: highlight the matched alt text (for snippet display)
function createHighlightedSnippet(fullText, matchStr, radius = 50) {
  const fullLower = fullText.toLowerCase();
  const matchLower = matchStr.toLowerCase();
  const idx = fullLower.indexOf(matchLower);
  if (idx === -1) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(fullLower.length, idx + matchStr.length + radius);
  let snippet = fullText.slice(start, end);
  const altRegex = new RegExp(matchStr, "i");
  snippet = snippet.replace(altRegex, `**${matchStr}**`);
  if (start > 0) snippet = "..." + snippet;
  if (end < fullLower.length) snippet += "...";
  return snippet;
}

// Collect words *before* the <img> (up to maxWords)
function collectWordsBefore($, $img, maxWords) {
  const words = [];
  let $current = $img.prev();
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

// Collect words *after* the <img> (up to maxWords)
function collectWordsAfter($, $img, maxWords) {
  const words = [];
  let $current = $img.next();
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

// Combine before+after text for a single <img>
function getNearbyText($, $img, wordsBefore = 300, wordsAfter = 300) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after = collectWordsAfter($, $img, wordsAfter);
  return [...before, ...after].join(" ");
}

// Helper: convert a relative URL to absolute
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (_) {
    return src;
  }
}

// autoScroll: scroll so lazy-loaded images appear
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
  // BEGIN CORS HEADERS
  const allowedOrigins = [
    "https://scribely-v2.webflow.io",
    "https://scribely.com",
    "https://scribelytribe.com",
    "https://www.scribely.com",
    "https://www.scribelytribe.com"
  ];
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes(origin) ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  // END CORS HEADERS

  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  let { url } = req.body || {};
  if (!url)
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let browser = null;
  try {
    // Use PUPPETEER_EXECUTABLE_PATH env var if set; otherwise, fall back.
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await autoScroll(page);
    const html = await page.content();
    await browser.close();
    browser = null;

    const $ = cheerio.load(html);
    const images = [];
    $('img').each((_, el) => {
      const alt = ($(el).attr('alt') || '').trim();
      const rawSrc = $(el).attr('src') || '';
      const finalSrc = toAbsoluteUrl(rawSrc, url);
      images.push({ src: finalSrc, alt, $el: $(el) });
    });

    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Manual Check": []
    };

    images.forEach(img => {
      const altLower = img.alt.toLowerCase();
      // Missing alt?
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }
      // File name check
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (altLower === srcFileName.toLowerCase() || extRegex.test(altLower)) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }
      // Matching Nearby Content check
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
      // Fallback: Manual Check
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    });

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
