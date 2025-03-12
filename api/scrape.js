// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch');

/**
 * Vercel serverless function
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    // 1. Fetch the page
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch the target URL.' });
    }

    const html = await response.text();

    // 2. Parse HTML with Cheerio
    const $ = cheerio.load(html);

    // 3. Collect images
    const images = [];
    $('img').each((i, el) => {
      images.push({
        src: $(el).attr('src') || '',
        alt: $(el).attr('alt') || '',
      });
    });

    return res.status(200).json({
      success: true,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error('Error in scraping:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
};
