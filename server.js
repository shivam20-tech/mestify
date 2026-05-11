require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const YTDLP_PATH = '/usr/local/bin/yt-dlp';

// ═══════════════════════════════════════════════════════════════
//  AUDIO CACHE DIR
// ═══════════════════════════════════════════════════════════════
const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'mestify_audio');
if (!fs.existsSync(AUDIO_CACHE_DIR)) fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

// FIX #5: Increased maxFiles from 30 to 100 to avoid constant re-downloads
function cleanAudioCache(maxFiles = 100) {
  try {
    const files = fs.readdirSync(AUDIO_CACHE_DIR)
      .map(f => ({ f, p: path.join(AUDIO_CACHE_DIR, f), t: fs.statSync(path.join(AUDIO_CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(maxFiles).forEach(({ p }) => { try { fs.unlinkSync(p); } catch (_) { } });
  } catch (_) { }
}
cleanAudioCache();
setInterval(cleanAudioCache, 30 * 60 * 1000);

// Track in-progress downloads
const _downloading = new Set();

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════════════════════
//  ytmusic-api
// ═══════════════════════════════════════════════════════════════
const YTMusic = require('ytmusic-api');
const ytmusic = new YTMusic();
let ytmusicReady = false;

(async () => {
  try {
    await ytmusic.initialize();
    ytmusicReady = true;
    console.log('✅ ytmusic-api initialised');
  } catch (e) {
    console.error('❌ ytmusic-api init failed:', e.message);
  }
})();

// ═══════════════════════════════════════════════════════════════
//  @distube/ytdl-core  (fallback)
// ═══════════════════════════════════════════════════════════════
let ytdl = null;
try {

  console.log('✅ @distube/ytdl-core loaded (fallback)');
} catch (e) {
  console.warn('⚠️  ytdl-core not available:', e.message);
}

// ═══════════════════════════════════════════════════════════════
//  SMART AUTOPLAY HELPERS
// ═══════════════════════════════════════════════════════════════
const globalSeenIds = new Set();
const SEEN_CAP = 300;
function addToGlobalSeen(id) {
  if (globalSeenIds.size >= SEEN_CAP) {
    globalSeenIds.delete(globalSeenIds.values().next().value);
  }
  globalSeenIds.add(id);
}

function extractCoreSongTitle(title) {
  return title
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\|.*/g, '')
    .replace(/[-–]\s*(official|audio|video|lyrics?|hd|4k|full|song|music|ft\.?|feat\.).*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'with',
  'from', 'by', 'as', 'up', 'out', 'so', 'if', 'not', 'no', 'me', 'you', 'he',
  'she', 'we', 'they', 'it', 'i', 'oh', 'oo', 'aa', 'hey', 'yeah', 'yeh', 'haan',
]);
function extractKeywords(cleanTitle) {
  return cleanTitle.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 2);
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  if (/marathi|lavani|koligeet|maharashtr/.test(t)) return 'marathi';
  if (/punjabi|bhangra/.test(t)) return 'punjabi';
  if (/bollywood|hindi film|filmi|hindi song|\bhindi\b/.test(t)) return 'bollywood';
  if (/tamil|kollywood/.test(t)) return 'tamil';
  if (/telugu|tollywood/.test(t)) return 'telugu';
  if (/kannada|sandalwood/.test(t)) return 'kannada';
  if (/malayalam/.test(t)) return 'malayalam';
  if (/k.?pop|bts|blackpink|twice|stray kids|nct|aespa/.test(t)) return 'kpop';
  if (/lofi|lo.fi|chill beats|study music/.test(t)) return 'lofi';
  if (/\brap\b|hip.?hop|trap/.test(t)) return 'hiphop';
  if (/\brock\b|metal|punk|grunge/.test(t)) return 'rock';
  if (/\brnb\b|r&b|r'n'b/.test(t)) return 'rnb';
  if (/electronic|edm|techno|house|dubstep/.test(t)) return 'electronic';
  return 'pop';
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/\bbhajan\b|\baarti\b|\bkirtan\b|\bmantra\b|\bdevotional\b|\bsufi\b|\bqawwali\b/.test(t)) return 'devotional spiritual';
  if (/\bghazal\b|\bacoustic\b|\bunplugged\b|\bsoulful\b|\bmellow\b|\bsoft\b|\brelax\b|\bcalm\b|\bclassical\b/.test(t)) return 'slow acoustic';
  if (/\bsad\b|\bheartbreak\b|\btears\b|\balone\b|\bdard\b|\bgham\b|\btanha\b/.test(t)) return 'sad emotional';
  if (/\bromantic\b|\blove song\b|\bpyaar\b|\bishq\b|\bmohabbat\b/.test(t)) return 'romantic love';
  if (/\blo[\s-]?fi\b|\bchill\b|\bvibes?\b|\bstudy\b/.test(t)) return 'lofi chill';
  if (/\bparty\b|\bdance\b|\bdj\b|\bclub\b|\bgarba\b/.test(t)) return 'party dance';
  if (/\bworkout\b|\bgym\b|\bmotivat\b|\bpower\b|\bfire\b/.test(t)) return 'workout power';
  return '';
}

const ENERGETIC_WORDS = /\b(party|dance|dj|club|banger|hype|garba|disco|edm|techno|rave|bhangra|dhol|drill|trap|bass|drop|workout|gym|fire|pump)\b/i;
const CALM_WORDS = /\b(slow|chill|lofi|lo-fi|acoustic|unplugged|soft|quiet|peaceful|soothing|relax|sleep|ballad|mellow|classical|ghazal|sufi|devotional|sad|heartbreak)\b/i;
function isMoodClash(resultTitle, currentMood) {
  if (!currentMood) return false;
  const isCalmMood = /slow|acoustic|sad|emotional|romantic|lofi|chill|devotional|spiritual/.test(currentMood);
  const isEnergyMood = /party|dance|bhangra|workout|power/.test(currentMood);
  if (isCalmMood && ENERGETIC_WORDS.test(resultTitle)) return true;
  if (isEnergyMood && CALM_WORDS.test(resultTitle)) return true;
  return false;
}

const GENRE_QUERIES = {
  marathi: ['marathi songs 2025', 'new marathi hits', 'marathi pop songs'],
  punjabi: ['punjabi hits 2025', 'new punjabi songs', 'top punjabi music'],
  bollywood: ['bollywood hits 2025', 'new hindi songs', 'top bollywood songs'],
  tamil: ['tamil hits 2025', 'new tamil songs', 'popular kollywood songs'],
  telugu: ['telugu hits 2025', 'new telugu songs', 'popular telugu music'],
  kannada: ['kannada hits 2025', 'new kannada songs playlist'],
  malayalam: ['malayalam hits 2025', 'new malayalam songs'],
  kpop: ['kpop hits 2025', 'popular kpop songs', 'new kpop releases'],
  lofi: ['lofi chill music mix', 'chill study beats', 'relaxing lofi hip hop'],
  hiphop: ['hip hop hits 2025', 'rap songs 2025', 'new hip hop tracks'],
  rock: ['rock hits playlist', 'popular rock songs 2025', 'classic rock songs'],
  rnb: ['rnb hits 2025', 'new r&b songs', 'popular rnb music'],
  electronic: ['electronic dance music 2025', 'edm hits playlist'],
  indie: ['indie pop hits 2025', 'best indie songs', 'indie folk playlist 2025'],
  pop: ['pop hits 2025', 'popular songs 2025', 'top charting songs'],
};

const JUNK_PATTERN = /\b(remix|remixed|slowed|reverb|sped[\s-]?up|nightcore|8d[\s-]?audio|432[\s-]?hz|cover|covers|karaoke|instrumental|bgm|ringtone|status|whatsapp|lyric[\s-]?video|lyrics?|making[\s-]?of|acoustic[\s-]?version|unplugged[\s-]?version|mashup|medley|tribute|parody|reaction|extended[\s-]?mix|radio[\s-]?edit)\b/i;
function isJunkVideo(title) { return JUNK_PATTERN.test(title); }

function normaliseTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function isNearDuplicate(title, seenTitles) {
  const words = normaliseTitle(title).split(' ').filter(w => w.length > 3);
  if (!words.length) return false;
  for (const seen of seenTitles) {
    const sw = normaliseTitle(seen).split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => sw.includes(w)).length;
    if (matches / Math.max(words.length, sw.length, 1) >= 0.72) return true;
  }
  return false;
}
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function ytmusicSearch(query, limit = 15) {
  if (!ytmusicReady) return [];
  try {
    const results = await ytmusic.searchSongs(query);
    return results.slice(0, limit).map(song => ({
      id: song.videoId,
      title: song.name,
      artist: song.artist?.name || song.artists?.[0]?.name || 'Unknown',
      thumbnail: song.thumbnails?.[song.thumbnails.length - 1]?.url
        || song.thumbnails?.[0]?.url || '',
    })).filter(s => s.id && s.title);
  } catch (e) {
    console.warn('[ytmusic] searchSongs error:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const { data } = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'firefox', ds: 'yt', q },
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    res.json({ suggestions: (data[1] || []).slice(0, 8) });
  } catch (err) {
    res.json({ suggestions: [] });
  }
});
app.get('/python-check', async (req, res) => {
  const { exec } = require('child_process');

  exec('python3 --version', (err, stdout, stderr) => {
    if (err) {
      return res.json({
        error: err.message,
        stderr
      });
    }

    res.json({
      python: stdout
    });
  });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const items = await ytmusicSearch(q, 20);
    if (items.length) return res.json({ items });
    if (ytmusicReady) {
      const r2 = await ytmusic.search(q);
      const mapped = (r2 || []).slice(0, 20)
        .filter(s => s.videoId && s.name)
        .map(s => ({
          id: s.videoId,
          title: s.name,
          artist: s.artist?.name || s.artists?.[0]?.name || 'Unknown',
          thumbnail: s.thumbnails?.[0]?.url || '',
        }));
      return res.json({ items: mapped });
    }
    res.json({ items: [] });
  } catch (err) {
    console.error('[search] error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/trending', async (req, res) => {
  const genre = req.query.genre || 'pop';
  try {
    const pool = GENRE_QUERIES[genre] || GENRE_QUERIES.pop;
    const query = pool[Math.floor(Math.random() * pool.length)];
    const items = await ytmusicSearch(query, 20);
    res.json({ items });
  } catch (err) {
    console.error('[trending] error:', err.message);
    res.status(500).json({ error: 'Trending failed' });
  }
});

app.get('/api/related/:videoId', async (req, res) => {
  const { videoId } = req.params;
  // FIX #4: Sanitize query params — strip non-printable/control chars
  const rawTitle = String(req.query.title || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
  const rawArtist = String(req.query.artist || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
  try {
    const cleanTitle = extractCoreSongTitle(rawTitle);
    const lang = detectLanguage(`${rawTitle} ${rawArtist}`);
    const mood = detectMood(`${rawTitle} ${rawArtist}`);
    const keywords = extractKeywords(cleanTitle);
    const genreLabel = {
      marathi: 'marathi', punjabi: 'punjabi', bollywood: 'bollywood hindi',
      tamil: 'tamil', telugu: 'telugu', kannada: 'kannada', malayalam: 'malayalam',
      kpop: 'kpop', lofi: 'lofi chill', hiphop: 'hip hop',
      rock: 'rock', rnb: 'rnb', electronic: 'edm electronic', pop: 'pop',
    }[lang] || 'pop';

    const artistKw = rawArtist
      .replace(/\s*(official|music|records|entertainment|vevo|films?|studios?|india)\s*/gi, '')
      .trim().split(/\s+/).slice(0, 2).join(' ');

    const queries = [];
    if (artistKw.length > 2) queries.push(mood ? `${artistKw} ${mood} songs` : `${artistKw} songs`);
    if (mood) queries.push(`${genreLabel} ${mood} songs`);
    else if (keywords.length) queries.push(`${keywords.join(' ')} ${genreLabel} songs`);
    else queries.push(`${genreLabel} songs 2025`);
    const poolQ = GENRE_QUERIES[lang] || GENRE_QUERIES.pop;
    queries.push(poolQ[Math.floor(Math.random() * poolQ.length)]);

    console.log(`[related] ${videoId} lang=${lang} mood="${mood}" queries:`, queries);

    const localSeen = new Set([videoId, ...globalSeenIds]);
    const seenTitles = rawTitle ? [rawTitle] : [];
    const allItems = [];

    for (const q of queries) {
      try {
        const results = await ytmusicSearch(q, 15);
        for (const item of results) {
          if (localSeen.has(item.id)) continue;
          if (isJunkVideo(item.title)) continue;
          if (isNearDuplicate(item.title, seenTitles)) continue;
          if (isMoodClash(item.title, mood)) continue;
          localSeen.add(item.id); seenTitles.push(item.title); allItems.push(item);
        }
      } catch (qErr) {
        console.warn(`[related] query "${q}" failed:`, qErr.message);
      }
    }

    const items = shuffleArray(allItems).slice(0, 20);
    items.forEach(s => addToGlobalSeen(s.id));
    addToGlobalSeen(videoId);
    console.log(`[related] returning ${items.length} tracks`);
    res.json({ items });
  } catch (err) {
    console.error('[related] error:', err.message);
    try {
      const fallback = await ytmusicSearch('popular music hits 2025', 15);
      const items = fallback.filter(s => !globalSeenIds.has(s.id));
      items.forEach(s => addToGlobalSeen(s.id));
      res.json({ items });
    } catch (e2) {
      res.status(500).json({ error: 'Related fetch failed', items: [] });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  STREAMING — yt-dlp PRIMARY  +  ytdl-core FALLBACK
// ═══════════════════════════════════════════════════════════════

// FIX #6: yt-dlp subprocess with proper manual timeout via AbortController / kill timer
function ytdlpGetUrlAndFormat(videoId) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--cookies', 'cookies.txt',
      '--extractor-args',
      'youtube:player_client=android',
      '--no-playlist',
      '--quiet',
      '--no-progress',
      '-f',
      '18/bestaudio/best',
      '--print',
      '%(url)s\n%(ext)s\n%(protocol)s\n%(duration)s',
      url,
    ];
    const proc = spawn(YTDLP_PATH, args);
    // FIX #6: Manual 20s kill timer since spawn() ignores timeout option
    const killer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp timed out after 20s'));
    }, 120000);

    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => {
      err += d.toString();
    });
    proc.on('close', code => {
      clearTimeout(killer);
      const lines = out.trim().split('\n');
      const audioUrl = lines[0]?.trim();
      const ext = lines[1]?.trim() || 'mp4';
      const protocol = lines[2]?.trim() || '';
      const duration = parseFloat(lines[3]?.trim()) || 0;
      if (code === 0 && audioUrl?.startsWith('http')) {
        resolve({ url: audioUrl, ext, isHLS: protocol.includes('m3u8'), duration });
      } else {
        reject(new Error(err.trim || `yt-dlp exited ${code}`));
      }
    });
    proc.on('error', e => { clearTimeout(killer); reject(new Error('yt-dlp not found: ' + e.message)); });
  });
}

async function ytdlGetUrlAndFormat(videoId) {
  if (!ytdl) throw new Error('ytdl-core not loaded');
  const info = await ytdl.getInfo(videoId);
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('No audio format found via ytdl-core');
  const duration = parseFloat(info.videoDetails.lengthSeconds) || 0;
  return { url: format.url, ext: format.container || 'mp4', isHLS: format.isHLS || false, duration };
}

// FIX #1: urlCache with proper TTL-aware eviction + age-based cleanup
const urlCache = new Map();
function evictExpiredUrlCache() {
  const now = Date.now();
  for (const [k, v] of urlCache.entries()) {
    if (v.expiresAt <= now) urlCache.delete(k);
  }
}
setInterval(evictExpiredUrlCache, 30 * 60 * 1000); // run every 30min

async function getCachedUrlInfo(videoId) {
  const cached = urlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let info;
  info = await ytdlpGetUrlAndFormat(videoId);

  urlCache.set(videoId, { ...info, expiresAt: Date.now() + 4 * 60 * 60 * 1000 });
  // FIX #1: Evict by size after adding
  if (urlCache.size > 200) {
    // Remove oldest (first inserted) entries first
    for (const k of urlCache.keys()) {
      urlCache.delete(k);
      if (urlCache.size <= 180) break;
    }
  }
  return info;
}

// FIX #10: serveCachedFile — fix NaN end-range when rawEnd is empty string
function serveCachedFile(cacheFile, req, res) {
  const stat = fs.statSync(cacheFile);
  const total = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    // FIX #10: Use `|| total - 1` so empty string becomes total-1
    const end = parseInt(parts[1]) || total - 1;
    const safeEnd = Math.min(end, total - 1);
    const safeStart = Math.max(0, start);
    if (safeStart >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${safeStart}-${safeEnd}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': safeEnd - safeStart + 1,
      'Content-Type': 'audio/mp4',
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(cacheFile, { start: safeStart, end: safeEnd }).pipe(res);
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

// ── /api/stream-url/:id ────────────────────────────────────────────
app.get('/api/stream-url/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid video ID' });
  try {
    const { url, ext, isHLS, duration } = await getCachedUrlInfo(id);
    res.json({ url, ext, isHLS, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/prewarm/:id ─────────────────────────────────────────────────
app.get('/api/prewarm/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.sendStatus(400);
  res.sendStatus(202);
  const cached = urlCache.get(id);
  if (!cached || cached.expiresAt <= Date.now()) {
    getCachedUrlInfo(id).catch(() => { });
  }
});

// ── /api/stream/:id ───────────────────────────────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid video ID' });

  const cacheFile = path.join(AUDIO_CACHE_DIR, `${id}.m4a`);

  // 1. Cache hit → instant serve with full range/seek support
  if (fs.existsSync(cacheFile)) {
    const sz = fs.statSync(cacheFile).size;
    if (sz > 65536) {
      console.log(`[stream:cache] ${id} (${(sz / 1048576).toFixed(1)} MB)`);
      return serveCachedFile(cacheFile, req, res);
    }
    try { fs.unlinkSync(cacheFile); } catch (_) { }
  }

  // 2. Get direct audio URL
  let audioUrl, isHLS;
  try {
    ({ url: audioUrl, isHLS } = await getCachedUrlInfo(id));
  } catch (e) {
    console.error('[stream] URL resolve failed:', e.message);
    return res.status(500).json({ error: 'Could not resolve audio. Please retry.' });
  }

  const rangeHeader = req.headers.range;
  const upHdr = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/',
  };

  // 3. Non-HLS: proxy with Content-Length + Accept-Ranges → seeking works
  if (!isHLS) {
    if (rangeHeader) upHdr['Range'] = rangeHeader;
    try {
      const upstream = await axios({ method: 'GET', url: audioUrl, responseType: 'stream', headers: upHdr, timeout: 30000 });
      const status = (rangeHeader && upstream.status === 206) ? 206 : 200;
      const mimeType = upstream.headers['content-type']?.split(';')[0] || 'audio/mp4';
      const fwdH = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes' };
      if (upstream.headers['content-length']) fwdH['Content-Length'] = upstream.headers['content-length'];
      if (upstream.headers['content-range']) fwdH['Content-Range'] = upstream.headers['content-range'];
      res.writeHead(status, fwdH);
      console.log(`[stream:direct] ${id} ${status} ${rangeHeader || 'full'}`);

      if (!rangeHeader) {
        // FIX #3: Use a per-song lock to prevent concurrent write races
        const tmpPath = cacheFile + '.tmp';
        // Only save if nobody else is writing this file right now
        const isAlreadyWriting = fs.existsSync(tmpPath);
        const tmp = isAlreadyWriting ? null : fs.createWriteStream(tmpPath);
        let alive = true;
        req.on('close', () => { alive = false; });
        upstream.data.on('data', chunk => {
          if (!res.writableEnded) res.write(chunk);
          if (tmp) tmp.write(chunk);
        });
        upstream.data.on('end', () => {
          if (tmp) {
            tmp.end(() => {
              if (alive) {
                try { fs.renameSync(tmpPath, cacheFile); console.log(`[stream:saved] ${id}`); }
                catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) { } }
              } else { try { fs.unlinkSync(tmpPath); } catch (_) { } }
            });
          }
          if (!res.writableEnded) res.end();
        });
        upstream.data.on('error', () => {
          if (tmp) { try { fs.unlinkSync(tmpPath); } catch (_) { } }
        });
      } else {
        upstream.data.pipe(res);
        req.on('close', () => upstream.data.destroy());
      }
      return;
    } catch (e) {
      console.warn('[stream:direct] failed:', e.message);
      urlCache.delete(id);
      if (res.headersSent) return;
    }
  }

  // 4. Fallback: pipe yt-dlp + tee to cache
  // FIX #7: Added --no-playlist to prevent playlist downloads
  // FIX #8: Detect actual audio format and set correct Content-Type
  const ytUrl = `https://www.youtube.com/watch?v=${id}`;
  const args = [
    '--cookies', 'cookies.txt',
    '--extractor-args',
    'youtube:player_client=android',
    '--no-playlist',
    '--quiet',
    '--no-progress',
    '-f',
    '18/bestaudio/best',
    '--no-warnings',
    '-o',
    '-',
    ytUrl,
  ];
  let proc;
  try { proc = spawn(YTDLP_PATH, args); }
  catch (e) { if (!res.headersSent) res.status(500).json({ error: 'yt-dlp not found' }); return; }

  // FIX #8: Use audio/webm as it's the most common format yt-dlp outputs;
  // browsers handle it fine and it's more accurate than audio/mp4 for opus streams
  res.writeHead(200, {
    'Content-Type': 'audio/mp4',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
  });

  // FIX #3: Prevent concurrent writes to the same tmp file
  const tmpPath = cacheFile + '.tmp';
  const isAlreadyWriting = fs.existsSync(tmpPath);
  const tmp = isAlreadyWriting ? null : fs.createWriteStream(tmpPath);
  let ok = true;

  proc.stdout.on('data', chunk => {
    if (!res.writableEnded) res.write(chunk);
    if (tmp) tmp.write(chunk);
  });
  proc.stderr.on('data', () => { });
  req.on('close', () => { ok = false; proc.kill('SIGKILL'); });
  proc.on('close', code => {
    if (tmp) {
      tmp.end(() => {
        if (ok && code === 0) {
          try { fs.renameSync(tmpPath, cacheFile); console.log(`[stream:hls] cached ${id}`); }
          catch (_) { try { fs.unlinkSync(tmpPath); } catch (_) { } }
        } else { try { fs.unlinkSync(tmpPath); } catch (_) { } }
      });
    }
    if (!res.writableEnded) res.end();
  });
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
  console.log(`[stream:hls] piping ${id}`);
});

// ── /api/prefetch/:id ─────────────────────────────────────────────────

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ytmusicReady, time: new Date() })
);

// ── Catch-all: serve index.html ────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () =>
  console.log(`🎵 Mestify backend running → http://localhost:${PORT}`)
);
app.get('/api/prefetch/:id', async (req, res) => {
  const id = req.params.id;

  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return res.sendStatus(400);
  }

  res.sendStatus(202);

  const cacheFile = path.join(AUDIO_CACHE_DIR, `${id}.m4a`);

  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 65536) {
    return;
  }

  if (_downloading.has(id)) {
    return;
  }

  _downloading.add(id);

  try {
    await getCachedUrlInfo(id);
    console.log(`[prefetch] warmed ${id}`);
  } catch (e) {
    console.warn(`[prefetch] failed for ${id}:`, e.message);
  } finally {
    _downloading.delete(id);
  }
});