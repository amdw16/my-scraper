// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// ------------------------------------------
// Utility: Create a highlighted snippet in text
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

// ------------------------------------------
// Functions to extract nearby text around an <img>
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

function getNearbyText($, $img, wordsBefore = 300, wordsAfter = 300) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after = collectWordsAfter($, $img, wordsAfter);
  return [...before, ...after].join(" ");
}

// ------------------------------------------
// Helper: Convert a (relative) URL to an absolute URL based on baseUrl.
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (e) {
    return src;
  }
}

// ------------------------------------------
// (Optional) Limited auto-scroll function (currently NOT used for heavy domains)
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

// ------------------------------------------
// MAIN FUNCTION
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
  let html = "";
  try {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless
    });
    const page = await browser.newPage();
    
    // Use domcontentloaded for faster load instead of waiting for networkidle2.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait 1 second to give lazy-loading scripts a chance to update image srcs.
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // [Optional] If you want to scroll only if needed, you can enable the autoScroll here
    // For heavy pages like eBay or HillhouseHome, we disable scrolling.
    const shouldScroll = !(url.includes("ebay.com") || url.includes("hillhousehome.com"));
    if (shouldScroll) {
      await autoScroll(page, 10, 500, 300, 20000);
    }
    
    html = await page.content();
    await browser.close();
    browser = null;
  } catch (err) {
    console.error("Error scraping with Puppeteer:", err);
    if (browser) await browser.close();
    return res.status(500).json({
      error: "There was a problem analyzing the URL. Please check the URL and try again."
    });
  }
  
  try {
    const $ = cheerio.load(html);
    const images = [];
    $('img').each((_, el) => {
      // Try standard src attribute; if missing or empty, check common lazy-loading attributes.
      let rawSrc = $(el).attr('src') || '';
      if (!rawSrc || rawSrc.trim() === "" || rawSrc === "about:blank") {
        rawSrc = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('data-original') || '';
      }
      const alt = ($(el).attr('alt') || '').trim();
      const finalSrc = toAbsoluteUrl(rawSrc, url);
      // Filter out known tracking pixels if desired.
      if (finalSrc.includes("bat.bing.com/action/0")) return;
      if (finalSrc) {
        images.push({ src: finalSrc, alt, $el: $(el) });
      }
    });
    
    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Manual Check": []
    };
    
    images.forEach(img => {
      const altLower = img.alt.toLowerCase();
      // 1) Missing alt text check.
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 2) File name check.
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (altLower === srcFileName.toLowerCase() || extRegex.test(altLower)) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 3) Check if alt text appears in the nearby content.
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
      // 4) Otherwise, flag for manual check.
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    });
    
    return res.status(200).json({
      totalImages: images.length,
      errorGroups
    });
    
  } catch (parseError) {
    console.error("Error parsing HTML:", parseError);
    return res.status(500).json({
      error: "Error processing the page content. Please try again."
    });
  }
};
