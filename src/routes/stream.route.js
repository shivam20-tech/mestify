const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const router = express.Router();

const streamService = require('../services/stream.service');
const { AUDIO_CACHE_DIR, _downloading } = streamService;

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': '*/*',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/',
};

// GET /api/stream-url/:id  →  { url, isHLS }
router.get('/stream-url/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    const { url, isHLS } = await streamService.resolveStreamUrl(id);
    res.json({ url, isHLS });
  } catch (e) {
    console.error('[route:stream-url]', e.message);
    res.status(500).json({ error: 'Could not resolve audio URL' });
  }
});

// GET /api/prewarm/:id  →  202 (fire-and-forget URL resolution)
router.get('/prewarm/:id', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.sendStatus(400);
  res.sendStatus(202);
  streamService.resolveStreamUrl(id).catch(() => {});
});

// GET /api/prefetch/:id  →  202 (fire-and-forget full audio download)
router.get('/prefetch/:id', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.sendStatus(400);
  res.sendStatus(202);
  streamService.startPrefetch(id).catch(() => {});
});

// GET /api/stream/:id  →  audio stream with Range support
router.get('/stream/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video ID' });

  const cacheFile = path.join(AUDIO_CACHE_DIR, `${id}.m4a`);

  // 1. Local file cache hit
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 65536) {
    console.log(`[stream:cache] ${id}`);
    return streamService.serveCachedFile(cacheFile, req, res);
  }

  // 2. Resolve URL
  let audioUrl, isHLS;
  try {
    ({ url: audioUrl, isHLS } = await streamService.resolveStreamUrl(id));
  } catch (e) {
    console.error('[stream] URL resolve failed:', e.message);
    return res.status(500).json({ error: 'Could not resolve audio. Please retry.' });
  }

  const rangeHeader = req.headers.range;

  // 3. Non-HLS: proxy with range support + background save
  if (!isHLS) {
    const upHdr = { ...UPSTREAM_HEADERS };
    if (rangeHeader) upHdr['Range'] = rangeHeader;

    try {
      const upstream = await axios({ method: 'GET', url: audioUrl, responseType: 'stream', headers: upHdr, timeout: 30000 });
      const status = (rangeHeader && upstream.status === 206) ? 206 : 200;
      const mime = upstream.headers['content-type']?.split(';')[0] || 'audio/mp4';
      const fwdH = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };
      if (upstream.headers['content-length']) fwdH['Content-Length'] = upstream.headers['content-length'];
      if (upstream.headers['content-range']) fwdH['Content-Range'] = upstream.headers['content-range'];
      res.writeHead(status, fwdH);
      console.log(`[stream:direct] ${id} ${status}`);

      if (!rangeHeader) {
        // Stream to client AND save to disk simultaneously
        const tmpPath = cacheFile + '.tmp';
        const tmp = fs.existsSync(tmpPath) ? null : fs.createWriteStream(tmpPath);
        let alive = true;
        req.on('close', () => { alive = false; });

        upstream.data.on('data', chunk => {
          if (!res.writableEnded) res.write(chunk);
          if (tmp) tmp.write(chunk);
        });
        upstream.data.on('end', () => {
          if (tmp) tmp.end(() => {
            if (alive) { try { fs.renameSync(tmpPath, cacheFile); } catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) {} } }
            else { try { fs.unlinkSync(tmpPath); } catch (_) {} }
          });
          if (!res.writableEnded) res.end();
        });
        upstream.data.on('error', () => { if (tmp) { try { fs.unlinkSync(tmpPath); } catch (_) {} } });
      } else {
        upstream.data.pipe(res);
        req.on('close', () => upstream.data.destroy());
      }
      return;
    } catch (e) {
      console.warn('[stream:direct] failed:', e.message);
      await streamService.invalidateStreamUrl(id);
      if (res.headersSent) return;
    }
  }

  // 4. HLS fallback: spawn yt-dlp piped stdout
  const { spawn } = require('child_process');
  const env = require('../config/env');
  const cookiesPath = path.join(process.cwd(), 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);

  const args = [
    ...(hasCookies ? ['--cookies', cookiesPath] : []),
    '--extractor-args', 'youtube:player_client=android',
    '--no-playlist', '--quiet', '--no-progress', '--no-warnings',
    '-f', '18/bestaudio/best', '-o', '-',
    `https://www.youtube.com/watch?v=${id}`,
  ];

  let proc;
  try { proc = spawn(env.YTDLP_PATH, args); }
  catch (e) { return res.status(500).json({ error: 'yt-dlp not found' }); }

  res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache' });

  const tmpPath = cacheFile + '.tmp';
  const tmp = fs.existsSync(tmpPath) ? null : fs.createWriteStream(tmpPath);
  let ok = true;

  proc.stdout.on('data', chunk => { if (!res.writableEnded) res.write(chunk); if (tmp) tmp.write(chunk); });
  proc.stderr.on('data', () => {});
  req.on('close', () => { ok = false; proc.kill('SIGKILL'); });
  proc.on('close', code => {
    if (tmp) tmp.end(() => {
      if (ok && code === 0) { try { fs.renameSync(tmpPath, cacheFile); } catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) {} } }
      else { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    });
    if (!res.writableEnded) res.end();
  });
  console.log(`[stream:hls] piping ${id}`);
});

module.exports = router;
