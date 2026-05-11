const { Innertube } = require('youtubei.js');
const fs = require('fs');
const path = require('path');

let innertube = null;

// Parse Netscape cookies.txt → cookie header string for Innertube
function readCookieString() {
  const cookiesPath = path.join(process.cwd(), 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) return '';
  try {
    return fs.readFileSync(cookiesPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => {
        const parts = l.split('\t');
        return parts.length >= 7 ? `${parts[5]}=${parts[6].trim()}` : null;
      })
      .filter(Boolean)
      .join('; ');
  } catch (_) { return ''; }
}

async function init() {
  try {
    const cookie = readCookieString();
    innertube = await Innertube.create({
      cookie: cookie || undefined,
      retrieve_player: true,
    });

    // Suppress noisy internal [YOUTUBEJS][Text] attachment run warnings
    try {
      const { Log } = require('youtubei.js/dist/src/utils/Log.js');
      if (Log && Log.setLevel) Log.setLevel(Log.Level.ERROR);
    } catch (_) {
      // Log suppression not available in this version — harmless
    }

    console.log(`✅ youtubei.js initialized${cookie ? ' (with cookies ✅)' : ' (no cookies)'}`);
  } catch (e) {
    console.warn('⚠️  youtubei.js init failed:', e.message);
  }
}

// Called from server.js after new cookies are injected
async function reinit() {
  innertube = null;
  await init();
}

init();

async function extract(videoId) {
  if (!innertube) throw new Error('youtubei.js not initialized');

  const info = await innertube.getInfo(videoId);
  const streamingData = info.streaming_data;
  if (!streamingData) throw new Error('No streaming_data from youtubei.js');

  // Collect all formats, prefer adaptive (audio-only)
  const allFormats = [
    ...(streamingData.adaptive_formats || []),
    ...(streamingData.formats || []),
  ];

  // Pick best audio-only format by bitrate
  const audioFormats = allFormats
    .filter(f => f.has_audio && !f.has_video)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  if (!audioFormats.length) throw new Error('No audio-only formats via youtubei.js');

  const format = audioFormats[0];

  // v17: some formats have a plain .url, others need .decipher(player)
  let url = format.url;
  if (!url || !url.startsWith('http')) {
    try {
      url = format.decipher(innertube.session.player);
    } catch (e) {
      throw new Error(`youtubei.js decipher failed: ${e.message}`);
    }
  }

  if (!url || !url.startsWith('http')) throw new Error('youtubei.js could not produce a valid URL');

  const isWebm = format.mime_type?.includes('webm') || format.mime_type?.includes('opus');
  return { url, ext: isWebm ? 'webm' : 'm4a', isHLS: false };
}

module.exports = { extract, reinit };

