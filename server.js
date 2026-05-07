// server.js — COMPLETE FIXED VERSION
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD'],
  allowedHeaders: ['Range', 'Content-Type'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 5000;

// ─── ytmusic-api ────────────────────────────────────────────────
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

// ─── ytdl-core ──────────────────────────────────────────────────
const ytdl = require('@distube/ytdl-core');

// ─── Helpers (keep your existing ones) ──────────────────────────
const globalSeenIds = new Set();
const SEEN_CAP = 300;
function addToGlobalSeen(id) {
  if (globalSeenIds.size >= SEEN_CAP)
    globalSeenIds.delete(globalSeenIds.values().next().value);
  globalSeenIds.add(id);
}

function extractCoreSongTitle(title) {
  return title
    .replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '')
    .replace(/\|.*/g, '')
    .replace(/[-–]\s*(official|audio|video|lyrics?|hd|4k|full|song|music|ft\.?|feat\.).*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'the','a','an','of','in','on','at','to','for','and','or','but',
  'is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might',
  'my','your','his','her','its','our','their','this','that','with',
  'from','by','as','up','out','so','if','not','no','me','you','he',
  'she','we','they','it','i','oh','oo','aa','hey','yeah','yeh','haan',
]);
function extractKeywords(cleanTitle) {
  return cleanTitle.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 2);
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  if (/marathi|lavani|koligeet/.test(t)) return 'marathi';
  if (/punjabi|bhangra/.test(t)) return 'punjabi';
  if (/bollywood|hindi film|filmi|\bhindi\b/.test(t)) return 'bollywood';
  if (/tamil|kollywood/.test(t)) return 'tamil';
  if (/telugu|tollywood/.test(t)) return 'telugu';
  if (/kannada/.test(t)) return 'kannada';
  if (/malayalam/.test(t)) return 'malayalam';
  if (/k.?pop|bts|blackpink/.test(t)) return 'kpop';
  if (/lofi|lo.fi|chill beats/.test(t)) return 'lofi';
  if (/\brap\b|hip.?hop|trap/.test(t)) return 'hiphop';
  if (/\brock\b|metal|punk/.test(t)) return 'rock';
  if (/\brnb\b|r&b/.test(t)) return 'rnb';
  if (/electronic|edm|techno|house/.test(t)) return 'electronic';
  return 'pop';
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/\bghazal\b|\bacoustic\b|\bsoulful\b|\bmellow\b|\bsoft\b/.test(t)) return 'slow acoustic';
  if (/\bsad\b|\bheartbreak\b|\bdard\b|\bgham\b/.test(t)) return 'sad emotional';
  if (/\bromantic\b|\blove song\b|\bpyaar\b|\bishq\b/.test(t)) return 'romantic love';
  if (/\blo[\s-]?fi\b|\bchill\b|\bstudy\b/.test(t)) return 'lofi chill';
  if (/\bparty\b|\bdance\b|\bdj\b|\bclub\b/.test(t)) return 'party dance';
  return '';
}

const GENRE_QUERIES = {
  marathi:    ['marathi songs 2025','new marathi hits'],
  punjabi:    ['punjabi hits 2025','new punjabi songs'],
  bollywood:  ['bollywood hits 2025','new hindi songs'],
  tamil:      ['tamil hits 2025','new tamil songs'],
  telugu:     ['telugu hits 2025','new telugu songs'],
  kannada:    ['kannada hits 2025'],
  malayalam:  ['malayalam hits 2025'],
  kpop:       ['kpop hits 2025','popular kpop songs'],
  lofi:       ['lofi chill music mix','relaxing lofi hip hop'],
  hiphop:     ['hip hop hits 2025','rap songs 2025'],
  rock:       ['rock hits playlist','popular rock songs 2025'],
  rnb:        ['rnb hits 2025','new r&b songs'],
  electronic: ['electronic dance music 2025','edm hits playlist'],
  pop:        ['pop hits 2025','popular songs 2025'],
};

const JUNK_PATTERN = /\b(remix|remixed|slowed|reverb|sped[\s-]?up|nightcore|8d[\s-]?audio|cover|karaoke|instrumental|bgm|ringtone|status|whatsapp|lyric[\s-]?video|making[\s-]?of|mashup|medley|tribute|parody)\b/i;
function isJunkVideo(title) { return JUNK_PATTERN.test(title); }
function normaliseTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function isNearDuplicate(title, seen) {
  const words = normaliseTitle(title).split(' ').filter(w => w.length > 3);
  if (!words.length) return false;
  for (const s of seen) {
    const sw = normaliseTitle(s).split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => sw.includes(w)).length;
    if (matches / Math.max(words.length, sw.length, 1) >= 0.50) return true;
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
      id:        song.videoId,
      title:     song.name,
      artist:    song.artist?.name || song.artists?.[0]?.name || 'Unknown',
      // ✅ FIX: Always pick highest-res thumbnail, fallback to placeholder
      thumbnail: (song.thumbnails?.sort((a,b) => (b.width||0)-(a.width||0))[0]?.url)
                  || `https://img.youtube.com/vi/${song.videoId}/hqdefault.jpg`,
    })).filter(s => s.id && s.title);
  } catch (e) {
    console.warn('[ytmusic] searchSongs error:', e.message);
    return [];
  }
}

// ─── Info cache ─────────────────────────────────────────────────
const infoCache = new Map();

async function getCachedInfo(id) {
  const cached = infoCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${id}`, {
    requestOptions: {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
          + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
  });

  infoCache.set(id, { info, expiresAt: Date.now() + 5 * 60 * 1000 });
  if (infoCache.size > 100) infoCache.delete(infoCache.keys().next().value);
  return info;
}

// ────────────────────────────────────────────────────────────────
//  ✅ KEY FIX: Choose iOS-compatible audio format (m4a/AAC)
// ────────────────────────────────────────────────────────────────
function chooseiOSFormat(formats) {
  // Priority 1: m4a (AAC) — universally supported by iOS Safari
  const m4a = formats
    .filter(f => f.mimeType?.includes('audio/mp4') || f.container === 'm4a')
    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
  if (m4a.length) return m4a[0];

  // Priority 2: Any audioonly with decent bitrate
  const any = ytdl.filterFormats(formats, 'audioonly')
    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
  if (any.length) return any[0];

  return null;
}

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

app.get('/api/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const { data } = await axios.get(
      'https://suggestqueries.google.com/complete/search',
      { params: { client: 'firefox', ds: 'yt', q } }
    );
    res.json({ suggestions: (data[1] || []).slice(0, 8) });
  } catch {
    res.json({ suggestions: [] });
  }
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
          id:        s.videoId,
          title:     s.name,
          artist:    s.artist?.name || s.artists?.[0]?.name || 'Unknown',
          thumbnail: s.thumbnails?.[0]?.url
                      || `https://img.youtube.com/vi/${s.videoId}/hqdefault.jpg`,
        }));
      return res.json({ items: mapped });
    }
    res.json({ items: [] });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/trending', async (req, res) => {
  const genre = req.query.genre || 'pop';
  try {
    const pool  = GENRE_QUERIES[genre] || GENRE_QUERIES.pop;
    const query = pool[Math.floor(Math.random() * pool.length)];
    const items = await ytmusicSearch(query, 20);
    res.json({ items });
  } catch (err) {
    console.error('[trending]', err.message);
    res.status(500).json({ error: 'Trending failed' });
  }
});

app.get('/api/related/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const rawTitle  = req.query.title  || '';
  const rawArtist = req.query.artist || '';
  try {
    const cleanTitle = extractCoreSongTitle(rawTitle);
    const lang       = detectLanguage(`${rawTitle} ${rawArtist}`);
    const mood       = detectMood(`${rawTitle} ${rawArtist}`);
    const keywords   = extractKeywords(cleanTitle);

    const genreLabel = {
      marathi:'marathi', punjabi:'punjabi', bollywood:'bollywood hindi',
      tamil:'tamil', telugu:'telugu', kannada:'kannada', malayalam:'malayalam',
      kpop:'kpop', lofi:'lofi chill', hiphop:'hip hop',
      rock:'rock', rnb:'rnb', electronic:'edm electronic', pop:'pop',
    }[lang] || 'pop';

    const artistKw = rawArtist
      .replace(/\s*(official|music|records|vevo|films?|studios?|india)\s*/gi, '')
      .trim().split(/\s+/).slice(0, 2).join(' ');

    const queries = [];
    if (artistKw.length > 2)
      queries.push(mood ? `${artistKw} ${mood} songs` : `${artistKw} songs`);
    if (mood) queries.push(`${genreLabel} ${mood} songs`);
    else if (keywords.length) queries.push(`${keywords.join(' ')} ${genreLabel} songs`);
    else queries.push(`${genreLabel} songs 2025`);
    const poolQ = GENRE_QUERIES[lang] || GENRE_QUERIES.pop;
    queries.push(poolQ[Math.floor(Math.random() * poolQ.length)]);

    const localSeen  = new Set([videoId, ...globalSeenIds]);
    const seenTitles = rawTitle ? [rawTitle] : [];
    const allItems   = [];

    for (const q of queries) {
      try {
        const results = await ytmusicSearch(q, 15);
        for (const item of results) {
          if (localSeen.has(item.id) || isJunkVideo(item.title)) continue;
          if (isNearDuplicate(item.title, seenTitles)) continue;
          localSeen.add(item.id);
          seenTitles.push(item.title);
          allItems.push(item);
        }
      } catch {}
    }

    const items = shuffleArray(allItems).slice(0, 20);
    items.forEach(s => addToGlobalSeen(s.id));
    addToGlobalSeen(videoId);
    res.json({ items });
  } catch (err) {
    console.error('[related]', err.message);
    try {
      const fallback = await ytmusicSearch('popular music hits 2025', 15);
      res.json({ items: fallback.filter(s => !globalSeenIds.has(s.id)) });
    } catch {
      res.status(500).json({ error: 'Related fetch failed', items: [] });
    }
  }
});

// ════════════════════════════════════════════════════════════════
//  ✅ FIXED STREAM ENDPOINT — iOS compatible (m4a/AAC)
// ════════════════════════════════════════════════════════════════
app.get('/api/stream/:id', async (req, res) => {
  const id = req.params.id;
  if (!ytdl.validateID(id))
    return res.status(400).json({ error: 'Invalid video ID' });

  // ── CORS headers (critical for iOS) ──────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const info   = await getCachedInfo(id);

      // ✅ FIX: Prefer m4a/AAC for iOS Safari compatibility
      const format = chooseiOSFormat(info.formats);
      if (!format) return res.status(404).json({ error: 'No audio format found' });

      console.log(`[stream] id=${id} format=${format.mimeType} bitrate=${format.audioBitrate}`);

      const contentLength = parseInt(format.contentLength || '0', 10);

      // ✅ FIX: Always send audio/mpeg or audio/mp4 — never audio/webm on iOS
      const mimeType = format.mimeType?.includes('mp4') ? 'audio/mp4' : 'audio/mpeg';

      const ytUrl     = `https://www.youtube.com/watch?v=${id}`;
      const streamOpts = {
        format,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
          },
        },
      };

      const rangeHeader = req.headers.range;

      if (rangeHeader && contentLength) {
        // ✅ Range requests — essential for iOS seek + background resume
        const [s, e] = rangeHeader.replace('bytes=', '').split('-');
        const start  = parseInt(s, 10);
        const end    = e ? parseInt(e, 10) : contentLength - 1;

        res.writeHead(206, {
          'Content-Range':  `bytes ${start}-${end}/${contentLength}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': end - start + 1,
          'Content-Type':   mimeType,
          'Cache-Control':  'no-cache',
        });
        const st = ytdl(ytUrl, { ...streamOpts, range: { start, end } });
        st.on('error', err => { console.error('[stream pipe]', err.message); res.destroy(); });
        st.pipe(res);
        req.on('close', () => st.destroy());
      } else {
        res.writeHead(200, {
          'Content-Type':  mimeType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          ...(contentLength ? { 'Content-Length': contentLength } : {}),
        });
        const st = ytdl(ytUrl, streamOpts);
        st.on('error', err => { console.error('[stream pipe]', err.message); res.destroy(); });
        st.pipe(res);
        req.on('close', () => st.destroy());
      }
      return;

    } catch (err) {
      lastErr = err;
      const is429 = err.message?.includes('429') || err.statusCode === 429;
      if (is429 && attempt < 3) {
        console.warn(`[stream] 429 — retry ${attempt}/3`);
        await new Promise(r => setTimeout(r, attempt * 1500));
        infoCache.delete(id);
        continue;
      }
      break;
    }
  }

  console.error('[stream] failed:', lastErr?.message);
  if (!res.headersSent)
    res.status(500).json({ error: 'Streaming failed: ' + (lastErr?.message || 'unknown') });
});

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ytmusicReady, time: new Date() })
);

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api'))
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () =>
  console.log(`🎵 Mestify backend → http://localhost:${PORT}`)
);