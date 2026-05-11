const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const ytmusic = require('../providers/ytmusic.provider');

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ytmusicReady: ytmusic.isReady(),
    time: new Date(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

router.get('/ping', (_req, res) => res.send('ok'));

router.get('/python-check', (_req, res) => {
  exec('python3 --version', (err, stdout, stderr) => {
    if (err) return res.json({ error: err.message, stderr });
    res.json({ python: stdout });
  });
});

module.exports = router;
