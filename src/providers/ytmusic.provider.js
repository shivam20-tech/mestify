const YTMusic = require('ytmusic-api');

const ytmusic = new YTMusic();
let ready = false;

(async () => {
  try {
    await ytmusic.initialize();
    ready = true;
    console.log('✅ ytmusic-api initialized');
  } catch (e) {
    console.error('❌ ytmusic-api init failed:', e.message);
  }
})();

function isReady() { return ready; }

async function searchSongs(query, limit = 15) {
  if (!ready) return [];
  try {
    const results = await ytmusic.searchSongs(query);
    return results.slice(0, limit).map(song => ({
      id: song.videoId,
      title: song.name,
      artist: song.artist?.name || song.artists?.[0]?.name || 'Unknown',
      thumbnail: song.thumbnails?.[song.thumbnails.length - 1]?.url || song.thumbnails?.[0]?.url || '',
    })).filter(s => s.id && s.title);
  } catch (e) {
    console.warn('[ytmusic] searchSongs error:', e.message);
    return [];
  }
}

async function search(query, limit = 20) {
  if (!ready) return [];
  try {
    const results = await ytmusic.search(query);
    return (results || []).slice(0, limit)
      .filter(s => s.videoId && s.name)
      .map(s => ({
        id: s.videoId,
        title: s.name,
        artist: s.artist?.name || s.artists?.[0]?.name || 'Unknown',
        thumbnail: s.thumbnails?.[0]?.url || '',
      }));
  } catch (e) {
    console.warn('[ytmusic] search error:', e.message);
    return [];
  }
}

module.exports = { searchSongs, search, isReady };
