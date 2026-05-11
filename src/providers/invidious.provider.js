/**
 * Piped + Invidious Provider
 * Tries Piped API first (more reliable), then Invidious as backup.
 * Neither requires cookies, PO tokens, or authentication.
 */

const axios = require('axios');

// ── Piped API instances (primary) ────────────────────────────────────
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.syncpundit.io',
  'https://api.piped.yt',
  'https://piped.yt/api',
  'https://piped.smnz.de/api',
];

// ── Invidious API instances (backup) ─────────────────────────────────
const INVIDIOUS_INSTANCES = [
  'https://invidious.io.lol',
  'https://inv.nadeko.net',
  'https://invidious.incogniweb.net',
  'https://iv.datura.network',
  'https://invidious.privacyredirect.com',
];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Try Piped API ─────────────────────────────────────────────────────
async function tryPiped(videoId) {
  const instances = shuffled(PIPED_INSTANCES);
  for (const base of instances) {
    try {
      const resp = await axios.get(`${base}/streams/${videoId}`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const audioStreams = resp.data?.audioStreams || [];
      if (!audioStreams.length) continue;

      // Sort by bitrate descending, prefer m4a/mp4 over webm
      const sorted = audioStreams.sort((a, b) => {
        const bScore = (b.bitrate || 0) + (b.mimeType?.includes('mp4') ? 10000 : 0);
        const aScore = (a.bitrate || 0) + (a.mimeType?.includes('mp4') ? 10000 : 0);
        return bScore - aScore;
      });

      const best = sorted[0];
      if (best?.url) {
        const host = base.replace('https://', '').split('/')[0];
        console.log(`[piped] ✅ ${host} → ${videoId}`);
        const isWebm = best.mimeType?.includes('webm') || best.mimeType?.includes('opus');
        return { url: best.url, ext: isWebm ? 'webm' : 'm4a', isHLS: false };
      }
    } catch (e) {
      const host = base.replace('https://', '').split('/')[0];
      console.warn(`[piped] ❌ ${host}: ${e.message.slice(0, 50)}`);
    }
  }
  throw new Error('All Piped instances failed');
}

// ── Try Invidious API ─────────────────────────────────────────────────
async function tryInvidious(videoId) {
  const instances = shuffled(INVIDIOUS_INSTANCES);
  for (const base of instances) {
    try {
      const resp = await axios.get(`${base}/api/v1/videos/${videoId}`, {
        timeout: 8000,
        params: { fields: 'adaptiveFormats,formatStreams' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const allFormats = [
        ...(resp.data?.adaptiveFormats || []),
        ...(resp.data?.formatStreams || []),
      ];

      const audioFormats = allFormats
        .filter(f => {
          const t = f.type || '';
          return (t.includes('audio') && !t.includes('video')) || f.itag === 140;
        })
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

      const best = audioFormats[0];
      if (best?.url) {
        const host = base.replace('https://', '').split('/')[0];
        console.log(`[invidious] ✅ ${host} → ${videoId}`);
        const isWebm = best.type?.includes('opus') || best.type?.includes('webm');
        return { url: best.url, ext: isWebm ? 'webm' : 'm4a', isHLS: false };
      }
    } catch (e) {
      const host = base.replace('https://', '').split('/')[0];
      console.warn(`[invidious] ❌ ${host}: ${e.message.slice(0, 50)}`);
    }
  }
  throw new Error('All Invidious instances failed');
}

// ── Main extract: Piped first, Invidious backup ───────────────────────
async function extract(videoId) {
  try {
    return await tryPiped(videoId);
  } catch (_) {
    return await tryInvidious(videoId);
  }
}

module.exports = { extract };
