const { Innertube } = require('youtubei.js');

let innertube = null;

(async () => {
  try {
    innertube = await Innertube.create({ retrieve_player: true });
    console.log('✅ youtubei.js (InnerTube) initialized');
  } catch (e) {
    console.warn('⚠️  youtubei.js init failed:', e.message);
  }
})();

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

module.exports = { extract };

