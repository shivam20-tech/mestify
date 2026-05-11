let ytdl = null;
try {
  ytdl = require('@distube/ytdl-core');
  console.log('✅ @distube/ytdl-core loaded (fallback engine)');
} catch (e) {
  console.warn('⚠️  @distube/ytdl-core not available:', e.message);
}

async function extract(videoId) {
  if (!ytdl) throw new Error('ytdl-core not loaded');
  const info = await ytdl.getInfo(videoId);
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('No audio format found via ytdl-core');
  return {
    url: format.url,
    ext: format.container || 'mp4',
    isHLS: format.isHLS || false,
  };
}

module.exports = { extract };
