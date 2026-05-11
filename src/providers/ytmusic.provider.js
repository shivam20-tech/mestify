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

// ── play-dl search (reliable cross-region fallback) ───────────────────
let playdl = null;
try {
  playdl = require('play-dl');
  console.log('✅ play-dl loaded (search fallback)');
} catch (_) {}

async function playDlSearch(query, limit = 15) {
  if (!playdl) return [];
  try {
    const results = await playdl.search(query, {
      source: { youtube: 'video' },
      limit: limit + 5,
    });
    return results
      .map(r => ({
        id: r.id,
        title: r.title || '',
        artist: r.channel?.name || 'Unknown',
        thumbnail: r.thumbnails?.[r.thumbnails.length - 1]?.url
          || r.thumbnails?.[0]?.url
          || '',
      }))
      .filter(s => s.id && s.title)
      .slice(0, limit);
  } catch (e) {
    console.warn('[ytmusic] play-dl search failed:', e.message.slice(0, 60));
    return [];
  }
}

// ── yt-search fallback (last resort) ─────────────────────────────────
let ytsearch = null;
try { ytsearch = require('yt-search'); } catch (_) {}

async function ytSearchFallback(query, limit = 15) {
  if (!ytsearch) return [];
  try {
    const r = await ytsearch(query);
    return (r.videos || []).slice(0, limit).map(v => ({
      id: v.videoId,
      title: v.title,
      artist: v.author?.name || v.author || 'Unknown',
      thumbnail: v.thumbnail || '',
    })).filter(s => s.id && s.title);
  } catch (_) { return []; }
}

// ── Unified search: ytmusic-api → play-dl → yt-search ────────────────
async function searchSongs(query, limit = 15) {
  // 1. Try ytmusic-api (best quality results)
  if (ready) {
    try {
      const results = await ytmusic.searchSongs(query);
      const mapped = results.slice(0, limit).map(song => ({
        id: song.videoId,
        title: song.name,
        artist: song.artist?.name || song.artists?.[0]?.name || 'Unknown',
        thumbnail: song.thumbnails?.[song.thumbnails.length - 1]?.url || song.thumbnails?.[0]?.url || '',
      })).filter(s => s.id && s.title);
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn('[ytmusic] searchSongs → play-dl fallback:', e.message.slice(0, 50));
    }
  }

  // 2. Fallback: play-dl
  const pdResults = await playDlSearch(query, limit);
  if (pdResults.length) {
    console.log(`[ytmusic] play-dl returned ${pdResults.length} results`);
    return pdResults;
  }

  // 3. Last resort: yt-search
  return ytSearchFallback(query, limit);
}

async function search(query, limit = 20) {
  if (ready) {
    try {
      const results = await ytmusic.search(query);
      const mapped = (results || []).slice(0, limit)
        .filter(s => s.videoId && s.name)
        .map(s => ({
          id: s.videoId,
          title: s.name,
          artist: s.artist?.name || s.artists?.[0]?.name || 'Unknown',
          thumbnail: s.thumbnails?.[0]?.url || '',
        }));
      if (mapped.length) return mapped;
    } catch (e) {
      console.warn('[ytmusic] search → play-dl fallback:', e.message.slice(0, 50));
    }
  }

  const pdResults = await playDlSearch(query, limit);
  if (pdResults.length) return pdResults;
  return ytSearchFallback(query, limit);
}

module.exports = { searchSongs, search, isReady };
