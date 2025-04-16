// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // For static fetch

// ==========================================================
// Utility: Highlight a snippet in text matching the alt text
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

// ==========================================================
// Functions to collect nearby text for an <img>
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

// ==========================================================
// Helper: Convert a relative URL to an absolute URL based on baseUrl
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (e) {
    return src;
  }
}

// ==========================================================
// Limited auto-scroll for Puppeteer with time-based cutoff
async function autoScroll(page, maxScrolls = 10, distance = 500, delay = 300, maxTimeMS = 20000) {
  const startTime = Date.now();
  let scrolls = 0;
  while (scrolls < maxScrolls && (Date.now() - startTime) < maxTimeMS) {
    const previousHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(y => window.scrollBy(0, y), distance);
    // Use a native promise as a delay
    await new Promise(resolve => setTimeout(resolve, delay));
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break;
    scrolls++;
  }
}

// ==========================================================
// Attempt a static fetch (faster for mostly static sites)
async function fetchStaticHTML(url, timeout = 5000) {
  return Promise.race([
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml'
      }
    }).then(res => { 
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text(); 
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Static fetch timeout")), timeout))
  ]);
}

// ==========================================================
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

  let html = "";
  let usingPuppeteer = false;
  
  // First, try static fetch for speed
  try {
    html = await fetchStaticHTML(url, 5000); // 5-second timeout
    const $temp = cheerio.load(html);
    const staticImgCount = $temp('img').length;
    // If we got a reasonable number of images (e.g., 5 or more), use static HTML.
    if (staticImgCount < 5) {
      throw new Error("Not enough images in static fetch, falling back to Puppeteer");
    }
  } catch (err) {
    // Fall back to Puppeteer for dynamic sites
    usingPuppeteer = true;
  }
  
  let browser = null;
  if (usingPuppeteer || !html) {
    try {
      const execPath = await chromium.executablePath();
      browser = await puppeteer.launch({
        args: chromium.args,
        executablePath: execPath,
        headless: chromium.headless
      });
      const page = await browser.newPage();
      // Use a lighter event for faster resolution; networkidle2 might be too strict
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // For known heavy sites (e.g., ebay), reduce the number of scrolls
      const maxScrolls = url.includes("ebay.com") ? 3 : 10;
      await autoScroll(page, maxScrolls, 500, 300, 20000);
      html = await page.content();
      await browser.close();
      browser = null;
    } catch (err) {
      if (browser) await browser.close();
      console.error("Error in Puppeteer fallback:", err);
      return res.status(500).json({
        error: "There was a problem analyzing the URL. Please try again or check the URL formatting."
      });
    }
  }
  
  // Parse the collected HTML with Cheerio
  try {
    const $ = cheerio.load(html);
    const images = [];
    $('img').each((_, el) => {
      const alt = ($(el).attr('alt') || '').trim();
      const rawSrc = $(el).attr('src') || '';
      const finalSrc = toAbsoluteUrl(rawSrc, url);
      // Optionally filter out tracking pixels
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
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (altLower === srcFileName.toLowerCase() || extRegex.test(altLower)) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }
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
