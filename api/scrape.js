// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// Utility: Highlight a snippet in the text
function createHighlightedSnippet(fullText, matchStr, radius = 50) {
  const lowerText = fullText.toLowerCase();
  const lowerMatch = matchStr.toLowerCase();
  const idx = lowerText.indexOf(lowerMatch);
  if (idx === -1) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(fullText.length, idx + matchStr.length + radius);
  let snippet = fullText.slice(start, end);
  const regex = new RegExp(matchStr, "i");
  snippet = snippet.replace(regex, `**${matchStr}**`);
  if (start > 0) snippet = "..." + snippet;
  if (end < fullText.length) snippet += "...";
  return snippet;
}

// Collect words before the <img> element (up to maxWords)
function collectWordsBefore($, $img, maxWords) {
  const words = [];
  let $current = $img.prev();
  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const parts = $current[0].data.trim().split(/\s+/);
      words.unshift(...parts);
    } else if ($current[0].type === 'tag') {
      const txt = $current.text().trim();
      if (txt) {
        words.unshift(...txt.split(/\s+/));
      }
    }
    $current = $current.prev();
  }
  return words.slice(-maxWords);
}

// Collect words after the <img> element (up to maxWords)
function collectWordsAfter($, $img, maxWords) {
  const words = [];
  let $current = $img.next();
  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const parts = $current[0].data.trim().split(/\s+/);
      words.push(...parts);
    } else if ($current[0].type === 'tag') {
      const txt = $current.text().trim();
      if (txt) {
        words.push(...txt.split(/\s+/));
      }
    }
    $current = $current.next();
  }
  return words.slice(0, maxWords);
}

// Combine before and after text for the <img> element
function getNearbyText($, $img, wordsBefore = 300, wordsAfter = 300) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after = collectWordsAfter($, $img, wordsAfter);
  return [...before, ...after].join(" ");
}

// Convert a relative URL to an absolute URL, based on baseUrl
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (e) {
    return src;
  }
}

// Limited auto-scroll: Scroll up to maxScrolls or for a maximum duration (maxTimeMS)
async function autoScroll(page, maxScrolls = 10, distance = 500, delay = 300, maxTimeMS = 20000) {
  const startTime = Date.now();
  let scrolls = 0;
  while (scrolls < maxScrolls && (Date.now() - startTime) < maxTimeMS) {
    const previousHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(y => window.scrollBy(0, y), distance);
    await new Promise(resolve => setTimeout(resolve, delay));
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break;
    scrolls++;
  }
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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  let browser = null;
  try {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless
    });

    const page = await browser.newPage();
    // Use networkidle2 to wait for most network activity to subside
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Limit scrolling: For known heavy sites, you can reduce maxScrolls
    const maxScrolls = url.includes("ebay.com") ? 3 : 10;
    await autoScroll(page, maxScrolls, 500, 300, 20000);
    
    const html = await page.content();
    await browser.close();
    browser = null;

    const $ = cheerio.load(html);
    const images = [];
    $('img').each((_, el) => {
      const alt = ($(el).attr('alt') || '').trim();
      const rawSrc = $(el).attr('src') || '';
      const finalSrc = toAbsoluteUrl(rawSrc, url);
      // Optionally, filter out known tracking pixels
      if (finalSrc.includes("bat.bing.com/action/0")) return;
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
      // 1) If missing alt text, flag as error
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 2) Check if alt text is simply the file name
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (altLower === srcFileName.toLowerCase() || extRegex.test(altLower)) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 3) Check if the alt text duplicates nearby content
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
      // 4) Otherwise, mark for manual review
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
