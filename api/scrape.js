// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // Using node-fetch@2 in CommonJS

// Helper function: validate alt text and return an array of error objects.
// For the "Matching Nearby Content" error, include a snippet.
function validateAltText(image, bodyText) {
  const errors = [];
  const alt = image.alt.trim();

  // Rule 1: Missing Alt Text
  if (!alt) {
    errors.push({ type: "Missing Alt Text", message: "This image is missing an alt text description needed for accessibility." });
  }

  // Rule 2: Alt Text as an Image File Name
  const srcFileName = image.src.split('/').pop().split('.')[0];
  if (alt && alt.toLowerCase() === srcFileName.toLowerCase()) {
    errors.push({ type: "Alt Text as an Image File Name", message: "The alt text is simply the file name, which doesn’t describe the image." });
  }

  // Rule 3: Short Alt Text (less than 10 characters)
  if (alt && alt.length < 10) {
    errors.push({ type: "Short Alt Text", message: "The alt text is too short to provide a meaningful description." });
  }

  // Rule 4: Long Alt Text (more than 100 characters)
  if (alt && alt.length > 100) {
    errors.push({ type: "Long Alt Text", message: "The alt text is excessively long, which can confuse users and dilute clarity." });
  }

  // Rule 5: Matching Nearby Content
  // If the alt text appears in the page's body text, we consider that an error.
  if (bodyText && alt && bodyText.toLowerCase().includes(alt.toLowerCase())) {
    // Try to extract a snippet: 50 characters before and after the alt text occurrence
    const altLower = alt.toLowerCase();
    const bodyLower = bodyText.toLowerCase();
    const idx = bodyLower.indexOf(altLower);
    let snippet = "";
    if (idx !== -1) {
      snippet = bodyText.substring(Math.max(0, idx - 50), idx + alt.length + 50);
    }
    errors.push({ type: "Matching Nearby Content", message: "The alt text duplicates nearby text, offering no additional image context.", snippet });
  }

  // Rule 6: Random Characters
  // A simple heuristic: if the alt text is 10+ characters with no spaces, treat it as random.
  if (/^[a-zA-Z0-9]{10,}$/.test(alt)) {
    errors.push({ type: "Random Characters", message: "The alt text is a string of random characters that fails to describe the image." });
  }

  // Rule 7: Keyword String
  // If the alt text contains commas and looks like a list.
  if (alt.split(',').length > 1) {
    errors.push({ type: "Keyword String", message: "The alt text is just a list of keywords instead of a coherent description." });
  }

  return errors;
}

module.exports = async (req, res) => {
  // Only allow POST requests.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // Get URL from request body.
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    // Fetch the target page with realistic headers.
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      return res.status(response.status)
                .json({ error: `Failed to fetch the target URL. Status: ${response.status}` });
    }

    // Get the full HTML.
    const html = await response.text();

    // Load HTML into Cheerio.
    const $ = cheerio.load(html);

    // Extract the inner HTML of the <body> and also its text content.
    const bodyContent = $('body').html();
    const bodyText = $('body').text();

    // Collect images.
    const images = [];
    $('img').each((i, el) => {
      const src = $(el).attr('src') || '';
      const alt = $(el).attr('alt') || '';
      images.push({ src, alt });
    });

    // Now, group images by error type.
    const errorGroups = {};

    images.forEach(image => {
      const imageErrors = validateAltText(image, bodyText);
      // For each error found, add the image info (and snippet if available) to the corresponding group.
      imageErrors.forEach(err => {
        // Initialize the group if it doesn't exist.
        if (!errorGroups[err.type]) {
          errorGroups[err.type] = [];
        }
        // Create an object with image details.
        const imgDetails = { src: image.src, alt: image.alt };
        // If this error type is "Matching Nearby Content", also include the snippet.
        if (err.type === "Matching Nearby Content" && err.snippet) {
          imgDetails.snippet = err.snippet;
        }
        errorGroups[err.type].push(imgDetails);
      });
    });

    // Return a JSON response grouping images by error.
    return res.status(200).json({
      success: true,
      totalImages: images.length,
      errorGroups,
      body: bodyContent // inner HTML of <body>
    });
  } catch (error) {
    console.error('Error in scraping:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message
    });
  }
};
