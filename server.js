// server.js — MESTIFY v3.0 (Login + Personalized Algorithm)
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'POST'],
  allowedHeaders: ['Range', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;
const ON_RENDER = !!process.env.RENDER;

// ════════════════════════════════════════════════════════════════
//  FLAT-FILE USER DATABASE  (users.json — free forever)
// ════════════════════════════════════════════════════════════════
const USERS_FILE = process.env.DATABASE_PATH || path.join(__dirname, 'users.json');

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { return {}; }
}
function writeUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}
function generateUserId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}
function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// In-memory token store: token → userId (cleared on restart, that's fine)
const tokenStore = new Map();

function getUserByToken(token) {
  const userId = tokenStore.get(token);
  if (!userId) return null;
  const users = readUsers();
  return users[userId] ? { ...users[userId], userId } : null;
}

// ─── Update user taste weights based on a play event ─────────────
function updateUserWeights(user, { artist, genre, mood, completionPct }) {
  const w = completionPct >= 80 ? 3 : completionPct >= 50 ? 2 : 1;

  if (!user.artistWeights) user.artistWeights = {};
  if (!user.genreWeights)  user.genreWeights  = {};
  if (!user.moodWeights)   user.moodWeights   = {};

  if (artist && artist !== 'Unknown') {
    user.artistWeights[artist] = (user.artistWeights[artist] || 0) + w;
  }
  if (genre) user.genreWeights[genre] = (user.genreWeights[genre] || 0) + w;
  if (mood)  user.moodWeights[mood]   = (user.moodWeights[mood]  || 0) + w;
}

// ─── Build personalized query list from user profile ─────────────
function buildPersonalizedQueries(user, currentArtist, currentGenre, currentMood, baseQueries) {
  const artistW = user.artistWeights || {};
  const genreW  = user.genreWeights  || {};
  const moodW   = user.moodWeights   || {};

  // Top 3 artists the user listens to most
  const topArtists = Object.entries(artistW)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);

  // Top 2 genres
  const topGenres = Object.entries(genreW)
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);

  // Top mood
  const topMood = Object.entries(moodW)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  const personalized = [];

  // Signal A: User's fav artists (highest weight × 3)
  for (const a of topArtists) {
    if (a !== currentArtist) personalized.push(`${a} best songs`);
    if (topMood) personalized.push(`${a} ${topMood} songs`);
  }

  // Signal B: User's fav genres (weight × 2)
  for (const g of topGenres) {
    const gQueries = GENRE_QUERIES[g] || [];
    if (gQueries.length) personalized.push(gQueries[Math.floor(Math.random() * gQueries.length)]);
  }

  // Signal C: Current song's artist (always relevant)
  if (currentArtist && !topArtists.includes(currentArtist)) {
    personalized.unshift(`${currentArtist} popular songs`);
  }

  // Signal D: Mood blend
  if (topMood && currentGenre) personalized.push(`${currentGenre} ${topMood} songs`);

  // Merge with base queries (non-personalized fallback)
  return [...new Set([...personalized, ...baseQueries])];
}

// ─── Score a list of songs against user profile ───────────────────
function scoreAndRank(items, user, seenIds = new Set()) {
  if (!user) return items;
  const aW = user.artistWeights || {};
  const gW = user.genreWeights  || {};
  const mW = user.moodWeights   || {};

  // History set (avoid replaying recent songs)
  const recentIds = new Set((user.history || []).slice(0, 30).map(h => h.id));

  return items
    .filter(s => !seenIds.has(s.id))
    .map(s => {
      const artist = s.artist || '';
      const genre  = detectLanguage(`${s.title} ${artist}`);
      const mood   = detectMood(`${s.title} ${artist}`);

      let score = 0;
      score += (aW[artist] || 0) * 3;
      score += (gW[genre]  || 0) * 2;
      score += (mW[mood]   || 0) * 1;

      // Recency penalty: slightly deprioritize recently played
      if (recentIds.has(s.id)) score -= 5;

      // Liked songs boost
      if ((user.liked || []).includes(s.id)) score += 4;

      return { ...s, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...s }) => s);
}


// ════════════════════════════════════════════════════════════════
//  YOUTUBEI.JS — Innertube API (most stable, no parsing issues)
// ════════════════════════════════════════════════════════════════
let innerTube = null;
(async () => {
  try {
    const { Innertube } = require('youtubei.js');
    innerTube = await Innertube.create({
      lang: 'en',
      location: 'US',
      generate_session_locally: true,
    });
    console.log('✅ youtubei.js (Innertube) ready');
  } catch (e) {
    console.warn('⚠️ youtubei.js failed to init:', e.message);
  }
})();

// ════════════════════════════════════════════════════════════════
//  PIPED API — Free YouTube streaming proxy (no 429, no API key!)
//  Rotates through multiple public instances for reliability
// ════════════════════════════════════════════════════════════════
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.projectsegfau.lt',
  'https://piped-api.garudalinux.org',
  'https://pipedapi.coldforge.xyz',
  'https://api.piped.yt',
];

// Stream URL cache — Piped URLs expire ~6 min, so we cache 5 min
const streamCache = new Map();

async function getPipedStream(videoId) {
  const cached = streamCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[piped] ✅ cache hit: ${videoId}`);
    return cached;
  }

  const errors = [];
  for (const instance of PIPED_INSTANCES) {
    try {
      const { data } = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124' },
      });

      const audioStreams = (data.audioStreams || [])
        .filter(s => s.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (!audioStreams.length) { errors.push(`${instance}: no audio streams`); continue; }

      // Prefer m4a/AAC for iOS Safari — widest device compatibility
      const m4a = audioStreams.find(s =>
        s.mimeType?.includes('audio/mp4') || s.format === 'M4A' || s.codec?.includes('mp4a')
      );
      const best = m4a || audioStreams[0];

      const result = {
        url:      best.url,
        mimeType: (best.mimeType?.includes('mp4') || best.format === 'M4A') ? 'audio/mp4' : 'audio/webm',
        bitrate:  best.bitrate || 128000,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      streamCache.set(videoId, result);
      if (streamCache.size > 200) streamCache.delete(streamCache.keys().next().value);

      console.log(`[piped] ✅ ${instance} → ${best.mimeType} @${Math.round((best.bitrate || 0) / 1000)}kbps`);
      return result;
    } catch (e) {
      errors.push(`${instance}: ${e.message}`);
      console.warn(`[piped] ⚠️ ${instance}: ${e.message}`);
    }
  }
  throw new Error(`All Piped instances failed: ${errors.join(' | ')}`);
}

// ════════════════════════════════════════════════════════════════
//  YTMUSIC-API — For search/browse (quota-free)
// ════════════════════════════════════════════════════════════════
const YTMusic = require('ytmusic-api');
const ytmusic = new YTMusic();
let ytmusicReady = false;

(async () => {
  try {
    await ytmusic.initialize();
    ytmusicReady = true;
    console.log('✅ ytmusic-api ready');
  } catch (e) {
    console.error('❌ ytmusic-api failed:', e.message);
  }
})();

// ════════════════════════════════════════════════════════════════
//  HELPERS & ALGORITHM
// ════════════════════════════════════════════════════════════════
const globalSeenIds = new Set();
const SEEN_CAP = 500;
function addToGlobalSeen(id) {
  if (globalSeenIds.size >= SEEN_CAP) globalSeenIds.delete(globalSeenIds.values().next().value);
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
  'the','a','an','of','in','on','at','to','for','and','or','but','is','are','was',
  'were','be','been','have','has','had','do','does','did','will','would','could',
  'should','my','your','his','her','its','our','their','this','that','with','from',
  'by','as','up','out','so','if','not','no','me','you','he','she','we','they','it',
  'i','oh','oo','aa','hey','yeah','yeh','haan',
]);
function extractKeywords(cleanTitle) {
  return cleanTitle.toLowerCase().split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 3);
}

function detectLanguage(text) {
  const t = text.toLowerCase();
  if (/marathi|lavani|koligeet/.test(t))               return 'marathi';
  if (/punjabi|bhangra/.test(t))                        return 'punjabi';
  if (/bollywood|hindi film|filmi|\bhindi\b/.test(t))   return 'bollywood';
  if (/tamil|kollywood/.test(t))                        return 'tamil';
  if (/telugu|tollywood/.test(t))                       return 'telugu';
  if (/kannada/.test(t))                                return 'kannada';
  if (/malayalam/.test(t))                              return 'malayalam';
  if (/k.?pop|bts|blackpink|twice|stray kids/.test(t)) return 'kpop';
  if (/lofi|lo.fi|chill beats/.test(t))                 return 'lofi';
  if (/\brap\b|hip.?hop|trap/.test(t))                  return 'hiphop';
  if (/\brock\b|metal|punk/.test(t))                    return 'rock';
  if (/\brnb\b|r&b/.test(t))                            return 'rnb';
  if (/electronic|edm|techno|house/.test(t))            return 'electronic';
  if (/indie|alternative/.test(t))                      return 'indie';
  return 'pop';
}

function detectMood(text) {
  const t = text.toLowerCase();
  if (/\bghazal\b|\bacoustic\b|\bsoulful\b|\bmellow\b|\bsoft\b/.test(t)) return 'slow acoustic';
  if (/\bsad\b|\bheartbreak\b|\bdard\b|\bgham\b|\btears\b/.test(t))      return 'sad emotional';
  if (/\bromantic\b|\blove song\b|\bpyaar\b|\bishq\b/.test(t))            return 'romantic love';
  if (/\blo[\s-]?fi\b|\bchill\b|\bstudy\b/.test(t))                       return 'lofi chill';
  if (/\bparty\b|\bdance\b|\bdj\b|\bclub\b/.test(t))                      return 'party dance';
  if (/\bworkout\b|\bgym\b|\benergy\b|\bmotivat/.test(t))                 return 'energetic workout';
  return '';
}

// ── Genre query bank — used for trending + related autoplay ──────
const GENRE_QUERIES = {
  marathi:    ['marathi songs 2025', 'new marathi hits', 'marathi trending songs'],
  punjabi:    ['punjabi hits 2025', 'new punjabi songs', 'punjabi trending 2025'],
  bollywood:  ['bollywood hits 2025', 'new hindi songs', 'hindi trending songs 2025', 'latest bollywood 2025'],
  tamil:      ['tamil hits 2025', 'new tamil songs', 'kollywood hits 2025'],
  telugu:     ['telugu hits 2025', 'new telugu songs', 'tollywood hits 2025'],
  kannada:    ['kannada hits 2025', 'kannada songs 2025'],
  malayalam:  ['malayalam hits 2025', 'new malayalam songs'],
  kpop:       ['kpop hits 2025', 'bts songs 2025', 'blackpink 2025', 'kpop trending'],
  lofi:       ['lofi chill music mix', 'relaxing lofi hip hop', 'study lofi beats 2025'],
  hiphop:     ['hip hop hits 2025', 'rap songs 2025', 'top rap tracks 2025'],
  rock:       ['rock hits 2025', 'popular rock songs', 'rock classics playlist'],
  rnb:        ['rnb hits 2025', 'new r&b songs', 'smooth rnb 2025'],
  electronic: ['edm hits 2025', 'electronic dance music 2025', 'house music 2025'],
  pop:        ['pop hits 2025', 'popular songs 2025', 'top pop songs 2025'],
  indie:      ['indie pop 2025', 'indie rock 2025', 'alternative indie songs 2025'],
};

const JUNK_PATTERN = /\b(remix|remixed|slowed|reverb|sped[\s-]?up|nightcore|8d[\s-]?audio|cover|karaoke|instrumental|bgm|ringtone|status|whatsapp|lyric[\s-]?video|making[\s-]?of|mashup|medley|tribute|parody)\b/i;
function isJunkVideo(title)  { return JUNK_PATTERN.test(title); }

function normaliseTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function isNearDuplicate(title, seen) {
  const words = normaliseTitle(title).split(' ').filter(w => w.length > 3);
  if (!words.length) return false;
  for (const s of seen) {
    const sw = normaliseTitle(s).split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => sw.includes(w)).length;
    if (matches / Math.max(words.length, sw.length, 1) >= 0.5) return true;
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

// ── Search with 15-min cache ─────────────────────────────────────
const searchCache = new Map();

async function ytmusicSearch(query, limit = 20) {
  if (!ytmusicReady) return [];
  const cacheKey = `${query}:::${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  try {
    const results = await ytmusic.searchSongs(query);
    const items = results.slice(0, limit * 2).map(song => ({
      id:        song.videoId,
      title:     song.name,
      artist:    song.artist?.name || song.artists?.[0]?.name || 'Unknown',
      thumbnail: (song.thumbnails?.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url)
                  || `https://img.youtube.com/vi/${song.videoId}/hqdefault.jpg`,
      duration:  song.duration || 0,
      album:     song.album?.name || '',
    })).filter(s => s.id && s.title).slice(0, limit);

    searchCache.set(cacheKey, { items, expiresAt: Date.now() + 15 * 60 * 1000 });
    if (searchCache.size > 150) searchCache.delete(searchCache.keys().next().value);
    return items;
  } catch (e) {
    console.warn('[ytmusic] search error:', e.message);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// ── Autocomplete suggestions ────────────────────────────────────
app.get('/api/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const { data } = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'firefox', ds: 'yt', q }, timeout: 5000,
    });
    res.json({ suggestions: (data[1] || []).slice(0, 8) });
  } catch { res.json({ suggestions: [] }); }
});

// ── Search ───────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const items = await ytmusicSearch(q, 25);
    if (items.length) return res.json({ items });
    // Fallback to generic search
    if (ytmusicReady) {
      const r2 = await ytmusic.search(q);
      const mapped = (r2 || []).slice(0, 25).filter(s => s.videoId && s.name).map(s => ({
        id: s.videoId, title: s.name,
        artist: s.artist?.name || s.artists?.[0]?.name || 'Unknown',
        thumbnail: s.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${s.videoId}/hqdefault.jpg`,
        duration: 0, album: '',
      }));
      return res.json({ items: mapped });
    }
    res.json({ items: [] });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Trending by genre ────────────────────────────────────────────
app.get('/api/trending', async (req, res) => {
  const genre = req.query.genre || 'pop';
  try {
    const pool  = GENRE_QUERIES[genre] || GENRE_QUERIES.pop;
    const query = pool[Math.floor(Math.random() * pool.length)];
    const items = await ytmusicSearch(query, 25);
    res.json({ items });
  } catch (err) {
    console.error('[trending]', err.message);
    res.status(500).json({ error: 'Trending failed' });
  }
});

// ────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ────────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { name, pin, email } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Username and Password required' });
  if (String(pin).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (name.trim().length < 2)          return res.status(400).json({ error: 'Username too short' });

  const users = readUsers();

  // Check duplicate name (case-insensitive)
  const exists = Object.values(users).find(u => u.name.toLowerCase() === name.trim().toLowerCase());
  if (exists) return res.status(409).json({ error: 'Username already taken. Choose another or log in.' });

  const userId   = generateUserId();
  const pinHash  = await bcrypt.hash(String(pin), 10);
  const token    = generateToken();

  users[userId] = {
    name:          name.trim(),
    email:         (email || '').trim().toLowerCase(),
    pinHash,
    created:       new Date().toISOString(),
    history:       [],
    liked:         [],
    artistWeights: {},
    genreWeights:  {},
    moodWeights:   {},
  };
  writeUsers(users);
  tokenStore.set(token, userId);

  console.log(`[auth] ✅ Registered: ${name.trim()} (${userId})`);
  res.json({ userId, name: name.trim(), token });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Username/Email and Password required' });

  const users = readUsers();
  // Find by username OR email
  const entry = Object.entries(users).find(
    ([, u]) => u.name.toLowerCase() === name.trim().toLowerCase() || (u.email && u.email.toLowerCase() === name.trim().toLowerCase())
  );
  if (!entry) return res.status(404).json({ error: 'User not found. Register first.' });

  const [userId, user] = entry;
  const match = await bcrypt.compare(String(pin), user.pinHash);
  if (!match) return res.status(401).json({ error: 'Wrong Password. Try again.' });

  const token = generateToken();
  tokenStore.set(token, userId);

  console.log(`[auth] ✅ Login: ${user.name}`);
  res.json({ userId, name: user.name, token });
});

// ── History — log a play event ────────────────────────────────────
// POST /api/history
app.post('/api/history', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return res.json({ ok: false, reason: 'guest' });  // guests silently ignored

  const { id, title, artist, genre, mood, completionPct = 100 } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });

  const users = readUsers();
  const u = users[user.userId];
  if (!u) return res.status(404).json({ error: 'User not found' });

  // Prepend to history (max 200 entries)
  u.history = [
    { id, title, artist, genre, mood, completionPct, playedAt: Date.now() },
    ...(u.history || []),
  ].slice(0, 200);

  // Update taste weights
  updateUserWeights(u, { artist, genre, mood, completionPct });

  writeUsers(users);
  res.json({ ok: true });
});

// GET /api/profile — return taste summary
app.get('/api/profile', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const users = readUsers();
  const u = users[user.userId];

  // Top 5 artists, top 3 genres, top mood
  const topArtists = Object.entries(u.artistWeights || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  const topGenres  = Object.entries(u.genreWeights  || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  const topMood    = Object.entries(u.moodWeights   || {})
    .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  res.json({
    name:       u.name,
    topArtists, topGenres, topMood,
    totalPlays: (u.history || []).length,
    liked:      (u.liked   || []).length,
  });
});

// POST /api/like — toggle like, feed into weights
app.post('/api/like', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return res.json({ ok: false });

  const { id, title, artist, genre, mood, action } = req.body; // action: 'like' | 'unlike'
  const users = readUsers();
  const u = users[user.userId];

  u.liked = u.liked || [];
  if (action === 'like') {
    if (!u.liked.includes(id)) u.liked.push(id);
    // Like = strong signal (completion 100%)
    updateUserWeights(u, { artist, genre, mood, completionPct: 100 });
    // Extra boost for liked songs
    if (artist) u.artistWeights[artist] = (u.artistWeights[artist] || 0) + 2;
    if (genre)  u.genreWeights[genre]   = (u.genreWeights[genre]   || 0) + 2;
  } else {
    u.liked = u.liked.filter(x => x !== id);
  }
  writeUsers(users);
  res.json({ ok: true, liked: u.liked });
});

// GET /api/history — return listening history page
app.get('/api/history', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const users = readUsers();
  const u = users[user.userId];
  const page  = parseInt(req.query.page  || '0');
  const limit = parseInt(req.query.limit || '20');
  const items = (u.history || []).slice(page * limit, (page + 1) * limit);
  res.json({ items, total: (u.history || []).length });
});

// ────────────────────────────────────────────────────────────────
//  HYBRID RECOMMENDATION ENGINE (Innertube + Personalized Scoring)
// ────────────────────────────────────────────────────────────────

async function getInnertubeRecommendations(videoId) {
  if (!innerTube) return [];
  try {
    const upNext = await innerTube.music.getUpNext(videoId);
    if (!upNext || !upNext.contents) return [];
    
    return upNext.contents
      .filter(item => item.type === 'PlaylistPanelVideo')
      .map(item => ({
        id: item.video_id,
        title: item.title?.text || '',
        artist: item.author || (item.artists && item.artists[0]?.name) || 'Unknown',
        thumbnail: item.thumbnail?.[0]?.url || `https://img.youtube.com/vi/${item.video_id}/hqdefault.jpg`,
        duration: item.duration?.seconds || 0,
        album: item.album?.name || '',
      }));
  } catch (err) {
    console.warn('[innertube] failed to get related:', err.message);
    return [];
  }
}

function hybridScoreAndRank(items, user, currentSongId) {
  if (!user) return items;
  const artistW = user.artistWeights || {};
  const genreW  = user.genreWeights  || {};
  const moodW   = user.moodWeights   || {};
  const liked   = user.liked         || [];
  const history = user.history       || [];
  
  const recentIds = new Set(history.slice(0, 15).map(h => h.id));
  const olderIds = new Set(history.slice(15, 60).map(h => h.id));

  return items.map(s => {
    let score = 0;
    
    // 1. Artist preference (x3 weighting)
    if (artistW[s.artist]) {
      score += artistW[s.artist] * 3;
    }
    
    // 2. Genre preference (x2 weighting)
    const genre = detectLanguage(`${s.title} ${s.artist}`);
    if (genreW[genre]) {
      score += genreW[genre] * 2;
    }
    
    // 3. Mood preference (x1 weighting)
    const mood = detectMood(`${s.title} ${s.artist}`);
    if (moodW[mood]) {
      score += moodW[mood] * 1;
    }
    
    // 4. Explicit Liked songs boost
    if (liked.includes(s.id)) {
      score += 15;
    }
    
    // 5. Play counts (loyalty score)
    const playCount = history.filter(h => h.id === s.id).length;
    score += Math.min(playCount * 2, 10);
    
    // 6. Recency variety penalties
    if (s.id === currentSongId) score -= 100; // exclude active track
    if (recentIds.has(s.id)) {
      score -= 30; // heavy penalty to avoid repeats
    } else if (olderIds.has(s.id)) {
      score -= 10; // light penalty
    }
    
    return { ...s, _score: score };
  })
  .sort((a, b) => b._score - a._score)
  .map(({ _score, ...s }) => s);
}

app.get('/api/related/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const rawTitle  = req.query.title  || '';
  const rawArtist = req.query.artist || '';
  const token     = req.headers.authorization?.replace('Bearer ', '') ||
                    req.query.token || '';
  const user      = token ? getUserByToken(token) : null;

  try {
    let allItems = await getInnertubeRecommendations(videoId);
    let usedInnertube = allItems.length > 0;

    if (!usedInnertube) {
      // Fallback: existing search-query based recommendations
      const cleanTitle = extractCoreSongTitle(rawTitle);
      const lang       = detectLanguage(`${rawTitle} ${rawArtist}`);
      const mood       = detectMood(`${rawTitle} ${rawArtist}`);
      const keywords   = extractKeywords(cleanTitle);

      const genreLabel = {
        marathi:'marathi', punjabi:'punjabi', bollywood:'bollywood hindi',
        tamil:'tamil', telugu:'telugu', kannada:'kannada', malayalam:'malayalam',
        kpop:'kpop', lofi:'lofi chill', hiphop:'hip hop rap',
        rock:'rock', rnb:'rnb r&b', electronic:'edm electronic', pop:'pop', indie:'indie',
      }[lang] || 'pop';

      const artistKw = rawArtist
        .replace(/\s*(official|music|records|vevo|films?|studios?|india)\s*/gi, '')
        .trim().split(/\s+/).slice(0, 2).join(' ');

      const baseQueries = [];
      if (artistKw.length > 2) {
        baseQueries.push(mood ? `${artistKw} ${mood} songs` : `${artistKw} popular songs`);
        baseQueries.push(`${artistKw} best songs`);
      }
      if (mood)            baseQueries.push(`${genreLabel} ${mood} songs`);
      if (keywords.length) baseQueries.push(`${keywords.join(' ')} ${genreLabel} songs`);
      baseQueries.push(`${genreLabel} hits 2025`);
      const poolQ = GENRE_QUERIES[lang] || GENRE_QUERIES.pop;
      baseQueries.push(poolQ[Math.floor(Math.random() * poolQ.length)]);
      baseQueries.push(poolQ[Math.floor(Math.random() * poolQ.length)]);

      const queries = user
        ? buildPersonalizedQueries(user, artistKw, lang, mood, baseQueries)
        : baseQueries;

      const localSeen  = new Set([videoId, ...globalSeenIds]);
      const seenTitles = rawTitle ? [rawTitle] : [];

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
        } catch (_) {}
      }
    }

    let items;
    if (user && allItems.length) {
      items = hybridScoreAndRank(allItems, user, videoId).slice(0, 25);
    } else {
      items = shuffleArray(allItems).slice(0, 25);
    }

    items.forEach(s => addToGlobalSeen(s.id));
    addToGlobalSeen(videoId);
    res.json({ items, personalized: !!user, source: usedInnertube ? 'innertube' : 'fallback' });
  } catch (err) {
    console.error('[related]', err.message);
    try {
      const fallback = await ytmusicSearch('popular music hits 2025', 20);
      res.json({ items: fallback.filter(s => !globalSeenIds.has(s.id)), personalized: false });
    } catch {
      res.status(500).json({ error: 'Related failed', items: [] });
    }
  }
});

// GET /api/upnext/:videoId — YT Music-style Up Next panel
app.get('/api/upnext/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const rawTitle  = req.query.title  || '';
  const rawArtist = req.query.artist || '';
  const filter    = req.query.filter || 'all';  // all | hindi | upbeat | discover
  const token     = req.headers.authorization?.replace('Bearer ', '') || req.query.token || '';
  const user      = token ? getUserByToken(token) : null;

  try {
    let allItems = await getInnertubeRecommendations(videoId);
    let usedInnertube = allItems.length > 0;

    // Fallback if Innertube list is empty
    if (!usedInnertube) {
      const filterQueries = {
        hindi:    ['bollywood hits 2025', 'new hindi songs 2025', `${rawArtist} hindi songs`],
        upbeat:   ['party dance hits 2025', 'upbeat happy songs', 'energetic workout music'],
        discover: ['indie gems 2025', 'hidden music gems', 'underrated songs 2025'],
        all:      null,
      };

      const lang = detectLanguage(`${rawTitle} ${rawArtist}`);
      const mood = detectMood(`${rawTitle} ${rawArtist}`);
      const artistKw = rawArtist
        .replace(/\s*(official|music|records|vevo|films?|studios?|india)\s*/gi, '')
        .trim().split(/\s+/).slice(0, 2).join(' ');

      let queries = filterQueries[filter] || [
        artistKw.length > 2 ? `${artistKw} popular songs` : null,
        mood ? `${lang} ${mood} songs` : null,
        `${lang} hits 2025`,
      ].filter(Boolean);

      if (user) queries = buildPersonalizedQueries(user, artistKw, lang, mood, queries);

      const seen = new Set([videoId]);
      for (const q of queries.slice(0, 5)) {
        try {
          const results = await ytmusicSearch(q, 12);
          for (const item of results) {
            if (seen.has(item.id) || isJunkVideo(item.title)) continue;
            seen.add(item.id);
            allItems.push(item);
          }
        } catch (_) {}
      }
    }

    // Apply Filter Chips to retrieved recommendation pool
    let filteredItems = [...allItems];
    if (filter === 'hindi') {
      filteredItems = allItems.filter(item => {
        const lang = detectLanguage(`${item.title} ${item.artist}`);
        return lang === 'bollywood';
      });
      if (filteredItems.length < 5) filteredItems = allItems;
    } else if (filter === 'upbeat') {
      filteredItems = allItems.filter(item => {
        const text = `${item.title} ${item.artist}`.toLowerCase();
        const upbeatKeywords = /upbeat|party|dance|workout|gym|energy|happy|fitness|edm|electronic|club|dj|remix|pop|rap|hiphop|rock/i;
        return upbeatKeywords.test(text);
      });
      if (filteredItems.length < 5) filteredItems = allItems;
    } else if (filter === 'discover') {
      if (user) {
        const artistW = user.artistWeights || {};
        const topArtists = new Set(
          Object.entries(artistW)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(e => e[0].toLowerCase())
        );
        filteredItems = allItems.filter(item => !topArtists.has(item.artist.toLowerCase()));
        if (filteredItems.length < 5) filteredItems = allItems;
      }
    }

    const ranked = user ? hybridScoreAndRank(filteredItems, user, videoId) : shuffleArray(filteredItems);
    const items  = ranked.slice(0, 20);

    // Build available filter chips based on user's taste
    const chips = ['all'];
    if (user) {
      const topGenre = Object.entries(user.genreWeights || {})
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topGenre === 'bollywood') chips.push('hindi');
    }
    chips.push('upbeat', 'discover');

    res.json({ items, personalized: !!user, chips, playingFrom: rawTitle, source: usedInnertube ? 'innertube' : 'fallback' });
  } catch (err) {
    console.error('[upnext]', err.message);
    res.status(500).json({ items: [], personalized: false, chips: ['all'] });
  }
});


// ════════════════════════════════════════════════════════════════
//  STREAM — yt-dlp primary (most reliable), Piped API fallback
// ════════════════════════════════════════════════════════════════
const { spawn, execFile } = require('child_process');
const YTDLP_CMD = process.platform === 'win32' ? 'yt-dlp' : 'yt-dlp';

// Get stream URL via yt-dlp (extracts direct audio URL)
function getYtdlpUrl(videoId) {
  return new Promise((resolve, reject) => {
    const proc = execFile(YTDLP_CMD, [
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
      '--no-playlist',
      '--no-warnings',
      '-g',  // print URL only
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`yt-dlp failed: ${err.message}`));
      const url = stdout.trim().split('\n')[0];
      if (!url || !url.startsWith('http')) return reject(new Error('yt-dlp returned no URL'));
      resolve(url);
    });
  });
}

// URL cache for yt-dlp (URLs expire ~6h, cache 5h)
const ytdlpCache = new Map();

async function getCachedYtdlpUrl(videoId) {
  const cached = ytdlpCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const url = await getYtdlpUrl(videoId);
  ytdlpCache.set(videoId, { url, expiresAt: Date.now() + 5 * 60 * 60 * 1000 });
  if (ytdlpCache.size > 100) ytdlpCache.delete(ytdlpCache.keys().next().value);
  return url;
}

app.get('/api/stream/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
    return res.status(400).json({ error: 'Invalid video ID' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

  // ── Strategy A: yt-dlp (most reliable) ────────────────────────
  const tryYtdlp = async () => {
    const audioUrl = await getCachedYtdlpUrl(id);
    const rangeHeader = req.headers.range;
    const upHeaders = { 'User-Agent': 'Mozilla/5.0 (compatible; Mestify/2.0)' };
    if (rangeHeader) upHeaders['Range'] = rangeHeader;

    const upstream = await axios({ method: 'get', url: audioUrl, headers: upHeaders, responseType: 'stream', timeout: 30000 });
    const mimeType = audioUrl.includes('mime=audio%2Fmp4') || audioUrl.includes('mime=audio/mp4') ? 'audio/mp4' : 'audio/webm';
    const resHeaders = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (upstream.headers['content-length']) resHeaders['Content-Length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range'])  resHeaders['Content-Range']  = upstream.headers['content-range'];

    const statusCode = (rangeHeader && upstream.status === 206) ? 206 : 200;
    res.writeHead(statusCode, resHeaders);
    upstream.data.pipe(res);
    req.on('close', () => { try { upstream.data.destroy(); } catch (_) {} });
    console.log(`[stream] ✅ yt-dlp → ${id} (${mimeType})`);
  };

  // ── Strategy B: Piped API proxy ───────────────────────────────
  const tryPiped = async () => {
    const stream = await getPipedStream(id);
    const rangeHeader = req.headers.range;
    const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0 (compatible; Mestify/2.0)' };
    if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

    const upstream = await axios({
      method: 'get', url: stream.url,
      headers: upstreamHeaders, responseType: 'stream', timeout: 30000,
    });
    const resHeaders = {
      'Content-Type': stream.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    if (upstream.headers['content-length']) resHeaders['Content-Length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range'])  resHeaders['Content-Range']  = upstream.headers['content-range'];

    const statusCode = (rangeHeader && upstream.status === 206) ? 206 : 200;
    res.writeHead(statusCode, resHeaders);
    upstream.data.pipe(res);
    req.on('close', () => { try { upstream.data.destroy(); } catch (_) {} });
    console.log(`[stream] ✅ Piped → ${id} (${stream.mimeType})`);
  };

  // Try all strategies in order
  const strategies = [tryYtdlp, tryPiped];
  let lastErr;
  for (const strategy of strategies) {
    try {
      await strategy();
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[stream] strategy failed: ${e.message.slice(0, 80)}`);
    }
  }
  if (!res.headersSent)
    res.status(500).json({ error: 'All streaming strategies failed: ' + lastErr?.message });
});

// ── Keep-alive endpoint (for UptimeRobot pinging) ────────────────
app.get('/ping', (_req, res) => res.send('pong'));

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ytmusicReady, pipedInstances: PIPED_INSTANCES.length, time: new Date() })
);

// ── Serve frontend ───────────────────────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api'))
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () =>
  console.log(`🎵 Mestify v2.0 → http://localhost:${PORT}`)
);