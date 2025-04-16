const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

// -------------------------------------------------------
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

// -------------------------------------------------------
// Functions to collect nearby text around an <img>
function collectWordsBefore($, $img, maxWords) {
  const words = [];
  let $current = $img.prev();
  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const parts = $current[0].data.trim().split(/\s+/);
      words.unshift(...parts);
    } else if ($current[0].type === 'tag') {
      const txt = $current.text().trim();
      if (txt) words.unshift(...txt.split(/\s+/));
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
      if (txt) words.push(...txt.split(/\s+/));
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

// -------------------------------------------------------
// Helper: Convert a (relative) URL to an absolute URL
function toAbsoluteUrl(src, baseUrl) {
  if (!src) return "";
  try {
    return new URL(src, baseUrl).toString();
  } catch (e) {
    return src;
  }
}

// -------------------------------------------------------
// Smart scrolling: scrolls by one viewport until image count stabilizes
// or until a maximum time limit is reached.
async function smartScroll(page, { maxTimeMS = 10000, stableIterations = 2 } = {}) {
  const startTime = Date.now();
  let prevImageCount = await page.evaluate(() => document.querySelectorAll('img').length);
  let stableCount = 0;
  
  while (Date.now() - startTime < maxTimeMS && stableCount < stableIterations) {
    // Force lazy-loading update.
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
    
    // Scroll by one viewport height.
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    // Wait briefly for new images to load.
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const currentImageCount = await page.evaluate(() => document.querySelectorAll('img').length);
    if (currentImageCount === prevImageCount) {
      stableCount++;
    } else {
      stableCount = 0;
      prevImageCount = currentImageCount;
    }
  }
}

// -------------------------------------------------------
// Timeout wrapper: ensures a response even if scraping takes too long.
async function withTimeout(promise, timeoutMS = 28000) {
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      resolve({ timeout: true });
    }, timeoutMS);
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timeout);
  return result;
}

// -------------------------------------------------------
// MAIN FUNCTION
module.exports = async (req, res) => {
  // Always set CORS headers (even on errors)
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
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let { url, debug } = req.body || {};
  debug = debug || req.query.debug;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  
  const overallStart = Date.now();
  let browser = null, html = "";
  try {
    const execPath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: chromium.headless
    });
    const page = await browser.newPage();

    // Load page quickly
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait 1 second to allow lazy-loading scripts to run
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Execute smart full-page scroll (with a max of 10 seconds)
    await withTimeout(smartScroll(page, { maxTimeMS: 10000, stableIterations: 2 }), 11000);

    // Extra wait for any final lazy load updates (1 second)
    await new Promise(resolve => setTimeout(resolve, 1000));

    html = await page.content();
    await browser.close();
    browser = null;
  } catch (err) {
    console.error("Error scraping with Puppeteer:", err);
    if (browser) await browser.close();
    res.status(500).json({
      error: "There was a problem analyzing the URL. Please check the URL and try again."
    });
    return;
  }
  
  let result;
  try {
    const $ = cheerio.load(html);
    const images = [];
    $('img').each((_, el) => {
      let rawSrc = $(el).attr('src') || '';
      if (!rawSrc || rawSrc.trim() === "" || rawSrc === "about:blank") {
        rawSrc = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('data-original') || '';
      }
      const alt = ($(el).attr('alt') || '').trim();
      const finalSrc = toAbsoluteUrl(rawSrc, url);
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
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    });
    
    result = {
      totalImages: images.length,
      errorGroups
    };
    
    if (debug) {
      result.debug = {
        processingTime: Date.now() - overallStart,
        htmlLength: html.length
      };
    }
    
    res.status(200).json(result);
  } catch (parseError) {
    console.error("Error parsing HTML:", parseError);
    res.status(500).json({
      error: "Error processing the page content. Please try again."
    });
  }
};
