const express = require('express');
const router = express.Router();
const searchService = require('../services/search.service');

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// GET /api/related/:videoId?title=&artist=
router.get('/related/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!ID_RE.test(videoId)) return res.status(400).json({ error: 'Invalid video ID' });

  const rawTitle  = String(req.query.title  || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  const rawArtist = String(req.query.artist || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);

  try {
    const items = await searchService.related(videoId, rawTitle, rawArtist);
    res.json({ items });
  } catch (err) {
    console.error('[route:related]', err.message);
    // Graceful fallback
    try {
      const items = await searchService.trending('pop');
      res.json({ items });
    } catch (_) {
      res.status(500).json({ error: 'Related fetch failed', items: [] });
    }
  }
});

module.exports = router;
