const YTMusic = require('ytmusic-api');

const ytmusic = new YTMusic();
let ready = false;

// We also use youtubei.js as a fallback search engine
// (imported lazily to avoid circular deps)
let _innertubeSearch = null;
async function getInnertubeSearch() {
  if (_innertubeSearch) return _innertubeSearch;
  try {
    const { Innertube } = require('youtubei.js');
    const yt = await Innertube.create();
    _innertubeSearch = yt;
    return yt;
  } catch (_) { return null; }
}

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

// ── Map youtubei.js result → standard track format ───────────────────
function mapYtjsTrack(t) {
  if (!t) return null;
  const id = t.id || t.video_id || t.videoId;
  const title = t.title?.text || t.title || t.name;
  const artist = t.artists?.[0]?.name
    || t.author?.name
    || t.short_description?.text
    || 'Unknown';
  const thumbnail = t.thumbnail?.contents?.[0]?.url
    || t.thumbnails?.[0]?.url
    || '';
  if (!id || !title) return null;
  return { id, title, artist, thumbnail };
}

// ── Search via youtubei.js Music ─────────────────────────────────────
async function innertubeSearch(query, limit = 15) {
  try {
    const yt = await getInnertubeSearch();
    if (!yt) return [];

    const results = await yt.music.search(query, { type: 'song' });
    const tracks = [];

    // Walk all sections (MusicShelf nodes)
    for (const section of (results?.contents || [])) {
      const items = section?.contents || section?.results || [];
      for (const item of items) {
        try {
          const id = item.id;
          // title is a Text node in youtubei.js
          const title = item.title?.text ?? item.title ?? item.name;
          const artist = item.artists?.[0]?.name
            ?? item.author?.name
            ?? item.short_description?.text
            ?? 'Unknown';
          const thumbnail = item.thumbnails?.contents?.[0]?.url
            ?? item.thumbnails?.[0]?.url
            ?? item.thumbnail?.url
            ?? '';
          if (id && title) tracks.push({ id, title, artist, thumbnail });
        } catch (_) {}
      }
    }

    if (tracks.length) {
      console.log(`[ytmusic] innertube search returned ${tracks.length} results for "${query}"`);
    } else {
      console.warn(`[ytmusic] innertube search returned 0 results for "${query}"`);
    }

    return tracks.slice(0, limit);
  } catch (e) {
    console.warn('[ytmusic] innertube search failed:', e.message.slice(0, 80));
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────

async function searchSongs(query, limit = 15) {
  // Try ytmusic-api first, fall back to youtubei.js on 400/error
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
      console.warn('[ytmusic] searchSongs error → falling back to youtubei.js:', e.message.slice(0, 60));
    }
  }
  // Fallback: youtubei.js Music search
  return innertubeSearch(query, limit);
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
      console.warn('[ytmusic] search error → falling back to youtubei.js:', e.message.slice(0, 60));
    }
  }
  return innertubeSearch(query, limit);
}

module.exports = { searchSongs, search, isReady };
