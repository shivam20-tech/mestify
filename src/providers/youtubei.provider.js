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

  // Try to get a streamable format
  const format = info.chooseFormat({ type: 'audio', quality: 'best' });
  if (!format) throw new Error('No audio format via youtubei.js');

  // Decipher the URL using the session player
  const url = format.decipher(innertube.session.player);
  if (!url || !url.startsWith('http')) throw new Error('youtubei.js deciphered URL invalid');

  return { url, ext: format.mime_type?.includes('webm') ? 'webm' : 'm4a', isHLS: false };
}

module.exports = { extract };
