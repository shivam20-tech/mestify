const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const env = require('../config/env');
const { getCache } = require('../config/redis');
const ytdlpProvider   = require('../providers/ytdlp.provider');
const youtubeiProvider = require('../providers/youtubei.provider');
const ytdlProvider    = require('../providers/ytdl.provider');

// ── Audio file cache dir ─────────────────────────────────────────────
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'mestify_audio');
if (!fs.existsSync(AUDIO_CACHE_DIR)) fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

function cleanAudioCache() {
  try {
    const files = fs.readdirSync(AUDIO_CACHE_DIR)
      .map(f => ({ f, p: path.join(AUDIO_CACHE_DIR, f), t: fs.statSync(path.join(AUDIO_CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(env.AUDIO_CACHE_MAX).forEach(({ p }) => { try { fs.unlinkSync(p); } catch (_) {} });
  } catch (_) {}
}
cleanAudioCache();
setInterval(cleanAudioCache, 30 * 60 * 1000);

// ── Concurrency semaphore (limits simultaneous yt-dlp processes) ─────
const _extractQueue = [];
let _activeExtractions = 0;

function acquireSlot() {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (_activeExtractions < env.PREFETCH_CONCURRENCY) {
        _activeExtractions++;
        resolve();
      } else {
        _extractQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot() {
  _activeExtractions--;
  if (_extractQueue.length > 0) _extractQueue.shift()();
}

// ── In-progress download lock ────────────────────────────────────────
const _downloading = new Set();

// ── Dead video cache ─────────────────────────────────────────────────
// Tracks video IDs that are genuinely unavailable (geo-blocked, Content ID, etc.)
// Prevents hammering all providers repeatedly for the same dead video.
const _deadVideos = new Map(); // videoId → expiresAt
const DEAD_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function isDeadVideo(id) {
  const exp = _deadVideos.get(id);
  if (!exp) return false;
  if (exp < Date.now()) { _deadVideos.delete(id); return false; }
  return true;
}

function markDead(id, reason) {
  _deadVideos.set(id, Date.now() + DEAD_TTL_MS);
  console.warn(`[stream] 🚫 ${id} marked unavailable for 6h (${reason})`);
}

// ── Redis cache key ──────────────────────────────────────────────────
const cacheKey = id => `stream:url:${id}`;

// ── Resolve stream URL (cache → yt-dlp → youtubei.js → ytdl-core) ────
async function resolveStreamUrl(videoId) {
  // Fast-fail: skip known unavailable videos
  if (isDeadVideo(videoId)) {
    throw new Error(`Video unavailable (cached 6h): ${videoId}`);
  }

  const cache = getCache();

  // 1. Cache hit
  const cached = await cache.get(cacheKey(videoId));
  if (cached) {
    try {
      console.log(`[stream] 🎯 cache hit → ${videoId}`);
      return JSON.parse(cached);
    } catch (_) {}
  }

  // 2. Acquire concurrency slot
  await acquireSlot();

  // 3. Double-check after acquiring (prevent duplicate extractions)
  const cachedAgain = await cache.get(cacheKey(videoId));
  if (cachedAgain) {
    releaseSlot();
    return JSON.parse(cachedAgain);
  }

  try {
    let info;

    // Chain: yt-dlp → youtubei.js → ytdl-core
    try {
      info = await ytdlpProvider.extract(videoId);
    } catch (e1) {
      console.warn(`[stream] yt-dlp failed → youtubei.js for ${videoId}`);
      try {
        info = await youtubeiProvider.extract(videoId);
        console.log(`[stream] ✅ youtubei.js succeeded for ${videoId}`);
      } catch (e2) {
        console.warn(`[stream] youtubei.js failed → ytdl-core for ${videoId}:`, e2.message.slice(0, 80));
        info = await ytdlProvider.extract(videoId);
      }
    }

    await cache.setex(cacheKey(videoId), env.STREAM_URL_TTL_SEC, JSON.stringify(info));
    return info;
  } catch (err) {
    // Cache unavailable/geo-blocked videos to stop retrying them
    const msg = err.message || '';
    if (
      msg.includes('Video unavailable') ||
      msg.includes('Sign in to confirm') ||
      msg.includes('This content isn') ||
      msg.includes('No streaming_data')
    ) {
      markDead(videoId, msg.slice(0, 60));
    }
    throw err;
  } finally {
    releaseSlot();
  }
}

async function invalidateStreamUrl(videoId) {
  await getCache().del(cacheKey(videoId));
}

// ── Serve a locally cached audio file with Range support ─────────────
function serveCachedFile(cacheFile, req, res) {
  const total = fs.statSync(cacheFile).size;
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = Math.max(0, parseInt(s, 10));
    const end = Math.min(parseInt(e) || total - 1, total - 1);
    if (start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'audio/mp4',
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(cacheFile, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(cacheFile).pipe(res);
  }
}

// ── Background prefetch (download full audio file) ────────────────────
async function startPrefetch(videoId) {
  const cacheFile = path.join(AUDIO_CACHE_DIR, `${videoId}.m4a`);
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 65536) return;
  if (_downloading.has(videoId)) return;

  _downloading.add(videoId);

  try {
    const { url: audioUrl, isHLS } = await resolveStreamUrl(videoId);
    if (isHLS || !audioUrl) { _downloading.delete(videoId); return; }

    const upstream = await axios({
      method: 'GET', url: audioUrl, responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.youtube.com', 'Referer': 'https://www.youtube.com/' },
      timeout: 90000,
    });

    const tmpPath = cacheFile + '.tmp';
    const tmp = fs.createWriteStream(tmpPath);
    upstream.data.pipe(tmp);

    tmp.on('finish', () => {
      try { fs.renameSync(tmpPath, cacheFile); console.log(`[prefetch] ✅ saved ${videoId}`); }
      catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
      _downloading.delete(videoId);
    });
    tmp.on('error', () => { _downloading.delete(videoId); try { fs.unlinkSync(tmpPath); } catch (_) {} });
  } catch (e) {
    _downloading.delete(videoId);
    console.warn(`[prefetch] ❌ ${videoId}:`, e.message);
  }
}

module.exports = {
  resolveStreamUrl,
  invalidateStreamUrl,
  serveCachedFile,
  startPrefetch,
  AUDIO_CACHE_DIR,
  _downloading,
};
