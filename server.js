const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 5000;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// ═══════════════════════════════════════════════════════════════
//  API KEY ROTATION — add as many keys as you have
//  When one key hits quota (403), the next is used automatically.
//  Each key gives 10,000 units/day → 3 keys = 30,000 units/day.
// ═══════════════════════════════════════════════════════════════
const API_KEYS = [
  process.env.YT_API_KEY_1 || 'AIzaSyCu0tTmZHX04S8HUgZ8gC4ge8TczGrlzXA', 
  process.env.YT_API_KEY_2||'AIzaSyDuyJnnVDDvGmf5n7p__pL_0KSusJekFVA', 
  process.env.YT_API_KEY_3||'AIzaSyBI7mWKsexj_I2mhlxgJEM0-ROCVHmAtGA'
  // Add more keys below (create free projects at console.cloud.google.com):
  // 'AIzaSy_YOUR_SECOND_KEY_HERE',
  // 'AIzaSy_YOUR_THIRD_KEY_HERE',
];
const exhaustedUntil = {}; // key → timestamp when it can be retried (next midnight)
let keyIndex = 0;

function getActiveKey() {
  const now = Date.now();
  // Try from current index, wrap around
  for (let i = 0; i < API_KEYS.length; i++) {
    const idx = (keyIndex + i) % API_KEYS.length;
    const key = API_KEYS[idx];
    if (!exhaustedUntil[key] || now > exhaustedUntil[key]) {
      keyIndex = idx;
      return key;
    }
  }
  // All keys exhausted — return the least-recently exhausted one as fallback
  console.warn('[KeyRotate] All API keys exhausted! Quota resets at midnight PT.');
  return API_KEYS[keyIndex % API_KEYS.length];
}

function markKeyExhausted(key) {
  // Block this key until next midnight Pacific Time (~8:30 AM IST next day)
  const midnight = new Date();
  midnight.setUTCHours(8, 0, 0, 0); // midnight PT = 08:00 UTC
  if (midnight <= new Date()) midnight.setUTCDate(midnight.getUTCDate() + 1);
  exhaustedUntil[key] = midnight.getTime();
  console.warn(`[KeyRotate] Key ...${key.slice(-6)} exhausted. Next available: ${midnight.toISOString()}`);
  // Advance to next key
  keyIndex = (keyIndex + 1) % API_KEYS.length;
}

/**
 * Quota-aware YouTube API call with automatic key rotation.
 * Retries once with the next key if quota is exceeded.
 */
async function ytGet(url, params) {
  const key = getActiveKey();
  try {
    const res = await axios.get(url, { params: { ...params, key } });
    return res;
  } catch (err) {
    const status = err.response?.status;
    const reason = err.response?.data?.error?.errors?.[0]?.reason;
    if (status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
      markKeyExhausted(key);
      const nextKey = getActiveKey();
      if (nextKey === key) throw err; // all keys exhausted, give up
      console.log(`[KeyRotate] Switched to key ...${nextKey.slice(-6)}`);
      return axios.get(url, { params: { ...params, key: nextKey } });
    }
    throw err;
  }
}


// ── Search suggestions (autocomplete) ────────────────────────
app.get('/api/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    // YouTube's public suggestion endpoint — no API key needed, no quota cost
    const { data } = await axios.get('https://suggestqueries.google.com/complete/search', {
      params: { client: 'firefox', ds: 'yt', q },
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    // Response is [query, [suggestion1, suggestion2, ...]]
    const suggestions = (data[1] || []).slice(0, 8);
    res.json({ suggestions });
  } catch (err) {
    res.json({ suggestions: [] });
  }
});

// ── Search songs ──────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, pageToken } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });

  try {
    const { data } = await ytGet(`${YT_BASE}/search`, {
      part: 'snippet',
      q: `${q} song official audio`,
      type: 'video',
      videoCategoryId: '10',
      maxResults: 20,
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      videoDuration: 'medium',
      safeSearch: 'none',
      pageToken: pageToken || undefined,
    });

    const items = data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      publishedAt: item.snippet.publishedAt,
    }));

    res.json({ items, nextPageToken: data.nextPageToken || null });
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed', detail: err.response?.data?.error?.message });
  }
});

// ── Trending / charts ─────────────────────────────────────────
app.get('/api/trending', async (req, res) => {
  const { genre = 'pop', pageToken } = req.query;

  const genreMap = {
    pop: 'pop hits 2025',
    hiphop: 'hip hop hits 2025',
    rock: 'rock hits 2025',
    electronic: 'electronic dance music 2025',
    rnb: 'rnb songs 2025',
    bollywood: 'bollywood songs 2025',
    indie: 'indie pop songs 2025',
  };

  try {
    const { data } = await ytGet(`${YT_BASE}/search`, {
      part: 'snippet',
      q: genreMap[genre] || genreMap.pop,
      type: 'video',
      videoCategoryId: '10',
      order: 'viewCount',
      maxResults: 20,
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      videoDuration: 'medium',
      pageToken: pageToken || undefined,
    });

    const items = data.items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
      publishedAt: item.snippet.publishedAt,
    }));

    res.json({ items, nextPageToken: data.nextPageToken || null });
  } catch (err) {
    console.error('Trending error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Trending fetch failed', detail: err.response?.data?.error?.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  SMART AUTOPLAY HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Rolling cache of video IDs already served by /api/related.
 * Prevents the same songs from appearing across successive autoplay calls.
 * Capped at 300 entries (FIFO) so memory stays bounded.
 */
const globalSeenIds = new Set();
const SEEN_CAP = 300;
function addToGlobalSeen(id) {
  if (globalSeenIds.size >= SEEN_CAP) {
    // remove the oldest entry
    globalSeenIds.delete(globalSeenIds.values().next().value);
  }
  globalSeenIds.add(id);
}

/**
 * Strip junk suffixes from a YouTube title so we get the core song name.
 * e.g. "Blinding Lights (Official Audio) | The Weeknd" → "Blinding Lights"
 */
function extractCoreSongTitle(title) {
  return title
    .replace(/\([^)]*\)/g, '')   // remove (parentheses content)
    .replace(/\[[^\]]*\]/g, '')  // remove [bracket content]
    .replace(/\|.*/g, '')        // remove | and everything after
    .replace(/[-\u2013]\s*(official|audio|video|lyrics?|hd|4k|full|song|music|ft\.?|feat\.?).*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract 1-2 meaningful keywords from a cleaned song title.
 * Skips stopwords so we get real content words for the search query.
 * e.g. "Tum Hi Ho" → ["tum", "ho"]  |  "Shape of You" → ["shape"]
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'with',
  'from', 'by', 'as', 'up', 'out', 'so', 'if', 'not', 'no', 'me', 'you', 'he',
  'she', 'we', 'they', 'it', 'i', 'oh', 'oo', 'aa', 'hey', 'yeah', 'yeh', 'haan',
]);
function extractKeywords(cleanTitle) {
  return cleanTitle
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 2);
}

/**
 * Detect language / genre from raw title + channel name.
 * Returns a key used to select the right pool of search queries.
 */
function detectLanguage(text) {
  const t = text.toLowerCase();
  if (/marathi|lavani|koligeet|maharashtr|\bpunekar\b/.test(t)) return 'marathi';
  if (/punjabi|bhangra|\bpunjab\b/.test(t)) return 'punjabi';
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

/**
 * Detect the MOOD / ENERGY of the current song.
 * Covers Hindi/Marathi/English mood keywords so vibe is always matched.
 */
function detectMood(text) {
  const t = text.toLowerCase();

  // ── Devotional / Spiritual ──
  if (/\bbhajan\b|\baarti\b|\bkirtan\b|\bmantra\b|\bpuja\b|\bdevotional\b|\bspiritua\b|\bganesh\b|\bshiva\b|\bdurga\b|\bhanuman\b|\bsai baba\b|\bramayan\b|\bmahabharat\b|\bqawwali\b|\bsufi\b|\bdargah\b/.test(t)) return 'devotional spiritual';

  // ── Slow / Calm / Acoustic / Classical ──
  if (/\bghazal\b|\bgaza\b|\bgzl\b|\bacoustic\b|\bunplugged\b|\bballade?\b|\bsoulful\b|\bmellow\b|\bsoft\b|\bquiet\b|\bpeaceful\b|\bsoothing\b|\brelax\b|\bcalm\b|\bsleep\b|\blullaby\b|\bclassical\b|\binstrumental\b|\bfolk\b|\bambient\b|\bnature\b|\brain\b/.test(t)) return 'slow acoustic';

  // ── Sad / Heartbreak / Emotional ──
  if (/\bsad\b|\bheartbreak\b|\bheart break\b|\btears\b|\bcrying\b|\balone\b|\bdard\b|\bgham\b|\btanha\b|\bbichhad\b|\bviraham\b|\bdardan\b|\bjudai\b|\btoota\b|\bbijura\b|\brokke\b|\bwoh lamhe\b|\byaadein\b/.test(t)) return 'sad emotional';

  // ── Romantic / Love ──
  if (/\bromantic\b|\blove song\b|\bpyaar\b|\bishq\b|\bmohabbat\b|\bprem\b|\bpremache\b|\bpiya\b|\bdildar\b|\bsajna\b|\bsajni\b|\bjaan\b|\bdilkash\b|\bdil se\b|\baaşk\b|\bintimaa?te?\b/.test(t)) return 'romantic love';

  // ── Lo-fi / Chill ──
  if (/\blo[\s-]?fi\b|\bchill\b|\bvibes?\b|\bstudy\b|\bcafe\b|\bcozy\b|\brainy day\b|\bnight drive\b/.test(t)) return 'lofi chill';

  // ── Party / Dance / DJ ──
  if (/\bparty\b|\bdance\b|\b\bdj\b|\bclub\b|\bbanger\b|\bhype\b|\btwerk\b|\bgarba\b|\bdisco\b|\bredm\b|\btechno\b|\bhouse\b/.test(t)) return 'party dance';

  // ── Bhangra / Punjabi upbeat ──
  if (/\bbhangra\b|\bpunjabi dance\b|\bdhol\b/.test(t)) return 'bhangra upbeat';

  // ── Workout / Power ──
  if (/\bworkout\b|\bgym\b|\bmotivat\b|\bpower\b|\bfire\b|\bpump\b/.test(t)) return 'workout power';

  return ''; // unknown — let title + genre lead
}

/**
 * Returns true if a result song's title CLASHES with the current mood.
 * Prevents energetic songs appearing in a slow/chill queue and vice-versa.
 */
const ENERGETIC_WORDS = /\b(party|dance|dj|club|banger|hype|twerk|garba|disco|edm|techno|rave|bhangra|dhol|drill|trap|bass|drop|workout|gym|fire|pump)\b/i;
const CALM_WORDS = /\b(slow|chill|lofi|lo-fi|acoustic|unplugged|soft|quiet|peaceful|soothing|relax|sleep|ballad|mellow|classical|ghazal|sufi|devotional|sad|heartbreak)\b/i;

function isMoodClash(resultTitle, currentMood) {
  if (!currentMood) return false;
  const isCalmMood = /slow|acoustic|sad|emotional|romantic|lofi|chill|devotional|spiritual/.test(currentMood);
  const isEnergyMood = /party|dance|bhangra|workout|power/.test(currentMood);
  if (isCalmMood && ENERGETIC_WORDS.test(resultTitle)) return true;  // calm song → no DJ/party results
  if (isEnergyMood && CALM_WORDS.test(resultTitle)) return true;  // party song → no sad/slow results
  return false;
}

/**
 * Per-genre pool of diverse search queries.
 * 3 different angles per genre → more variety in results.
 */
const GENRE_QUERIES = {
  marathi: ['marathi songs 2025 official', 'new marathi pop hits', 'marathi trending songs playlist'],
  punjabi: ['punjabi hits 2025 official', 'new punjabi songs playlist', 'top punjabi music 2025'],
  bollywood: ['bollywood hits 2025 official', 'new hindi songs 2025', 'top bollywood songs playlist'],
  tamil: ['tamil hits 2025 official', 'new tamil songs', 'popular kollywood songs'],
  telugu: ['telugu hits 2025 official', 'new telugu songs', 'popular telugu music'],
  kannada: ['kannada hits 2025 official', 'new kannada songs playlist'],
  malayalam: ['malayalam hits 2025 official', 'new malayalam songs playlist'],
  kpop: ['kpop hits 2025', 'popular kpop songs playlist', 'new kpop releases'],
  lofi: ['lofi chill music mix', 'chill study beats playlist', 'relaxing lofi hip hop'],
  hiphop: ['hip hop hits 2025', 'rap songs 2025', 'new hip hop tracks'],
  rock: ['rock hits playlist', 'popular rock songs 2025', 'classic rock songs'],
  rnb: ['rnb hits 2025', 'new r&b songs playlist', 'popular rnb music'],
  electronic: ['electronic dance music 2025', 'edm hits playlist', 'popular electronic songs'],
  pop: ['pop hits 2025', 'popular songs 2025', 'top charting songs'],
};

/**
 * Junk patterns — versions we never want in autoplay.
 * Remixes, slowed/reverb, covers, karaoke, lyric videos, ringtones, etc.
 */
const JUNK_PATTERN = /\b(remix|remixed|slowed|reverb|sped[\s-]?up|speed[\s-]?up|nightcore|8d[\s-]?audio|432[\s-]?hz|lofi[\s-]?version|lo[\s-]?fi[\s-]?version|cover|covers|karaoke|instrumental|bgm|ringtone|ost|status|whatsapp|lyric[\s-]?video|lyrics?|making[\s-]?of|behind[\s-]?the[\s-]?scenes|acoustic[\s-]?version|unplugged[\s-]?version|mashup|medley|tribute|parody|reaction|extended[\s-]?mix|radio[\s-]?edit)\b/i;

function isJunkVideo(title) {
  return JUNK_PATTERN.test(title);
}

/**
 * Normalise a title for similarity comparison.
 * lowercase → strip punctuation → collapse whitespace
 */
function normaliseTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Returns true if `title` shares ≥50% of its meaningful words
 * with any title already seen → near-duplicate, skip it.
 * Threshold lowered from 55% → 50% for tighter deduplication.
 */
function isNearDuplicate(title, seenTitles) {
  const words = normaliseTitle(title).split(' ').filter(w => w.length > 3);
  if (!words.length) return false;
  for (const seen of seenTitles) {
    const sw = normaliseTitle(seen).split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => sw.includes(w)).length;
    const ratio = matches / Math.max(words.length, sw.length, 1);
    if (ratio >= 0.50) return true;
  }
  return false;
}

/** Fisher-Yates shuffle so the playlist feels different each time */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Smart Related / Autoplay ──────────────────────────────────
// Strategy:
//  1. Fetch the current song's title + channel from YouTube
//  2. Clean the title; detect language/genre
//  3. Build 3 diverse queries:
//       Q1 – Artist name  ("Arijit Singh songs")
//       Q2 – Title keyword + genre label  ("tum ho bollywood hits")
//       Q3 – Generic genre pool query  ("bollywood hits 2025")
//  4. Merge results; skip junk & near-duplicates using the global seen cache
//  5. Shuffle so every autoplay feels fresh
app.get('/api/related/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    // ── Step 1: fetch current song metadata ──────────────────────
    const { data: vData } = await ytGet(`${YT_BASE}/videos`, { part: 'snippet', id: videoId });

    const snippet = vData.items?.[0]?.snippet;
    if (!snippet) throw new Error('Video not found');

    const rawTitle = snippet.title;
    const channel = snippet.channelTitle;

    // ── Step 2: clean + analyse ───────────────────────────────────
    const cleanTitle = extractCoreSongTitle(rawTitle);
    const lang = detectLanguage(`${rawTitle} ${channel}`);
    const keywords = extractKeywords(cleanTitle);  // e.g. ['tum', 'ho']

    // Clean artist name — strip record label noise
    const artistKw = channel
      .replace(/\s*(official|music|records|entertainment|vevo|films?|studios?|productions?|india)\s*/gi, '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');

    // Genre label used in queries (human-readable)
    const genreLabel = {
      marathi: 'marathi', punjabi: 'punjabi', bollywood: 'bollywood hindi',
      tamil: 'tamil', telugu: 'telugu', kannada: 'kannada', malayalam: 'malayalam',
      kpop: 'kpop', lofi: 'lofi chill', hiphop: 'hip hop', rock: 'rock',
      rnb: 'rnb', electronic: 'edm electronic', pop: 'pop',
    }[lang] || 'pop';

    // ── Step 3: detect mood + assemble 3 vibe-matched queries ──────
    const mood = detectMood(`${rawTitle} ${channel}`);
    const queries = [];

    // Q1 – artist + mood (most relevant: same artist, same vibe)
    if (artistKw.length > 2) {
      const q1 = mood
        ? `${artistKw} ${mood} songs`
        : `${artistKw} songs official audio`;
      queries.push(q1);
    }

    // Q2 – language/genre + mood (keeps the language AND vibe)
    if (mood) {
      queries.push(`${genreLabel} ${mood} songs`);
    } else if (keywords.length) {
      queries.push(`${keywords.join(' ')} ${genreLabel} songs`);
    } else {
      queries.push(`${genreLabel} songs 2025`);
    }

    // Q3 – use actual song title as context when no mood, else genre+mood
    const poolQueries = GENRE_QUERIES[lang] || GENRE_QUERIES.pop;
    const basePool = poolQueries[Math.floor(Math.random() * poolQueries.length)];
    if (mood) {
      queries.push(`${basePool} ${mood}`);
    } else if (cleanTitle.length > 3) {
      // Best fallback: "songs like [current song title]" — YouTube understands this well
      queries.push(`songs like ${cleanTitle} ${genreLabel}`);
    } else {
      queries.push(basePool);
    }

    console.log(`[Related] mood="${mood || 'none'}" lang=${lang} kw=[${keywords}] queries:`, queries);


    // ── Step 4: fetch, filter, deduplicate ───────────────────────
    // Always exclude the currently playing song + everything seen globally
    const localSeen = new Set([videoId, ...globalSeenIds]);
    const seenTitles = [rawTitle];  // also exclude the current song's title
    const allItems = [];

    for (const q of queries) {
      try {
        const { data } = await ytGet(`${YT_BASE}/search`, {
          part: 'snippet',
          q,
          type: 'video',
          videoCategoryId: '10',
          maxResults: 15,
          videoEmbeddable: 'true',
          videoSyndicated: 'true',
          videoDuration: 'medium',
          order: 'relevance',
        });

        for (const item of (data.items || [])) {
          const id = item.id.videoId;
          const title = item.snippet.title;

          if (localSeen.has(id)) continue; // exact duplicate
          if (isJunkVideo(title)) continue; // remix/slowed/etc.
          if (isNearDuplicate(title, seenTitles)) continue; // same song, diff upload
          if (isMoodClash(title, mood)) continue; // wrong vibe

          localSeen.add(id);
          seenTitles.push(title);
          allItems.push({
            id,
            title,
            artist: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
            publishedAt: item.snippet.publishedAt,
          });
        }
      } catch (qErr) {
        console.warn(`[Related] Query "${q}" failed:`, qErr.message);
      }
    }

    // ── Step 5: shuffle, cap, update global cache ─────────────────
    const items = shuffleArray(allItems).slice(0, 20);
    items.forEach(s => addToGlobalSeen(s.id));  // remember them for next call
    addToGlobalSeen(videoId);

    console.log(`[Related] Returning ${items.length} unique tracks for lang=${lang}`);
    res.json({ items });

  } catch (err) {
    console.error('[Related] Error:', err.response?.data || err.message);

    // ── Hard fallback: popular music so autoplay never fully breaks ──
    try {
      const { data: fallback } = await ytGet(`${YT_BASE}/search`, {
        part: 'snippet',
        q: 'popular music hits 2025 official audio',
        type: 'video',
        videoCategoryId: '10',
        order: 'viewCount',
        maxResults: 15,
        videoEmbeddable: 'true',
        videoDuration: 'medium',
      });
      const items = fallback.items
        .filter(item => !isJunkVideo(item.snippet.title) && !globalSeenIds.has(item.id.videoId))
        .map(item => ({
          id: item.id.videoId,
          title: item.snippet.title,
          artist: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails?.high?.url,
          publishedAt: item.snippet.publishedAt,
        }));
      items.forEach(s => addToGlobalSeen(s.id));
      res.json({ items });
    } catch (e2) {
      res.status(500).json({ error: 'Related fetch failed' });
    }
  }
});

// ── Video details (duration, views, etc.) ─────────────────────
app.get('/api/video/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const { data } = await ytGet(`${YT_BASE}/videos`, {
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });
    const v = data.items?.[0];
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: v.id,
      title: v.snippet.title,
      artist: v.snippet.channelTitle,
      thumbnail: v.snippet.thumbnails?.maxres?.url || v.snippet.thumbnails?.high?.url,
      duration: v.contentDetails.duration,
      views: v.statistics.viewCount,
      publishedAt: v.snippet.publishedAt,
    });
  } catch (err) {
    console.error('Video details error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Video details failed' });
  }
});

// ── Featured playlists ────────────────────────────────────────
app.get('/api/playlists', (_req, res) => {
  const featured = [
    { id: 'PLrEnWoR732-BHrPp_Pm8_VleD68f9s14-', name: 'Top Hits 2025', genre: 'Pop' },
    { id: 'RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyO_H8bi3Wk', name: 'Bollywood Blockbusters', genre: 'Bollywood' },
    { id: 'PLH6pfBXQXHEC2uDmDy6ZNNfkzSMzJOhGg', name: 'Chill Vibes', genre: 'Chill' },
  ];
  res.json({ playlists: featured });
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Catch-all: serve index.html ───────────────────────────────
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});
const ytdl = require('@distube/ytdl-core');

// ── Stream audio (for iOS background playback) ──────────────
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Get audio-only info
    const info = await ytdl.getInfo(url);
    const audioFormat = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    if (!audioFormat) {
      return res.status(404).json({ error: 'No audio stream found' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Handle range requests (needed for seeking on iOS)
    const range = req.headers.range;
    const stream = ytdl(url, {
      format: audioFormat,
      ...(range && { range: parseRange(range) }),
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Stream endpoint error:', err.message);
    res.status(500).json({ error: 'Stream failed', detail: err.message });
  }
});

function parseRange(rangeHeader) {
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;
  return {
    start: parseInt(match[1]),
    end: match[2] ? parseInt(match[2]) : undefined,
  };
}

app.listen(PORT, () =>
  console.log(`🎵 Mestify backend running → http://localhost:${PORT}`)
);
