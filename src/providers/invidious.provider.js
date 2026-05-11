/**
 * Invidious Provider — uses public Invidious instances as a YouTube proxy.
 * No cookies, no PO tokens, no authentication required.
 * Rotates through multiple instances for reliability.
 */

const axios = require('axios');

// Public Invidious instances — sorted by reliability
const INSTANCES = [
  'https://invidious.io.lol',
  'https://invidious.privacydev.net',
  'https://invidious.nerdvpn.de',
  'https://iv.melmac.space',
  'https://invidious.lunar.icu',
  'https://invidious.perennialte.ch',
];

// Shuffle instances so load is distributed
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function extract(videoId) {
  const instances = shuffled(INSTANCES);
  let lastErr;

  for (const base of instances) {
    try {
      const resp = await axios.get(`${base}/api/v1/videos/${videoId}`, {
        timeout: 10000,
        params: { fields: 'adaptiveFormats,formatStreams' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const data = resp.data;
      if (!data) continue;

      // Prefer adaptive audio-only formats
      const allFormats = [
        ...(data.adaptiveFormats || []),
        ...(data.formatStreams || []),
      ];

      const audioFormats = allFormats
        .filter(f => {
          const t = f.type || '';
          return (t.includes('audio') && !t.includes('video')) || f.itag === 140;
        })
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));

      const best = audioFormats[0];
      if (best?.url) {
        console.log(`[invidious] ✅ ${base.split('//')[1]} → ${videoId}`);
        return {
          url: best.url,
          ext: best.type?.includes('opus') ? 'webm' : 'm4a',
          isHLS: false,
        };
      }
    } catch (e) {
      console.warn(`[invidious] ❌ ${base.split('//')[1]}: ${e.message.slice(0, 60)}`);
      lastErr = e;
    }
  }

  throw new Error(`All Invidious instances failed: ${lastErr?.message?.slice(0, 80)}`);
}

module.exports = { extract };
