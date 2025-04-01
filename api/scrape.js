// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // Using node-fetch@2 in CommonJS

// HELPER: Multi-heuristic check for random/meaningless alt text
function isSuspiciouslyRandom(alt) {
  // At least 10 characters
  if (alt.length < 10) return false;

  // Must be a single token of letters/digits/underscore => no spaces or punctuation
  const singleTokenRegex = /^[A-Za-z0-9_]+$/;
  if (!singleTokenRegex.test(alt)) {
    return false; 
  }

  let suspiciousScore = 0;

  // Vowel ratio check
  const match = alt.match(/[aeiou]/gi);
  const vowelCount = match ? match.length : 0;
  const ratio = vowelCount / alt.length;
  if (ratio < 0.2) {
    suspiciousScore++;
  }

  // Hex-only check for 16+ length
  const hexHashRegex = /^[A-Fa-f0-9]+$/;
  if (hexHashRegex.test(alt) && alt.length >= 16) {
    suspiciousScore++;
  }

  // Base64 check for 16+ length
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (base64Regex.test(alt) && alt.length >= 16) {
    suspiciousScore++;
  }

  // If 2 or more indicators, we flag as random
  return suspiciousScore >= 2;
}

// Helper function: validate alt text and return an array of error objects.
function validateAltText(image, bodyText, $) {
  const errors = [];
  const alt = image.alt.trim();

  // Rule 1: Missing Alt Text
  if (!alt) {
    errors.push({ 
      type: "Missing Alt Text", 
      message: "This image is missing an alt text description needed for accessibility."
    });
  }

  // Rule 2: Alt Text as an Image File Name
  const srcFileName = image.src.split('/').pop().split('.')[0];
  if (alt) {
    const altLower = alt.toLowerCase().trim();
    const fileNameLower = srcFileName.toLowerCase().trim();
    const imageExtensions = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

    if (
      altLower === fileNameLower ||
      imageExtensions.test(altLower)
    ) {
      errors.push({
        type: "Alt Text as an Image File Name",
        message: "The alt text appears to be just a file name or ends with an image extension, rather than a descriptive phrase."
      });
    }
  }

  // Rule 3: Short Alt Text (less than 20 characters)
  if (alt && alt.length < 20) {
    errors.push({
      type: "Short Alt Text",
      message: "The alt text is too short to provide a meaningful description."
    });
  }

  // Rule 4: Long Alt Text (more than 300 characters)
  if (alt && alt.length > 300) {
    errors.push({
      type: "Long Alt Text",
      message: "The alt text is excessively long, which can confuse users and dilute clarity."
    });
  }

  // Rule 5: Matching Nearby Content – return only the text content and HTML snippet from the matching element.
if (bodyText && alt && bodyText.toLowerCase().includes(alt.toLowerCase())) {
  let matchingElement = null;
  let matchingSnippet = null;

  // Limit selectors to 'h1', 'h2', 'h3', 'p', and 'span'
  const selectors = ['h1', 'h2', 'h3', 'p', 'span'];

  outerLoop:
  for (let sel of selectors) {
    const foundEls = $(sel);
    for (let i = 0; i < foundEls.length; i++) {
      const foundEl = foundEls[i];
      const elText = $(foundEl).text().trim();

      if (elText.toLowerCase().includes(alt.toLowerCase())) {
        matchingElement = elText;
        matchingSnippet = $.html(foundEl).trim();
        break outerLoop;
      }
    }
  }

  // Fallback: If no matching element is found via selectors, search raw text.
  if (!matchingElement) {
    const altLower = alt.toLowerCase();
    const bodyLower = bodyText.toLowerCase();
    const idx = bodyLower.indexOf(altLower);
    if (idx !== -1) {
      const snippet = bodyText.substring(Math.max(0, idx - 50), idx + alt.length + 50);
      matchingElement = snippet;
      matchingSnippet = snippet; // Use the same snippet for both properties.
    }
  }

  if (matchingElement) {
    errors.push({
      type: "Matching Nearby Content",
      message: "The alt text duplicates nearby text, offering no additional image context.",
      matchingElement,
      matchingSnippet
    });
  }
}


  // Rule 6: Random Characters (updated with multi-heuristic approach)
  if (isSuspiciouslyRandom(alt)) {
    errors.push({
      type: "Random Characters",
      message: "The alt text appears to be a random/meaningless string."
    });
  }

  // Rule 7: Keyword String
  if (alt.split(',').length > 1) {
    errors.push({
      type: "Keyword String",
      message: "The alt text is just a list of keywords instead of a coherent description."
    });
  }

  return errors;
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

  try {
    let { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    // Ensure the URL is absolute; if missing protocol, default to https://
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    // Fetch the target URL
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      console.error('Failed to fetch URL, status:', response.status);
      return res.status(response.status)
                .json({ error: `Failed to fetch the target URL. Status: ${response.status}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const bodyText = $('body').text();

    // Collect images with resolved absolute URLs + store entire <img> HTML in snippet
    const images = [];
    $('img').each((i, el) => {
      let src = $(el).attr('src') || '';
      const alt = $(el).attr('alt') || '';
      const snippet = $.html(el).trim(); // entire <img> HTML

      try {
        src = new URL(src, url).toString();
      } catch (err) {
        // If URL parsing fails, keep src as-is
      }

      images.push({ src, alt, snippet });
    });

    // Group images by error type
    const errorGroups = {};
    images.forEach(image => {
      const imageErrors = validateAltText(image, bodyText, $);
      imageErrors.forEach(err => {
        if (!errorGroups[err.type]) {
          errorGroups[err.type] = [];
        }

        // Attach snippet, matchingElement, matchingSnippet, etc.
        const imgDetails = {
          src: image.src,
          alt: image.alt,
          snippet: image.snippet
        };

        // If "Matching Nearby Content" includes matchingElement or snippet
        if (err.type === "Matching Nearby Content") {
          if (err.matchingElement) {
            imgDetails.matchingElement = err.matchingElement;
          }
          if (err.matchingSnippet) {
            imgDetails.matchingSnippet = err.matchingSnippet;
          }
        }

        errorGroups[err.type].push(imgDetails);
      });
    });

    // Calculate totals
    const totalErrors = Object.values(errorGroups).reduce((sum, arr) => sum + arr.length, 0);
    const totalAlerts = ((errorGroups["Short Alt Text"] || []).length) + ((errorGroups["Long Alt Text"] || []).length);

    return res.status(200).json({
      totalImages: images.length,
      totalErrors,
      totalAlerts,
      errorGroups
    });

  } catch (error) {
    console.error('Error in scraping:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message
    });
  }
};
