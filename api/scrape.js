// api/scrape.js

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// ------------------------------------------
// Utility: Create a highlighted snippet from text
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

function getNearbyText($, $img, wordsBefore = 500, wordsAfter = 500) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after = collectWordsAfter($, $img, wordsAfter);
  return [...before, ...after].join(" ");
}

// ------------------------------------------
// Helper: Convert a (relative) URL to an absolute URL based on baseUrl
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (e) {
    return src;
  }
}

// ------------------------------------------
// Robust auto-scroll that scrolls until no new images are loaded
async function autoScroll(page, maxTimeMS = 25000, stableIterations = 3) {
  const startTime = Date.now();
  let lastImageCount = await page.evaluate(() => document.querySelectorAll('img').length);
  let stableCount = 0;
  
  while (Date.now() - startTime < maxTimeMS && stableCount < stableIterations) {
    // Force lazy-loading update for all images on each iteration:
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('img')).forEach(img => {
        const currentSrc = img.getAttribute('src') || "";
        if (!currentSrc || currentSrc.trim() === "" || currentSrc === "about:blank" || currentSrc.includes("s_1x2.gif")) {
          if (img.dataset) {
            if (img.dataset.src) {
              img.src = img.dataset.src;
            } else if (img.dataset.lazy) {
              img.src = img.dataset.lazy;
            } else if (img.dataset.original) {
              img.src = img.dataset.original;
            }
          }
        }
      });
    });
    
    // Scroll down one viewport height
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    // Wait 500ms for content to load
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check how many images we have now
    const newCount = await page.evaluate(() => document.querySelectorAll('img').length);
    if (newCount === lastImageCount) {
      stableCount++;
    } else {
      stableCount = 0;
      lastImageCount = newCount;
    }
  }
}

// ------------------------------------------
// MAIN FUNCTION
module.exports = async (req, res) => {
  const debugData = {}; // optional debug information
  const startTime = Date.now();

  // Set CORS headers
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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let { url, debug } = req.body || {};
  // Allow debug flag via query as well
  debug = debug || req.query.debug;
  
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
    
    // Use a fast loading strategy: wait for domcontentloaded
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait 1 second to allow lazy-loaded scripts to update images
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // For pages that load images dynamically, auto-scroll until image count stabilizes
    await autoScroll(page);
    
    // Extra wait for final lazy-loading updates
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    html = await page.content();
    if (debug) debugData.pageLoadTime = Date.now() - startTime;
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
      // Prefer the standard src; if empty, check common lazy-loading attributes
      let rawSrc = $(el).attr('src') || '';
      if (!rawSrc || rawSrc.trim() === "" || rawSrc === "about:blank") {
        rawSrc = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('data-original') || '';
      }
      const alt = ($(el).attr('alt') || '').trim();
      const finalSrc = toAbsoluteUrl(rawSrc, url);
      // Filter out known tracking pixels if desired
      if (finalSrc.includes("bat.bing.com/action/0")) return;
      if (finalSrc) {
        images.push({ src: finalSrc, alt, $el: $(el) });
      }
    });
    
    if (debug) debugData.totalImagesFound = images.length;
    
    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Manual Check": []
    };
    
    images.forEach(img => {
      const altLower = img.alt.toLowerCase();
      // 1) If the alt text is missing, flag as error.
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 2) If alt text is the file name (or appears to be)
      const srcFileName = img.src.split('/').pop().split('.')[0] || "";
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
      if (altLower === srcFileName.toLowerCase() || extRegex.test(altLower)) {
        errorGroups["File Name"].push({ src: img.src, alt: img.alt });
        return;
      }
      // 3) If alt text appears in the nearby text
      const localText = getNearbyText($, img.$el, 500, 500);
      if (localText.toLowerCase().includes(altLower)) {
        const snippet = createHighlightedSnippet(localText, img.alt, 50);
        errorGroups["Matching Nearby Content"].push({
          src: img.src,
          alt: img.alt,
          matchingSnippet: snippet
        });
        return;
      }
      // 4) Otherwise flag for manual review
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    });
    
    const result = {
      totalImages: images.length,
      errorGroups
    };
    
    if (debug) {
      result.debug = {
        processingTime: Date.now() - startTime,
        htmlLength: html.length,
        debugData
      };
    }
    
    return res.status(200).json(result);
    
  } catch (parseError) {
    console.error("Error parsing HTML:", parseError);
    return res.status(500).json({
      error: "Error processing the page content. Please try again."
    });
  }
};
