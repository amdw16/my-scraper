// api/scrape.js
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // node-fetch@2

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Missing "url" in request body.' });
    }

    // Note the headers block with a realistic User-Agent:
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Failed to fetch the target URL. Status: ${response.status}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

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
    return res.status(500).json({
      error: 'Internal server error',
      detail: error.message,
    });
  }
};
