// api/scrape.js

const cheerio = require('cheerio');
const fetch = require('node-fetch'); // node-fetch@2 in CommonJS

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

// 2) Collect words *before* the <img> in the DOM (up to maxWords)
function collectWordsBefore($, $img, maxWords) {
  const words = [];
  let $current = $img.prev(); // Cheerio's reference to the *previous sibling*

  while ($current.length && words.length < maxWords) {
    if ($current[0].type === 'text') {
      const textParts = $current[0].data.trim().split(/\s+/);
      // We unshift so that the earliest text is at the end
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

  // We only need up to `maxWords`, from the end
  return words.slice(-maxWords);
}

// 3) Collect words *after* the <img> in the DOM (up to maxWords)
function collectWordsAfter($, $img, maxWords) {
  const words = [];
  let $current = $img.next(); // Cheerio's reference to the *next sibling*

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

  // We only need up to `maxWords`
  return words.slice(0, maxWords);
}

// 4) Combine before+after text for a single <img>
function getNearbyText($, $img, wordsBefore = 300, wordsAfter = 300) {
  const before = collectWordsBefore($, $img, wordsBefore);
  const after = collectWordsAfter($, $img, wordsAfter);

  // Combine them
  return [...before, ...after].join(" ");
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
    return res.status(400).json({
      error: 'Missing "url" in request body.'
    });
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    // Check for security blocking: 401, 403, 429, 503
    if ([401, 403, 429, 503].includes(response.status)) {
      return res.status(response.status).json({
        error: "This website has security measures that blocked this request."
      });
    }

    if (!response.ok) {
      // e.g. 404 or 500
      return res.status(response.status).json({
        error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
      });
    }

    // Parse the HTML
    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove scripts, styles, aria-hidden
    $('script, style, [aria-hidden="true"]').remove();

    // Collect all <img> elements, keep track of their Cheerio element
    const images = [];
    $('img').each((_, el) => {
      let src = $(el).attr('src') || '';
      const alt = ($(el).attr('alt') || '').trim();
      try {
        src = new URL(src, url).toString();
      } catch (_) {
        // if URL parse fails, keep original
      }
      images.push({
        src,
        alt,
        $el: $(el) // We'll need this for local text
      });
    });

    // Only 4 categories: Missing Alt, File Name, Matching, Manual Check
    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Manual Check": []
    };

    // Categorize each image
    function categorizeImage(img) {
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
      //    Instead of checking entire page text, we now gather only ~300 words
      //    before and after the image in the DOM.
      const localText = getNearbyText($, img.$el, 300, 300);
      const localTextLower = localText.toLowerCase();

      if (localTextLower.includes(altLower)) {
        // Grab a short snippet with the alt text highlighted
        const snippet = createHighlightedSnippet(localText, img.alt, 50);
        errorGroups["Matching Nearby Content"].push({
          src: img.src,
          alt: img.alt,
          matchingSnippet: snippet
        });
        return;
      }

      // 4) Manual Check (fallback)
      errorGroups["Manual Check"].push({ src: img.src, alt: img.alt });
    }

    images.forEach(categorizeImage);

    // Return to front-end
    return res.status(200).json({
      totalImages: images.length,
      // front-end will compute total errors/alerts
      totalErrors: 0,
      totalAlerts: 0,
      errorGroups
    });

  } catch (err) {
    console.error("Error scraping:", err);

    // If ENOTFOUND => likely domain is invalid
    if (err.code === 'ENOTFOUND') {
      return res.status(400).json({
        error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
      });
    }
    // Generic fallback
    return res.status(500).json({
      error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
    });
  }
};
