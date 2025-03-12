// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // Using node-fetch@2 in CommonJS

// Helper function to validate alt text and return an array of error messages.
function validateAltText(image, bodyText) {
  const errors = [];
  const alt = image.alt.trim();

  // Rule 1: Missing Alt Text
  if (!alt) {
    errors.push("Missing Alt Text: This image is missing an alt text description needed for accessibility.");
  }

  // Rule 2: Alt Text as an Image File Name
  const srcFileName = image.src.split('/').pop().split('.')[0];
  if (alt && alt.toLowerCase() === srcFileName.toLowerCase()) {
    errors.push("Alt Text as an Image File Name: The alt text is simply the file name, which doesn’t describe the image.");
  }

  // Rule 3: Short Alt Text (less than 10 characters)
  if (alt && alt.length < 10) {
    errors.push("Short Alt Text: The alt text is too short to provide a meaningful description.");
  }

  // Rule 4: Long Alt Text (more than 100 characters)
  if (alt && alt.length > 100) {
    errors.push("Long Alt Text: The alt text is excessively long, which can confuse users and dilute clarity.");
  }

  // Rule 5: Matching Nearby Content
  // Check if the alt text appears in the page's body text.
  if (bodyText && alt && bodyText.toLowerCase().includes(alt.toLowerCase())) {
    errors.push("Matching Nearby Content: The alt text duplicates nearby text, offering no additional image context.");
  }

  // Rule 6: Random Characters
  // (A simple heuristic: if the alt text consists of 10 or more alphanumeric characters with no spaces)
  if (/^[a-zA-Z0-9]{10,}$/.test(alt)) {
    errors.push("Random Characters: The alt text is a string of random characters that fails to describe the image.");
  }

  // Rule 7: Keyword String
  // (If the alt text contains commas and seems like a list rather than a sentence)
  if (alt.split(',').length > 1) {
    errors.push("Keyword String: The alt text is just a list of keywords instead of a coherent description.");
  }

  return errors;
}

module.exports = async (req, res) => {
  // Only allow POST requests.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // Get the URL from the request body.
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    // Fetch the target page with realistic browser headers.
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      return res.status(response.status)
                .json({ error: `Failed to fetch the target URL. Status: ${response.status}` });
    }

    // Get the full HTML response.
    const html = await response.text();

    // Load the HTML into Cheerio.
    const $ = cheerio.load(html);

    // Extract the inner HTML of the <body>.
    const bodyContent = $('body').html();
    // Also get the text content for validation.
    const bodyText = $('body').text();

    // Collect all images along with their src, alt, and errors.
    const images = [];
    $('img').each((i, el) => {
      const src = $(el).attr('src') || '';
      const alt = $(el).attr('alt') || '';
      const image = { src, alt };
      // Validate the alt text against our rules.
      const errors = validateAltText(image, bodyText);
      image.errors = errors;
      images.push(image);
    });

    // Return the JSON response with images and the body content.
    return res.status(200).json({
      success: true,
      count: images.length,
      images,
      body: bodyContent
    });
  } catch (error) {
    console.error('Error in scraping:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message
    });
  }
};
