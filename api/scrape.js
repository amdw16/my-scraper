// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // Using node-fetch@2 in CommonJS

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

  let url = req.body?.url || "";
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }

  // Ensure the URL is absolute; if missing protocol, default to https://
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  try {
    // Attempt the fetch
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    // if security measure blocks => often 401 or 403
    if (response.status === 401 || response.status === 403) {
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

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove non-readable elements that are not announced by screen readers.
    $('script, style, [aria-hidden="true"]').remove();

    // Extract only the visible text from elements that screen readers announce.
    let visibleText = "";
    const selectors = ['h1', 'h2', 'h3', 'p', 'span'];
    selectors.forEach(sel => {
      $(sel).each((_, el) => {
        visibleText += $(el).text() + " ";
      });
    });
    visibleText = visibleText.trim().toLowerCase();

    // Collect all <img> with absolute URLs
    const images = [];
    $('img').each((_, el) => {
      let src = $(el).attr('src') || '';
      const alt = ($(el).attr('alt') || '').trim();
      try {
        src = new URL(src, url).toString();
      } catch (err) {
        // If URL parsing fails, we keep src as-is
      }
      images.push({ src, alt });
    });

    // We'll group by these keys:
    const errorGroups = {
      "Missing Alt Text": [],
      "File Name": [],
      "Matching Nearby Content": [],
      "Short Alt Text": [],
      "Long Alt Text": [],
      "Manual Check": []
    };

    function categorizeImage(img) {
      const altLower = img.alt.toLowerCase();
      const srcFileName = img.src.split('/').pop().split('.')[0] || ""; 
      const extRegex = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

      // 1) Missing Alt?
      if (!img.alt) {
        errorGroups["Missing Alt Text"].push({ 
          src: img.src, 
          alt: img.alt 
        });
        return; // stop checks
      }

      // 2) File Name?
      if (
        altLower === srcFileName.toLowerCase() ||
        extRegex.test(altLower)
      ) {
        errorGroups["File Name"].push({
          src: img.src,
          alt: img.alt
        });
        return; // stop checks
      }

      // 3) Matches Nearby Content?
      // if alt text is found in visibleText
      if (visibleText.includes(altLower)) {
        // Attempt to find a short snippet
        let snippet = "";
        const idx = visibleText.indexOf(altLower);
        if (idx !== -1) {
          // We can try to get about 50 chars around it
          const start = Math.max(0, idx-50);
          const end = Math.min(visibleText.length, idx + altLower.length + 50);
          snippet = visibleText.slice(start, end);
        }
        errorGroups["Matching Nearby Content"].push({
          src: img.src,
          alt: img.alt,
          matchingSnippet: snippet
        });
        return; // stop checks
      }

      // 4) Text length check?
      if (img.alt.length < 20) {
        // short alt text
        errorGroups["Short Alt Text"].push({
          src: img.src,
          alt: img.alt
        });
        return;
      } 
      else if (img.alt.length > 300) {
        // long alt text
        errorGroups["Long Alt Text"].push({
          src: img.src,
          alt: img.alt
        });
        return;
      }

      // 5) Fallback => Manual Check
      errorGroups["Manual Check"].push({
        src: img.src,
        alt: img.alt
      });
    }

    // Categorize each image
    images.forEach(img => {
      categorizeImage(img);
    });

    // Summaries
    const totalImages = images.length;

    // We no longer do "totalErrors" or "totalAlerts" directly on backend 
    // because you want to do the combining logic front-end. 
    // But we can optionally keep them if your existing front-end is referencing them:
    // (They won't strictly match your new definition of "Errors" vs. "Alerts," but we can omit them or set them to 0.)
    // Let’s just omit them from the response, or set to 0:

    return res.status(200).json({
      totalImages,
      // We'll still return something for "totalErrors" / "totalAlerts" 
      // so older code doesn't break, but set them to 0:
      totalErrors: 0,
      totalAlerts: 0,
      errorGroups
    });

  } catch (err) {
    console.error('Error scraping:', err);

    // Distinguish certain errors:
    // For example, if it's an ENOTFOUND => "typo"
    if (err.code === 'ENOTFOUND') {
      return res.status(400).json({
        error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
      });
    }
    // Otherwise, general catch-all:
    return res.status(500).json({
      error: "There was a problem analyzing the URL. Check for typos and formatting in the URL and try again."
    });
  }
};
