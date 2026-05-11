const express = require('express');
const router = express.Router();
const searchService = require('../services/search.service');
const axios = require('axios');

// GET /api/suggest?q=
router.get('/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const { data } = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'firefox', ds: 'yt', q },
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    res.json({ suggestions: (data[1] || []).slice(0, 8) });
  } catch (_) {
    res.json({ suggestions: [] });
  }
});

// GET /api/search?q=
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const items = await searchService.search(q);
    res.json({ items });
  } catch (err) {
    console.error('[route:search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/trending?genre=pop
router.get('/trending', async (req, res) => {
  const { genre = 'pop' } = req.query;
  try {
    const items = await searchService.trending(genre);
    res.json({ items });
  } catch (err) {
    console.error('[route:trending]', err.message);
    res.status(500).json({ error: 'Trending failed' });
  }
});

module.exports = router;
