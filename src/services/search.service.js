const ytmusic = require('../providers/ytmusic.provider');

// Import dead-video awareness so we can filter geo-blocked IDs from results
// before they ever reach the frontend player
let _isDeadVideo = () => false; // safe default before stream service loads
try {
  const streamSvc = require('./stream.service');
  if (streamSvc.isDeadVideo) _isDeadVideo = streamSvc.isDeadVideo;
} catch (_) {}

// ── Language & Mood detection ─────────────────────────────────────────
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

function extractCoreSongTitle(title) {
  return title
    .replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\|.*/g, '')
    .replace(/[-–]\s*(official|audio|video|lyrics?|hd|4k|full|song|music|ft\.?|feat\.).*$/gi, '')
    .replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set(['the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','my','your','his','her','its','our','their','this','that','with','from','by','i','oh','oo','aa','hey','yeah','yeh','haan']);
function extractKeywords(title) {
  return title.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 2);
}

const ENERGETIC = /\b(party|dance|dj|club|banger|hype|garba|disco|edm|techno|rave|bhangra|dhol|drill|trap|bass|drop|workout|gym|fire|pump)\b/i;
const CALM = /\b(slow|chill|lofi|lo-fi|acoustic|unplugged|soft|quiet|peaceful|soothing|relax|sleep|ballad|mellow|classical|ghazal|sufi|devotional|sad|heartbreak)\b/i;
function isMoodClash(resultTitle, mood) {
  if (!mood) return false;
  const isCalmMood = /slow|acoustic|sad|emotional|romantic|lofi|chill|devotional|spiritual/.test(mood);
  const isEnergyMood = /party|dance|bhangra|workout|power/.test(mood);
  if (isCalmMood && ENERGETIC.test(resultTitle)) return true;
  if (isEnergyMood && CALM.test(resultTitle)) return true;
  return false;
}

const JUNK = /\b(remix|remixed|slowed|reverb|sped[\s-]?up|nightcore|8d[\s-]?audio|432[\s-]?hz|cover|karaoke|instrumental|bgm|ringtone|status|whatsapp|lyric[\s-]?video|lyrics?|making[\s-]?of|acoustic[\s-]?version|unplugged[\s-]?version|mashup|medley|tribute|parody|reaction|extended[\s-]?mix|radio[\s-]?edit)\b/i;
function isJunk(title) { return JUNK.test(title); }

function normalise(title) { return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(); }
function isNearDuplicate(title, seenTitles) {
  const words = normalise(title).split(' ').filter(w => w.length > 3);
  if (!words.length) return false;
  for (const seen of seenTitles) {
    const sw = normalise(seen).split(' ').filter(w => w.length > 3);
    if (words.filter(w => sw.includes(w)).length / Math.max(words.length, sw.length, 1) >= 0.72) return true;
  }
  return false;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
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
  pop: ['pop hits 2025', 'popular songs 2025', 'top charting songs'],
};

// Global dedup set
const globalSeenIds = new Set();
const SEEN_CAP = 300;
function addToGlobalSeen(id) {
  if (globalSeenIds.size >= SEEN_CAP) globalSeenIds.delete(globalSeenIds.values().next().value);
  globalSeenIds.add(id);
}

// ── Public API ────────────────────────────────────────────────────────

async function search(query) {
  const items = await ytmusic.searchSongs(query, 20);
  if (items.length) return items;
  return ytmusic.search(query, 20);
}

async function trending(genre = 'pop') {
  const pool = GENRE_QUERIES[genre] || GENRE_QUERIES.pop;
  const query = pool[Math.floor(Math.random() * pool.length)];
  return ytmusic.searchSongs(query, 20);
}

async function related(videoId, rawTitle = '', rawArtist = '') {
  const cleanTitle = extractCoreSongTitle(rawTitle);
  const lang = detectLanguage(`${rawTitle} ${rawArtist}`);
  const mood = detectMood(`${rawTitle} ${rawArtist}`);
  const keywords = extractKeywords(cleanTitle);
  const genreLabel = { marathi:'marathi', punjabi:'punjabi', bollywood:'bollywood hindi', tamil:'tamil', telugu:'telugu', kannada:'kannada', malayalam:'malayalam', kpop:'kpop', lofi:'lofi chill', hiphop:'hip hop', rock:'rock', rnb:'rnb', electronic:'edm electronic', pop:'pop' }[lang] || 'pop';
  const artistKw = rawArtist.replace(/\s*(official|music|records|entertainment|vevo|films?|studios?|india)\s*/gi, '').trim().split(/\s+/).slice(0, 2).join(' ');

  const queries = [];
  if (artistKw.length > 2) queries.push(mood ? `${artistKw} ${mood} songs` : `${artistKw} songs`);
  if (mood) queries.push(`${genreLabel} ${mood} songs`);
  else if (keywords.length) queries.push(`${keywords.join(' ')} ${genreLabel} songs`);
  else queries.push(`${genreLabel} songs 2025`);
  const poolQ = GENRE_QUERIES[lang] || GENRE_QUERIES.pop;
  queries.push(poolQ[Math.floor(Math.random() * poolQ.length)]);

  const localSeen = new Set([videoId, ...globalSeenIds]);
  const seenTitles = rawTitle ? [rawTitle] : [];
  const allItems = [];

  for (const q of queries) {
    try {
      const results = await ytmusic.searchSongs(q, 15);
      for (const item of results) {
        if (localSeen.has(item.id)) continue;
        if (_isDeadVideo(item.id)) continue;
        if (isJunk(item.title)) continue;
        if (isNearDuplicate(item.title, seenTitles)) continue;
        if (isMoodClash(item.title, mood)) continue;
        localSeen.add(item.id); seenTitles.push(item.title); allItems.push(item);
      }
    } catch (_) {}
  }

  const items = shuffle(allItems).slice(0, 20);
  items.forEach(s => addToGlobalSeen(s.id));
  addToGlobalSeen(videoId);
  return items;
}

module.exports = { search, trending, related };
