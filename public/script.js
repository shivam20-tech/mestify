
// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
// Auto-detect: use local backend when running locally, else use Railway
const BACKEND_URL = location.origin;
// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
let ytPlayer = null, ytReady = false;
let queue = [], browseList = [], queueIdx = -1;
let isPlaying = false, isShuffle = false, isRepeat = false;
let isRadio = false, isAutoplay = true;
let volume = 80, isMuted = false;
let liked = JSON.parse(localStorage.getItem('mestify_liked') || '{}');
let recentlyPlayed = JSON.parse(localStorage.getItem('mestify_recent') || '[]');
let currentGenre = 'pop';
let progressInterval = null;
let sleepTimer = null, sleepEndsAt = null;
// Auth + history tracking vars (declared here to avoid TDZ)
let currentUser = null, loginMode = 'login';
let _playStart = 0, _lastPlayedId = null;
let _isSwitching = false;
const isMobile = () => window.innerWidth <= 768;

// Save to recently played (max 20)
function addToRecentlyPlayed(song) {
    recentlyPlayed = recentlyPlayed.filter(s => s.id !== song.id);
    recentlyPlayed.unshift(song);
    if (recentlyPlayed.length > 20) recentlyPlayed = recentlyPlayed.slice(0, 20);
    localStorage.setItem('mestify_recent', JSON.stringify(recentlyPlayed));
}

// ─── YT API ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
//  AUDIO PLAYER (works on iOS background + lock screen!)
// ═══════════════════════════════════════════════════════════════
const audio = document.getElementById('audioPlayer');
audio.preload = 'auto';
audio.volume = volume / 100;
ytReady = true; // for compatibility with rest of code

audio.addEventListener('play', () => {
    isPlaying = true;
    updatePlayBtn();
    startProgress();
});

audio.addEventListener('pause', () => {
    isPlaying = false;
    updatePlayBtn();
    stopProgress();
});

// Guard: true while we are intentionally switching to a new song
// (_isSwitching declared at top with other vars)

audio.addEventListener('ended', () => {
    isPlaying = false;
    updatePlayBtn();
    stopProgress();
    if (typeof onSongEnd === 'function') onSongEnd(queue[queueIdx], audio.duration || 0);
    if (isRepeat) { audio.currentTime = 0; audio.play(); }
    else if (isRadio) loadRadio(queue[queueIdx]?.id);
    else playNext(); // Play next song synchronously to support iOS/Android background/lockscreen play!
});

// Only fire for real stream errors, not during intentional src switches
audio.addEventListener('error', () => {
    if (_isSwitching) return;  // Ignore — we caused this by changing src
    const song = queue[queueIdx];
    if (!song) return;
    console.warn('[audio error] reconnecting:', song.id);
    toast('Stream error, retrying…');
    setTimeout(() => {
        _isSwitching = true;
        audio.src = `${BACKEND_URL}/api/stream/${song.id}?t=${Date.now()}`;
        setTimeout(() => {
            _isSwitching = false;
            audio.play().catch(() => playNext());
        }, 500);
    }, 300);
});

audio.addEventListener('loadedmetadata', () => {
    document.getElementById('durTime').textContent = fmtTime(audio.duration);
    document.getElementById('expDur').textContent = fmtTime(audio.duration);
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isPlaying && audio.paused && audio.src) {
        audio.play().catch(() => {
            toast('Tap play to resume music');
        });
    }
});

// Wrapper to make audio compatible with old YT player calls
ytPlayer = {
    loadVideoById: (id) => {
        _isSwitching = true;
        audio.src = `${BACKEND_URL}/api/stream/${id}?t=${Date.now()}`;

        // Play synchronously to maintain iOS/Android user activation context for background play!
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                console.warn('[synchronous play failed, will retry]', err.message);
                // Fallback retry
                setTimeout(() => {
                    audio.play().catch(e => console.error('[play retry failed]', e));
                }, 200);
            });
        }

        // Revert switching flag after a brief tick to allow abort/loading events to clear
        setTimeout(() => {
            _isSwitching = false;
        }, 100);
    },
    playVideo: () => {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                console.error('Play failed:', err);
                // iOS requires user interaction. If it fails, we pause the UI.
                isPlaying = false;
                updatePlayBtn();
                toast('Tap play to start music 🎵');
            });
        }
    },
    pauseVideo: () => audio.pause(),
    seekTo: (sec) => { audio.currentTime = sec; },
    setVolume: (v) => { audio.volume = v / 100; },
    mute: () => { audio.muted = true; },
    unMute: () => { audio.muted = false; },
    getCurrentTime: () => audio.currentTime || 0,
    getDuration: () => audio.duration || 0,
    getPlayerState: () => audio.paused ? 2 : 1,
};

// Stub for YT compatibility
window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 } };

// ─── API ─────────────────────────────────────────────────────────
async function apiFetch(path) {
    const r = await fetch(BACKEND_URL + path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}

// ─── Toast ──────────────────────────────────────────────────────
function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

// ─── Skeletons ──────────────────────────────────────────────────
function skeletonGrid(n = 6) { return Array.from({ length: n }, () => '<div class="skeleton skeleton-card"></div>').join(''); }
function skeletonList(n = 8) { return Array.from({ length: n }, () => '<div class="skeleton skeleton-row"></div>').join(''); }

// ─── Card / Row HTML ────────────────────────────────────────────
const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='160' height='160' fill='%2316161f'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dominant-baseline='middle' font-size='48'%3E%F0%9F%8E%B5%3C/text%3E%3C/svg%3E`;

function cardHTML(song, idx) {
    const isActive = queue[queueIdx]?.id === song.id;
    const waveBars = isActive ? '<div class="wave-bars"><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div></div>' : '';
    return `
  <div class="song-card${isActive ? ' playing' : ''}" data-songid="${song.id}" onclick="playSongFromBrowse(${idx})">
    <div class="card-thumb">
      <img src="${song.thumbnail}" alt="${song.title}" loading="lazy" onerror="this.src='${FALLBACK_IMG}'" />
      <div class="card-overlay">
        <button class="play-btn-card"><i class="fa-solid ${isActive ? 'fa-pause' : 'fa-play'}"></i></button>
      </div>
      ${waveBars}
    </div>
    <div class="card-info">
      <div class="card-title" title="${song.title}">${song.title}</div>
      <div class="card-artist">${song.artist}</div>
    </div>
  </div>`;
}

function rowHTML(song, idx) {
    const isLiked = !!liked[song.id];
    const isActive = queue[queueIdx]?.id === song.id;
    return `
  <div class="song-row${isActive ? ' playing' : ''}" data-songid="${song.id}" onclick="playSongFromBrowse(${idx})">
    <img class="song-row-thumb" src="${song.thumbnail}" alt="" loading="lazy" onerror="this.src='${FALLBACK_IMG}'" />
    <div class="song-row-info">
      <h4>${song.title}</h4>
      <p>${song.artist}</p>
    </div>
    <div class="song-row-actions" onclick="event.stopPropagation()">
      <button class="icon-btn${isLiked ? ' liked' : ''}" onclick="toggleLike('${song.id}',this)">
        <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart"></i>
      </button>
      <button class="icon-btn" title="Add to queue" onclick="addBrowseToQueue(${idx})"><i class="fa-solid fa-circle-plus"></i></button>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  VIEWS
// ═══════════════════════════════════════════════════════════════
async function renderHome() {
    document.getElementById('pageTitle').textContent = 'Home';
    const content = document.getElementById('content');
    
    const name = currentUser ? currentUser.name : 'Julia';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    
    // Pick up where you left off shelf items
    const vibes = [
        { title: 'Chill', subtitle: 'Study Beats', query: 'chill study beats lofi', bg: 'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=300&q=80' },
        { title: 'Jazzy', subtitle: 'Rainy Morning', query: 'jazz coffee shop acoustic', bg: 'https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=300&q=80' },
        { title: 'Weekend', subtitle: 'Skate Punk', query: 'grunge rock skate punk hits', bg: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=300&q=80' },
    ];

    // For you cards
    const forYou = [
        { title: 'Your Top', subtitle: 'Artists', query: 'popular pop billboard hits', bg: 'https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=300&q=80', isPurple: true },
        { title: 'Best of', subtitle: 'Office Music', query: 'office background workspace chill mix', bg: 'https://images.unsplash.com/photo-1489533119213-66a5cd877091?w=300&q=80', isPurple: false }
    ];

    let html = `
    <div class="fade-in">
      <!-- Dynamic header greeting -->
      <h2 style="font-family:var(--font-head); font-size:26px; font-weight:800; margin-bottom:24px; color:#ffffff;">${greeting}, ${name}!</h2>
      
      <!-- Pick up where you left off shelf -->
      <div class="shelf" style="margin-bottom: 28px;">
        <div class="section-header">
          <h3>Pick up where you left off</h3>
          <button class="see-all" onclick="renderTrending('pop')">View all</button>
        </div>
        <div class="shelf-container-horizontal">
          ${vibes.map((v, i) => `
            <div class="vibe-card" onclick="playVibe(${i}, 'vibe')">
              <div class="vibe-card-bg" style="background-image: url('${v.bg}')"></div>
              <div class="vibe-card-overlay">
                <div class="vibe-card-title">${v.title}</div>
                <div class="vibe-card-subtitle">${v.subtitle}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- For you section -->
      <div class="shelf" style="margin-bottom: 28px;">
        <div class="section-header">
          <h3>For you</h3>
          <button class="see-all" onclick="renderTrending('bollywood')">View all</button>
        </div>
        <div class="for-you-grid">
          ${forYou.map((f, i) => `
            <div class="foryou-card" onclick="playVibe(${i}, 'foryou')">
              <div class="foryou-card-bg" style="background-image: url('${f.bg}')"></div>
              <div class="${f.isPurple ? 'foryou-card-overlay-purple' : 'foryou-card-overlay-blue'}">
                <div class="foryou-card-title">${f.title}</div>
                <div class="foryou-card-subtitle">${f.subtitle}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Popular songs shelf -->
      <div class="shelf" style="margin-bottom: 36px;">
        <div class="section-header">
          <h3>Popular songs</h3>
        </div>
        <div class="song-list" id="homePopularList">
          ${skeletonList(3)}
        </div>
      </div>
    </div>
    `;
    content.innerHTML = html;

    // Load vibes into memory
    window._vibeList = vibes;
    window._forYouList = forYou;

    // Fetch trending pop tracks for Popular songs list
    try {
        const data = await apiFetch('/api/trending?genre=pop');
        const items = data.items.slice(0, 5);
        window._homePopularList = items;
        const listEl = document.getElementById('homePopularList');
        if (listEl) {
            listEl.innerHTML = items.map((song, idx) => {
                const isPlayingSong = queue[queueIdx]?.id === song.id;
                return `
                <div class="popular-song-row${isPlayingSong ? ' playing' : ''}" onclick="playSongFromHomePopular(${idx})">
                  <img class="popular-song-thumb" src="${song.thumbnail}" onerror="this.src='${FALLBACK_IMG}'" />
                  <div class="popular-song-info">
                    <div class="popular-song-title">${song.title}</div>
                    <div class="popular-song-artist">${song.artist}</div>
                  </div>
                  <button class="popular-song-play-btn">
                    <i class="fa-solid ${isPlayingSong && isPlaying ? 'fa-pause' : 'fa-play'}"></i>
                  </button>
                </div>
                `;
            }).join('');
        }
    } catch(e) {
        const listEl = document.getElementById('homePopularList');
        if (listEl) listEl.innerHTML = '<div style="color:var(--muted);font-size:12px">Could not load popular songs.</div>';
    }
}

async function playVibe(idx, type) {
    const item = type === 'vibe' ? window._vibeList[idx] : window._forYouList[idx];
    if (!item) return;
    toast(`Playing: ${item.title} vibe 🎧`);
    try {
        const data = await apiFetch(`/api/search?q=${encodeURIComponent(item.query)}`);
        if (data.items?.length) {
            browseList = data.items;
            playSongFromBrowse(0);
        }
    } catch(e) {
        toast('Error playing vibe mix');
    }
}

function playSongFromHomePopular(idx) {
    const list = window._homePopularList || [];
    if (!list.length) return;
    browseList = list;
    playSongFromBrowse(idx);
}

function handleMoodChip(btn, query) {
    document.querySelectorAll('.mood-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderSearch(query);
}

function playQuick(idx) {
    const list = window._quickList || [];
    if (!list.length) return;
    browseList = list;
    playSongFromBrowse(idx);
}

function playAllRecent() {
    if (!recentlyPlayed.length) return;
    browseList = recentlyPlayed.slice(0, 10);
    playAllBrowse(0);
}

async function renderTrending(genre) {
    currentGenre = genre;
    document.getElementById('pageTitle').textContent = `${genre.charAt(0).toUpperCase() + genre.slice(1)} 🎵`;
    const content = document.getElementById('content');
    content.innerHTML = `
    <div class="section fade-in">
      <div class="section-header">
        <h3>Trending – ${genre.charAt(0).toUpperCase() + genre.slice(1)}</h3>
        <button class="btn-play-all" onclick="playAllBrowse()"><i class="fa-solid fa-play"></i> Play All</button>
      </div>
      <div class="song-list" id="trendList">${skeletonList()}</div>
    </div>`;
    try {
        const data = await apiFetch(`/api/trending?genre=${genre}`);
        browseList = data.items;
        document.getElementById('trendList').innerHTML = data.items.map((s, i) => rowHTML(s, i)).join('');
    } catch (e) {
        document.getElementById('trendList').innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Error loading</h3><p>Make sure backend is running</p></div>`;
    }
}

async function renderSearch(q) {
    const query = q || document.getElementById('searchInput').value.trim();
    const content = document.getElementById('content');
    
    if (!query) {
        document.getElementById('pageTitle').textContent = 'Search';
        
        // Based on what you like grid items
        const mixes = [
            { title: 'Indie Mix', query: 'indie pop alternative rock mix', bg: 'https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=300&q=80' },
            { title: 'House Mix', query: 'house techno dance edm mix', bg: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&q=80' },
            { title: 'Pop Mix', query: 'retro 80s 90s pop hits', bg: 'https://images.unsplash.com/photo-1484755560693-a4074577af3a?w=300&q=80' },
            { title: 'Chill Mix', query: 'chillout acoustic lounge mix', bg: 'https://images.unsplash.com/photo-1515002246390-7bf7e8f87b54?w=300&q=80' }
        ];

        // Get recent searches from localStorage or default mocks
        const recentSearches = JSON.parse(localStorage.getItem('mestify_recent_searches') || '[]');
        const displayRecent = recentSearches.length ? recentSearches.slice(0, 4) : [
            { title: 'John', type: 'Artist', image: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&q=80', isCircle: true, query: 'John singer music' },
            { title: 'Marie', type: 'Artist', image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&q=80', isCircle: true, query: 'Marie female vocals' },
            { title: '3000 Days', type: 'Album', image: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=100&q=80', isCircle: false, query: '3000 Days album tracks' },
            { title: 'Together', type: 'Song', image: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=100&q=80', isCircle: false, query: 'Together song hits' }
        ];
        
        window._searchMixes = mixes;
        window._searchRecent = displayRecent;

        content.innerHTML = `
        <div class="fade-in">
          <!-- Rounded Search bar (mockup 4 style) -->
          <div class="search-bar-rounded">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input id="searchInnerInput" type="text" placeholder="Artists, songs, or podcasts" autocomplete="off" />
          </div>

          <!-- Recent searches section -->
          <div class="shelf" style="margin-bottom: 28px;">
            <div class="recent-searches-header">
              <h3>Recent searches</h3>
              <button class="recent-clear-btn" onclick="clearRecentSearches()">Clear</button>
            </div>
            <div class="recent-list">
              ${displayRecent.map((r, i) => `
                <div class="recent-search-row" onclick="playRecentSearch(${i})">
                  <img class="recent-search-thumb ${r.isCircle ? 'circle' : 'rounded'}" src="${r.image}" />
                  <div class="recent-search-info">
                    <div class="recent-search-title">${r.title}</div>
                    <div class="recent-search-type">${r.type}</div>
                  </div>
                  <div class="recent-search-arrow"><i class="fa-solid fa-chevron-right"></i></div>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Based on what you like grid -->
          <div class="shelf" style="margin-bottom: 36px;">
            <div class="section-header">
              <h3>Based on what you like</h3>
            </div>
            <div class="library-grid">
              ${mixes.map((m, i) => `
                <div class="library-grid-card" onclick="playSearchMix(${i})">
                  <div class="library-grid-card-bg" style="background-image: url('${m.bg}')"></div>
                  <div class="library-grid-card-overlay">
                    <div class="library-grid-card-title">${m.title}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        `;

        // Wire up search bar enter
        const innerInput = document.getElementById('searchInnerInput');
        if (innerInput) {
            innerInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    const val = innerInput.value.trim();
                    if (val) {
                        addSearchToRecents(val);
                        renderSearch(val);
                    }
                }
            });
        }
        return;
    }

    // Otherwise render original search results
    document.getElementById('searchInput').value = query;
    document.getElementById('pageTitle').textContent = `"${query}" 🔍`;
    content.innerHTML = `
    <div class="section fade-in">
      <div class="section-header">
        <h3>Results for "${query}"</h3>
        <button class="btn-play-all" onclick="playAllBrowse()"><i class="fa-solid fa-play"></i> Play All</button>
      </div>
      <div class="song-list" id="searchList">${skeletonList()}</div>
    </div>`;
    try {
        const data = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
        browseList = data.items;
        const list = document.getElementById('searchList');
        if (!list) return;
        if (!data.items.length) {
            list.innerHTML = `<div class="empty-state"><i class="fa-regular fa-face-sad-tear"></i><h3>No results</h3></div>`;
            return;
        }
        list.innerHTML = data.items.map((s, i) => rowHTML(s, i)).join('');
    } catch (e) {
        document.getElementById('searchList').innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Backend offline</h3><p>${e.message}</p></div>`;
    }
}

async function playRecentSearch(idx) {
    const item = window._searchRecent?.[idx];
    if (!item) return;
    renderSearch(item.query || item.title);
}

async function playSearchMix(idx) {
    const mix = window._searchMixes?.[idx];
    if (!mix) return;
    renderSearch(mix.query);
}

function clearRecentSearches() {
    localStorage.removeItem('mestify_recent_searches');
    renderSearch();
}

function addSearchToRecents(q) {
    let searches = JSON.parse(localStorage.getItem('mestify_recent_searches') || '[]');
    searches = searches.filter(s => s.title.toLowerCase() !== q.toLowerCase());
    searches.unshift({
        title: q,
        type: 'Search',
        image: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect width="40" height="40" fill="%23222"/%3E%3Ctext x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-size="16" fill="%23888"%3E🔍%3C/text%3E%3C/svg%3E',
        isCircle: false,
        query: q
    });
    if (searches.length > 5) searches = searches.slice(0, 5);
    localStorage.setItem('mestify_recent_searches', JSON.stringify(searches));
}

function renderLibrary() {
    setView('library');
    document.getElementById('pageTitle').textContent = 'Your Library';
    const content = document.getElementById('content');

    const playlists = [
        { title: 'Gym Time', query: 'workout energetic motivation gym music', bg: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=300&q=80' },
        { title: '90s Techno', query: '90s techno electronic rave dance classics', bg: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&q=80' },
        { title: 'Deep Focus', query: 'deep focus concentration studying instrumentals', bg: 'https://images.unsplash.com/photo-1489533119213-66a5cd877091?w=300&q=80' },
        { title: 'Beach Vibes', query: 'summer beach vibes tropical house mix', bg: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=300&q=80' },
        { title: 'Kids Party', query: 'fun kids party happy children songs', bg: 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=300&q=80' },
        { title: 'Folk Music', query: 'indie folk acoustic cozy guitar songs', bg: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=300&q=80' }
    ];
    
    window._libraryPlaylists = playlists;

    content.innerHTML = `
    <div class="fade-in">
      <!-- Featured card at top -->
      <div class="library-featured-card" onclick="playOnRepeat()">
        <div class="library-featured-title">Your Music<br>On Repeat</div>
        <div class="library-featured-subtitle">Based on your recent listening habits</div>
        <button class="library-featured-play">
          <i class="fa-solid fa-play"></i>
        </button>
      </div>

      <!-- Grid section -->
      <div class="shelf" style="margin-bottom: 36px;">
        <div class="library-grid">
          ${playlists.map((p, i) => `
            <div class="library-grid-card" onclick="playLibraryPlaylist(${i})">
              <div class="library-grid-card-bg" style="background-image: url('${p.bg}')"></div>
              <div class="library-grid-card-overlay">
                <div class="library-grid-card-title">${p.title}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
    `;
}

async function playLibraryPlaylist(idx) {
    const pl = window._libraryPlaylists?.[idx];
    if (!pl) return;
    toast(`Loading ${pl.title} playlist 🎵`);
    try {
        const data = await apiFetch(`/api/search?q=${encodeURIComponent(pl.query)}`);
        if (data.items?.length) {
            browseList = data.items;
            playSongFromBrowse(0);
        } else {
            toast('No songs found in playlist');
        }
    } catch(e) {
        toast('Failed to load playlist');
    }
}

function playOnRepeat() {
    const items = Object.values(liked);
    if (items.length) {
        browseList = items;
        playSongFromBrowse(0);
        toast('Playing your liked songs 💜');
    } else if (recentlyPlayed.length) {
        browseList = recentlyPlayed.slice(0, 10);
        playSongFromBrowse(0);
        toast('Playing your recently played 🎧');
    } else {
        // Fallback to Pop hits
        playLibraryPlaylist(3); // Beach Vibes or Pop mix
        toast('No liked songs yet. Playing featured mixes!');
    }
}

function renderLiked() {
    document.getElementById('pageTitle').textContent = 'Liked Songs ❤️';
    const items = Object.values(liked);
    const content = document.getElementById('content');
    if (!items.length) {
        content.innerHTML = `<div class="empty-state fade-in"><i class="fa-regular fa-heart"></i><h3>No liked songs yet</h3><p>Hit the heart on any song.</p></div>`;
        return;
    }
    browseList = items;
    content.innerHTML = `
    <div class="section fade-in">
      <div class="section-header">
        <h3>❤️ Liked Songs (${items.length})</h3>
        <button class="btn-play-all" onclick="playAllBrowse()"><i class="fa-solid fa-play"></i> Play All</button>
      </div>
      <div class="song-list">${items.map((s, i) => rowHTML(s, i)).join('')}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  PLAYBACK
// ═══════════════════════════════════════════════════════════════
function playFromQueue(idx) {
    if (!ytReady) { toast('Player loading…'); return; }
    queueIdx = idx;
    const song = queue[idx];
    if (!song) return;
    ytPlayer.loadVideoById(song.id);
    isPlaying = true;
    addToRecentlyPlayed(song);
    updateNowPlaying(song);
    updatePlayBtn();
    updateQueuePanel();
    refreshCards();
    // ── History + Up Next hooks ──
    if (typeof onSongStart === 'function') onSongStart(song);
}

// Alias used by Up Next panel & History page
function playSong(song) {
    queue = [song, ...queue.slice(queueIdx + 1)];
    playFromQueue(0);
}

function updateNowPlaying(song) {
    // Desktop player
    document.getElementById('npThumb').src = song.thumbnail || '';
    document.getElementById('npThumb').classList.add('pulse');
    document.getElementById('npTitle').textContent = song.title;
    document.getElementById('npArtist').textContent = song.artist;
    const isLiked = !!liked[song.id];
    document.getElementById('npLike').innerHTML = isLiked ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
    document.getElementById('npLike').classList.toggle('liked', isLiked);

    // Mobile player elements
    document.getElementById('mobThumb').src = song.thumbnail || '';
    document.getElementById('mobTitle').textContent = song.title;
    document.getElementById('mobArtist').textContent = song.artist;
    document.getElementById('mobLikeBtn').innerHTML = isLiked ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
    document.getElementById('mobLikeBtn').classList.toggle('liked', isLiked);

    // Expanded player — blur backdrop
    const thumb = song.thumbnail || '';
    document.getElementById('expThumb').src = thumb;
    document.getElementById('expTitle').textContent = song.title;
    document.getElementById('expArtist').textContent = song.artist;
    document.getElementById('expBgBlur').style.setProperty('--exp-bg-url', `url('${thumb}')`);
    document.getElementById('expBgBlur').style.backgroundImage = `url('${thumb}')`;
    document.getElementById('expLike').innerHTML = isLiked ? '<i class="fa-solid fa-heart" style="font-size:22px"></i>' : '<i class="fa-regular fa-heart" style="font-size:22px"></i>';
    document.getElementById('expLike').classList.toggle('active', isLiked);

    document.title = `${song.title} – Mestify`;

    // Media Session API — enables lock screen controls
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: 'Mestify',
            artwork: [
                { src: song.thumbnail || '', sizes: '512x512', type: 'image/jpeg' },
                { src: song.thumbnail || '', sizes: '256x256', type: 'image/jpeg' },
            ],
        });
        navigator.mediaSession.setActionHandler('play', () => { ytPlayer?.playVideo(); });
        navigator.mediaSession.setActionHandler('pause', () => { ytPlayer?.pauseVideo(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
        navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
        navigator.mediaSession.setActionHandler('seekto', (d) => {
            if (d.seekTime !== undefined) ytPlayer?.seekTo(d.seekTime);
        });
    }
}

function updatePlayBtn() {
    const icon = isPlaying ? 'fa-pause' : 'fa-play';
    document.getElementById('playIcon').className = `fa-solid ${icon}`;
    document.getElementById('mobPlayIcon').className = `fa-solid ${icon}`;
    document.getElementById('expPlayIcon').className = `fa-solid ${icon}`;
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
}

function refreshCards() {
    const activeId = queue[queueIdx]?.id;
    document.querySelectorAll('.song-card').forEach(el => el.classList.toggle('playing', el.dataset.songid === activeId));
    document.querySelectorAll('.song-row').forEach(el => el.classList.toggle('playing', el.dataset.songid === activeId));
}

function playNext() {
    if (!queue.length) return;
    if (isShuffle) {
        let idx;
        do { idx = Math.floor(Math.random() * queue.length); } while (idx === queueIdx && queue.length > 1);
        playFromQueue(idx);
    } else if (queueIdx < queue.length - 1) {
        playFromQueue(queueIdx + 1);
    } else if (isAutoplay && queue[queueIdx]) {
        loadAutoplay(queue[queueIdx].id);
    }
}

async function loadAutoplay(videoId) {
    toast('Fetching autoplay… 🎵');
    try {
        const song = queue[queueIdx];
        const params = song
            ? `?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`
            : '';
        const data = await apiFetch(`/api/related/${videoId}${params}`);
        if (data.items && data.items.length) {
            const startIdx = queue.length;
            queue = [...queue, ...data.items];
            playFromQueue(startIdx);
            updateQueuePanel();
            toast('Autoplay: similar songs added ∞');
        } else toast('Nothing more to autoplay');
    } catch (e) { console.error('[autoplay]', e); toast('Autoplay failed'); }
}

function playSongFromBrowse(idx) {
    const song = browseList[idx];
    if (!song) return;
    if (!ytReady) { toast('Player loading…'); return; }
    
    // Check if we are in Search view
    const pageTitle = document.getElementById('pageTitle')?.textContent || '';
    const isSearchView = pageTitle.includes('🔍') || pageTitle.includes('Search') || 
                         document.querySelector('.nav-item[data-view="search"]')?.classList.contains('active') ||
                         document.querySelector('#mobileNav .mob-nav-btn[data-view="search"]')?.classList.contains('active');
    
    if (isSearchView) {
        // YT Music style: play ONLY the selected song and let autoplay/up-next populate recommendations below it
        queue = [song];
        playFromQueue(0);
    } else {
        // Standard style: load the full list (e.g. liked songs, trending shelf) so navigation works within it
        queue = [...browseList];
        playFromQueue(idx);
    }
}

function playAllBrowse(startIdx = 0) {
    if (!browseList.length) { toast('Nothing to play'); return; }
    queue = [...browseList]; queueIdx = -1;
    playFromQueue(startIdx);
    toast(`Playing all ${queue.length} songs 🎶`);
}

function addBrowseToQueue(idx) {
    const song = browseList[idx];
    if (!song) return;
    const alreadyAhead = queue.findIndex((s, i) => s.id === song.id && i > queueIdx);
    if (alreadyAhead === -1) {
        const insertAt = queueIdx >= 0 ? queueIdx + 1 : queue.length;
        queue.splice(insertAt, 0, { ...song });
        updateQueuePanel();
        toast(`Added to queue: ${song.title.slice(0, 28)}… ✓`);
    } else toast('Already up next in queue');
}

function playPrev() {
    if (queueIdx > 0) playFromQueue(queueIdx - 1);
    else if (ytPlayer) ytPlayer.seekTo(0);
}

async function loadRadio(videoId) {
    try {
        toast('Loading radio…');
        const song = queue[queueIdx];
        const params = song
            ? `?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`
            : '';
        const data = await apiFetch(`/api/related/${videoId}${params}`);
        if (data.items && data.items.length) {
            queue = data.items; queueIdx = 0;
            playFromQueue(0); updateQueuePanel(); toast('Radio started 📻');
        } else toast('No radio stations found');
    } catch (e) { console.error('[radio]', e); toast('Radio failed'); }
}

// ─── Progress ───────────────────────────────────────────────────
function startProgress() {
    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
        const cur = audio.currentTime || 0;
        const dur = audio.duration || 0;
        if (!dur) return;
        const pct = (cur / dur) * 100;

        document.getElementById('progressFill').style.width = pct + '%';
        document.getElementById('progressThumb').style.left = pct + '%';
        document.getElementById('curTime').textContent = fmtTime(cur);
        document.getElementById('durTime').textContent = fmtTime(dur);

        document.getElementById('expFill').style.width = pct + '%';
        document.getElementById('expCur').textContent = fmtTime(cur);
        document.getElementById('expDur').textContent = fmtTime(dur);

        const mobProg = document.getElementById('mobProgressFill');
        if (mobProg) mobProg.style.width = pct + '%';

        if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
            try {
                navigator.mediaSession.setPositionState({
                    duration: dur, playbackRate: 1, position: cur,
                });
            } catch (_) { }
        }
    }, 500);
}
function stopProgress() { clearInterval(progressInterval); }
function fmtTime(s) { const m = Math.floor(s / 60); return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`; }

// ─── Queue Panel ────────────────────────────────────────────────
function updateQueuePanel() {
    const items = document.getElementById('queueItems');
    if (items) {
        if (!queue.length) { items.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px">Queue is empty</p>'; }
        else {
            items.innerHTML = queue.map((s, i) => `
        <div class="queue-item${i === queueIdx ? ' active' : ''}" onclick="playFromQueue(${i})">
          <img src="${s.thumbnail}" alt="" onerror="this.style.background='var(--border)'" />
          <div class="queue-item-info"><h5>${s.title}</h5><p>${s.artist}</p></div>
        </div>`).join('');
        }
    }
    if (document.getElementById('upNextPanel').classList.contains('open')) {
        renderUpNextPanel();
    }
}

// ─── Like ────────────────────────────────────────────────────────
function toggleLike(id, btn) {
    const song = queue.find(s => s.id === id) || browseList.find(s => s.id === id);
    if (!song) return;
    if (liked[id]) {
        delete liked[id];
        if (btn) { btn.innerHTML = '<i class="fa-regular fa-heart"></i>'; btn.classList.remove('liked'); }
        toast('Removed from liked');
    } else {
        liked[id] = song;
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-heart"></i>'; btn.classList.add('liked'); }
        toast('Added to liked ❤️');
    }
    localStorage.setItem('mestify_liked', JSON.stringify(liked));
    // Sync all heart buttons for this song
    const isLikedNow = !!liked[id];
    if (queue[queueIdx]?.id === id) {
        ['npLike', 'mobLikeBtn'].forEach(eid => {
            const el = document.getElementById(eid);
            if (el) {
                el.innerHTML = isLikedNow ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';
                el.classList.toggle('liked', isLikedNow);
            }
        });
        const expL = document.getElementById('expLike');
        if (expL) {
            expL.innerHTML = isLikedNow ? '<i class="fa-solid fa-heart"></i><span>Liked</span>' : '<i class="fa-regular fa-heart"></i><span>Like</span>';
            expL.classList.toggle('active', isLikedNow);
        }
    }
}

// ─── Sleep Timer ─────────────────────────────────────────────────
function setSleepTimer(minutes) {
    clearSleepTimer();
    sleepEndsAt = Date.now() + minutes * 60000;
    sleepTimer = setTimeout(() => {
        if (ytPlayer && isPlaying) ytPlayer.pauseVideo();
        clearSleepTimer();
        toast('😴 Sleep timer: music paused');
    }, minutes * 60000);
    document.getElementById('sleepBadge').classList.add('active');
    startSleepCountdown();
    document.getElementById('sleepModal').classList.remove('open');
    toast(`Sleep timer set for ${minutes} min 🌙`);
}

function clearSleepTimer() {
    clearTimeout(sleepTimer);
    clearInterval(window._sleepCountInterval);
    sleepTimer = null; sleepEndsAt = null;
    document.getElementById('sleepBadge').classList.remove('active');
}

function startSleepCountdown() {
    clearInterval(window._sleepCountInterval);
    window._sleepCountInterval = setInterval(() => {
        if (!sleepEndsAt) return;
        const rem = Math.max(0, sleepEndsAt - Date.now());
        const m = Math.floor(rem / 60000);
        const s = Math.floor((rem % 60000) / 1000).toString().padStart(2, '0');
        document.getElementById('sleepCountdown').textContent = `${m}:${s}`;
        if (rem <= 0) clearInterval(window._sleepCountInterval);
    }, 1000);
}

// ─── Autoplay btn ───────────────────────────────────────────────
function updateAutoplayBtn() {
    document.getElementById('autoplayBtn').classList.toggle('active', isAutoplay);
    document.getElementById('autoplayDot').style.display = isAutoplay ? 'block' : 'none';
    const expAP = document.getElementById('expAutoplay');
    if (expAP) expAP.classList.toggle('active', isAutoplay);
}

// ─── Mobile responsive setup ─────────────────────────────────────
function applyMobileLayout() {
    const mob = isMobile();
    document.getElementById('nowPlayingSection').style.display = mob ? 'none' : '';
    ['mobThumb', 'mobInfo', 'mobPrevBtn', 'mobPlayBtn', 'mobNextBtn', 'mobLikeBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = mob ? (id === 'mobInfo' ? 'block' : 'flex') : 'none';
    });
}
window.addEventListener('resize', applyMobileLayout);
applyMobileLayout();

// ─── Expanded player ─────────────────────────────────────────────
function openExpanded() {
    document.getElementById('npExpanded').classList.add('open');
}
function closeExpanded() {
    document.getElementById('npExpanded').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════
//  SEARCH SUGGESTIONS
// ═══════════════════════════════════════════════════════════════
const suggestEl = document.getElementById('suggestions');
let suggestTimer = null, activeSugIdx = -1, currentSuggestions = [];

function renderSuggestions(items) {
    currentSuggestions = items; activeSugIdx = -1;
    if (!items.length) { suggestEl.classList.remove('open'); return; }
    suggestEl.innerHTML = items.map((s, i) => `
    <div class="suggest-item" data-idx="${i}" onclick="pickSuggestion(${i})">
      <i class="fa-solid fa-magnifying-glass"></i>
      <span class="suggest-text">${s}</span>
    </div>`).join('');
    suggestEl.classList.add('open');
}

function hideSuggestions() { suggestEl.classList.remove('open'); activeSugIdx = -1; }
function pickSuggestion(idx) {
    const s = currentSuggestions[idx];
    if (!s) return;
    document.getElementById('searchInput').value = s;
    hideSuggestions(); renderSearch(s);
}
function setActiveSuggestion(idx) {
    const items = suggestEl.querySelectorAll('.suggest-item');
    items.forEach(el => el.classList.remove('active'));
    activeSugIdx = idx;
    if (idx >= 0 && idx < items.length) {
        items[idx].classList.add('active');
        document.getElementById('searchInput').value = currentSuggestions[idx];
    }
}

document.getElementById('searchInput').addEventListener('input', e => {
    const q = e.target.value.trim();
    clearTimeout(suggestTimer);
    if (!q) { hideSuggestions(); return; }
    suggestTimer = setTimeout(async () => {
        try {
            const data = await apiFetch(`/api/suggest?q=${encodeURIComponent(q)}`);
            renderSuggestions(data.suggestions || []);
        } catch (_) { hideSuggestions(); }
    }, 700);
});

document.getElementById('searchInput').addEventListener('keydown', e => {
    const open = suggestEl.classList.contains('open');
    if (e.key === 'ArrowDown') { e.preventDefault(); if (open) setActiveSuggestion(Math.min(activeSugIdx + 1, currentSuggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) setActiveSuggestion(Math.max(activeSugIdx - 1, -1)); }
    else if (e.key === 'Enter') { if (open && activeSugIdx >= 0) pickSuggestion(activeSugIdx); else { hideSuggestions(); renderSearch(); } }
    else if (e.key === 'Escape') hideSuggestions();
});
document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) hideSuggestions(); });

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

// Desktop nav
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        setView(view);
        if (view === 'home') renderHome();
        else if (view === 'search') renderSearch();
        else if (view === 'library') renderLibrary();
        else if (view === 'queue') { openUpNext(); }
        else if (view === 'history') renderHistoryPage();
    });
});

// Mobile nav
document.querySelectorAll('#mobileNav .mob-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        setView(view);
        if (view === 'home') renderHome();
        else if (view === 'search') renderSearch();
        else if (view === 'library') renderLibrary();
        else if (view === 'queue') { openUpNext(); }
        else if (view === 'history') renderHistoryPage();
    });
});

// Genre pills
document.querySelectorAll('.genre-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.genre-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentGenre = btn.dataset.genre;
        renderTrending(currentGenre);
    });
});

// Search
document.getElementById('searchBtn').addEventListener('click', () => { hideSuggestions(); renderSearch(); });

// Desktop play/pause
document.getElementById('playBtn').addEventListener('click', () => {
    if (!ytPlayer || !ytReady) return;
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
});

// Mobile player controls
document.getElementById('mobPlayBtn').addEventListener('click', () => {
    if (!ytPlayer || !ytReady) return;
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
});
document.getElementById('mobPrevBtn').addEventListener('click', playPrev);
document.getElementById('mobNextBtn').addEventListener('click', playNext);
document.getElementById('mobLikeBtn').addEventListener('click', () => {
    const song = queue[queueIdx];
    if (!song) return;
    toggleLike(song.id, null);
});

// Open expanded player on album art/title tap (mobile)
document.getElementById('mobThumb').addEventListener('click', openExpanded);
document.getElementById('mobInfo').addEventListener('click', openExpanded);
document.getElementById('closeExpanded').addEventListener('click', closeExpanded);

// Swipe down to close expanded player (mobile gesture)
let npTouchStart = 0;
document.getElementById('npExpanded').addEventListener('touchstart', e => {
    npTouchStart = e.touches[0].clientY;
}, { passive: true });
document.getElementById('npExpanded').addEventListener('touchend', e => {
    const diff = e.changedTouches[0].clientY - npTouchStart;
    if (diff > 80) closeExpanded();
}, { passive: true });

// Expanded player controls
document.getElementById('expPlay').addEventListener('click', () => {
    if (!ytPlayer || !ytReady) return;
    if (isPlaying) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
});
document.getElementById('expPrev').addEventListener('click', playPrev);
document.getElementById('expNext').addEventListener('click', playNext);
document.getElementById('expShuffle').addEventListener('click', () => {
    isShuffle = !isShuffle;
    document.getElementById('expShuffle').classList.toggle('active', isShuffle);
    document.getElementById('shuffleBtn').classList.toggle('active', isShuffle);
    toast(isShuffle ? 'Shuffle on 🔀' : 'Shuffle off');
});
document.getElementById('expRepeat').addEventListener('click', () => {
    isRepeat = !isRepeat;
    document.getElementById('expRepeat').classList.toggle('active', isRepeat);
    document.getElementById('repeatBtn').classList.toggle('active', isRepeat);
    toast(isRepeat ? 'Repeat on 🔁' : 'Repeat off');
});
document.getElementById('expLike').addEventListener('click', () => {
    const song = queue[queueIdx]; if (!song) return;
    toggleLike(song.id, null);
});
document.getElementById('expAutoplay').addEventListener('click', () => {
    isAutoplay = !isAutoplay; updateAutoplayBtn();
    toast(isAutoplay ? 'Autoplay on ∞' : 'Autoplay off');
});
document.getElementById('expSleepBtn').addEventListener('click', () => {
    closeExpanded();
    document.getElementById('sleepModal').classList.add('open');
});
document.getElementById('expQueue').addEventListener('click', () => {
    closeExpanded();
    openUpNext();
});
document.getElementById('expQueueTop').addEventListener('click', () => {
    closeExpanded();
    openUpNext();
});
document.getElementById('expRadio').addEventListener('click', () => {
    const song = queue[queueIdx];
    if (!song) { toast('Play a song first'); return; }
    closeExpanded();
    isRadio = !isRadio;
    document.getElementById('radioBtn').classList.toggle('active', isRadio);
    document.getElementById('expRadio').classList.toggle('active', isRadio);
    toast(isRadio ? 'Radio mode on 📻' : 'Radio off');
    if (isRadio) loadRadio(song.id);
});

// Expanded progress bar click
document.getElementById('expBar').addEventListener('click', e => {
    if (!ytPlayer || !ytReady) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    ytPlayer.seekTo(pct * (ytPlayer.getDuration?.() || 0));
});

// Desktop prev/next/shuffle/repeat
document.getElementById('prevBtn').addEventListener('click', playPrev);
document.getElementById('nextBtn').addEventListener('click', playNext);
document.getElementById('shuffleBtn').addEventListener('click', () => {
    isShuffle = !isShuffle;
    document.getElementById('shuffleBtn').classList.toggle('active', isShuffle);
    document.getElementById('expShuffle').classList.toggle('active', isShuffle);
    toast(isShuffle ? 'Shuffle on 🔀' : 'Shuffle off');
});
document.getElementById('repeatBtn').addEventListener('click', () => {
    isRepeat = !isRepeat;
    document.getElementById('repeatBtn').classList.toggle('active', isRepeat);
    document.getElementById('expRepeat').classList.toggle('active', isRepeat);
    toast(isRepeat ? 'Repeat on 🔁' : 'Repeat off');
});

// Radio
document.getElementById('radioBtn').addEventListener('click', () => {
    const song = queue[queueIdx];
    if (!song) { toast('Play a song first'); return; }
    isRadio = !isRadio;
    document.getElementById('radioBtn').classList.toggle('active', isRadio);
    toast(isRadio ? 'Radio mode on 📻' : 'Radio off');
    if (isRadio) loadRadio(song.id);
});

// Autoplay (desktop)
document.getElementById('autoplayBtn').addEventListener('click', () => {
    isAutoplay = !isAutoplay; updateAutoplayBtn();
    toast(isAutoplay ? 'Autoplay on ∞' : 'Autoplay off');
});
updateAutoplayBtn();

// Progress bar (desktop)
document.getElementById('progressBar').addEventListener('click', e => {
    if (!ytPlayer || !ytReady) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    ytPlayer.seekTo(pct * (ytPlayer.getDuration?.() || 0));
});

// Volume
document.getElementById('volBar').addEventListener('click', e => {
    if (!ytPlayer || !ytReady) return;
    const rect = e.currentTarget.getBoundingClientRect();
    volume = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    document.getElementById('volFill').style.width = volume + '%';
    ytPlayer.setVolume(volume); isMuted = false;
    document.getElementById('volIcon').className = 'fa-solid fa-volume-high';
});
document.getElementById('muteBtn').addEventListener('click', () => {
    if (!ytPlayer || !ytReady) return;
    isMuted = !isMuted;
    if (isMuted) { ytPlayer.mute(); document.getElementById('volIcon').className = 'fa-solid fa-volume-xmark'; }
    else { ytPlayer.unMute(); document.getElementById('volIcon').className = 'fa-solid fa-volume-high'; }
});

// Like (desktop player heart)
document.getElementById('npLike').addEventListener('click', () => {
    const song = queue[queueIdx]; if (!song) return;
    toggleLike(song.id, document.getElementById('npLike'));
});

// Queue panel (now redirected to Up Next panel)
const qToggle = document.getElementById('queueToggle');
if (qToggle) {
    qToggle.addEventListener('click', () => {
        const panel = document.getElementById('upNextPanel');
        if (panel.classList.contains('open')) {
            closeUpNext();
        } else {
            openUpNext();
        }
    });
}
document.getElementById('closeQueue').addEventListener('click', () => {
    closeUpNext();
});

// Sleep timer
document.getElementById('sleepBtn').addEventListener('click', () => {
    document.getElementById('sleepModal').classList.add('open');
});
document.querySelectorAll('.sleep-opt').forEach(btn => {
    btn.addEventListener('click', () => setSleepTimer(parseInt(btn.dataset.min)));
});
document.getElementById('sleepCancel').addEventListener('click', () => {
    clearSleepTimer();
    document.getElementById('sleepModal').classList.remove('open');
    toast('Sleep timer off');
});
document.getElementById('sleepModal').addEventListener('click', e => {
    if (e.target === document.getElementById('sleepModal')) {
        document.getElementById('sleepModal').classList.remove('open');
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); document.getElementById('playBtn').click(); }
    if (e.code === 'ArrowRight') playNext();
    if (e.code === 'ArrowLeft') playPrev();
    if (e.code === 'KeyM') document.getElementById('muteBtn').click();
});

// ─── Init ──────────────────────────────────────────
// ════════════════════════════════════════════════════════════════
//  AUTH + PERSONALIZATION SYSTEM
// ════════════════════════════════════════════════════════════════
// (currentUser and loginMode declared at top of script)

function initAuth() {
    const saved = localStorage.getItem('mestify_user');
    if (saved) {
        try { currentUser = JSON.parse(saved); applyUserBadge(); loadProfileData(); } catch { currentUser = null; }
    }
    
    if (!currentUser) {
        showAuthOverlay();
    } else {
        hideAuthOverlay();
    }

    // Wire auth form buttons
    document.getElementById('welcomeGetStarted').addEventListener('click', () => switchAuthMode('register'));
    document.getElementById('welcomeHasAccount').addEventListener('click', () => switchAuthMode('login'));
    document.getElementById('authToggleBtn').addEventListener('click', () => {
        switchAuthMode(loginMode === 'login' ? 'register' : 'login');
    });
    document.getElementById('authGuestBtn').addEventListener('click', () => {
        hideAuthOverlay();
        showToast('👋 Listening as guest');
    });
    document.getElementById('btnGoogle').addEventListener('click', () => mockSocialLogin('Google'));
    document.getElementById('btnFacebook').addEventListener('click', () => mockSocialLogin('Facebook'));
    document.getElementById('authSubmitBtn').addEventListener('click', submitAuthForm);

    // Enter keys
    ['authUsername', 'authEmail', 'authPassword', 'authConfirmPassword'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') submitAuthForm(); });
    });
}

function showAuthOverlay() {
    document.getElementById('authOverlay').classList.remove('hidden');
    document.getElementById('welcomeView').classList.remove('hidden');
    document.getElementById('authFormView').classList.add('hidden');
}

function showLogin() {
    showAuthOverlay();
}

function hideAuthOverlay() {
    document.getElementById('authOverlay').classList.add('hidden');
}

function switchAuthMode(mode) {
    loginMode = mode;
    document.getElementById('welcomeView').classList.add('hidden');
    document.getElementById('authFormView').classList.remove('hidden');

    const title = document.getElementById('authFormTitle');
    const subtitle = document.getElementById('authFormSubtitle');
    const submitBtn = document.getElementById('authSubmitBtn');
    const toggleBtn = document.getElementById('authToggleBtn');
    const emailField = document.getElementById('fieldEmail');
    const confirmField = document.getElementById('fieldConfirmPassword');

    if (mode === 'login') {
        title.textContent = 'Welcome Back!';
        subtitle.textContent = 'Sign in to continue listening to your favorites.';
        submitBtn.textContent = 'Sign In';
        toggleBtn.textContent = "Don't have an account? Sign Up";
        emailField.classList.add('hidden');
        confirmField.classList.add('hidden');
    } else {
        title.textContent = 'Hi!';
        subtitle.textContent = 'Sign up to start listening to all your favorite artists.';
        submitBtn.textContent = 'Register';
        toggleBtn.textContent = 'Already have an account? Sign In';
        emailField.classList.remove('hidden');
        confirmField.classList.remove('hidden');
    }
    document.getElementById('authError').textContent = '';
    document.getElementById('authUsername').value = '';
    document.getElementById('authEmail').value = '';
    document.getElementById('authPassword').value = '';
    document.getElementById('authConfirmPassword').value = '';
    document.getElementById('authUsername').focus();
}

async function submitAuthForm() {
    const name = document.getElementById('authUsername').value.trim();
    const pin = document.getElementById('authPassword').value.trim();
    const email = document.getElementById('authEmail').value.trim();
    const confirm = document.getElementById('authConfirmPassword').value.trim();
    const errEl = document.getElementById('authError');

    if (!name || !pin) { errEl.textContent = 'Username and Password required.'; return; }
    if (loginMode === 'register') {
        if (!email) { errEl.textContent = 'Email is required.'; return; }
        if (pin !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    }

    const btn = document.getElementById('authSubmitBtn');
    btn.disabled = true;
    btn.textContent = loginMode === 'login' ? 'Signing in...' : 'Creating account...';

    try {
        const body = loginMode === 'login' ? { name, pin } : { name, pin, email };
        const res = await fetch(loginMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Something went wrong.'; return; }

        currentUser = { userId: data.userId, name: data.name, token: data.token };
        localStorage.setItem('mestify_user', JSON.stringify(currentUser));
        applyUserBadge();
        hideAuthOverlay();
        showToast(`👋 Welcome${loginMode === 'register' ? '' : ' back'}, ${data.name}!`);
        loadProfileData();
        renderHome();
    } catch (err) {
        errEl.textContent = 'Network error. Is the server running?';
    } finally {
        btn.disabled = false;
        btn.textContent = loginMode === 'login' ? 'Sign In' : 'Register';
    }
}

function continueAsGuest() {
    hideAuthOverlay();
    showToast('👋 Listening as guest');
}

function mockSocialLogin(provider) {
    const errEl = document.getElementById('authError');
    if (errEl) {
        errEl.textContent = `${provider} sign-in is not connected yet. Use username and password for now.`;
    }
    showToast(`${provider} sign-in coming soon`);
}

function logoutUser(e) {
    if (e) e.stopPropagation();
    currentUser = null;
    localStorage.removeItem('mestify_user');
    document.getElementById('userBadge').classList.add('hidden');
    document.getElementById('guestBadge').classList.remove('hidden');
    showToast('Logged out. See you again!');
    showAuthOverlay();
}

function applyUserBadge() {
    if (!currentUser) return;
    document.getElementById('userBadge').classList.remove('hidden');
    document.getElementById('guestBadge').classList.add('hidden');
    const initial = currentUser.name[0].toUpperCase();
    document.getElementById('userAvatarBadge').textContent = initial;
    document.getElementById('userNameBadge').textContent = currentUser.name;
    document.getElementById('userAvatarSmall').textContent = initial;
}

async function loadProfileData() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/profile', { headers: { 'Authorization': 'Bearer ' + currentUser.token } });
        if (!res.ok) return;
        const data = await res.json();
        const label = data.topGenres?.[0] ? `🔥 ${data.topGenres[0]}` : data.topArtists?.[0] ? `❤️ ${data.topArtists[0]}` : 'Start listening';
        document.getElementById('userGenreBadge').textContent = label;
        currentUser._profile = data;
    } catch { }
}

// Enter submits login — wired inside initAuth() when DOM is ready

// ════════════════════════════════════════════════════════════════
//  HISTORY TRACKING — records plays, feeds the algorithm
// ════════════════════════════════════════════════════════════════
// (_playStart, _lastPlayedId declared at top of script)

function onSongStart(song) {
    _playStart = Date.now();
    _lastPlayedId = song?.id;
    if (document.getElementById('upNextPanel').classList.contains('open')) renderUpNextPanel();
}

function onSongEnd(song, durationSec) {
    if (!song || song.id !== _lastPlayedId) return;
    const elapsed = (Date.now() - _playStart) / 1000;
    const pct = durationSec > 0 ? Math.min(100, Math.round((elapsed / durationSec) * 100)) : 100;
    postHistory(song, pct);
}

function postHistory(song, completionPct = 100) {
    if (!currentUser) return;
    const genre = _guessGenre(`${song.title || ''} ${song.artist || ''}`);
    const mood = _guessMood(`${song.title || ''} ${song.artist || ''}`);
    fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + currentUser.token },
        body: JSON.stringify({ id: song.id, title: song.title, artist: song.artist, genre, mood, completionPct }),
    }).catch(() => { });
}

function _guessGenre(t) {
    t = t.toLowerCase();
    if (/marathi|lavani/.test(t)) return 'marathi';
    if (/punjabi|bhangra/.test(t)) return 'punjabi';
    if (/bollywood|hindi|filmi/.test(t)) return 'bollywood';
    if (/tamil|kollywood/.test(t)) return 'tamil';
    if (/telugu|tollywood/.test(t)) return 'telugu';
    if (/k.?pop|bts|blackpink/.test(t)) return 'kpop';
    if (/lofi|lo.fi/.test(t)) return 'lofi';
    if (/rap|hip.?hop/.test(t)) return 'hiphop';
    if (/rock|metal/.test(t)) return 'rock';
    if (/indie|alternative/.test(t)) return 'indie';
    return 'pop';
}
function _guessMood(t) {
    t = t.toLowerCase();
    if (/sad|heartbreak|dard/.test(t)) return 'sad emotional';
    if (/romantic|love|pyaar/.test(t)) return 'romantic love';
    if (/lofi|chill|study/.test(t)) return 'lofi chill';
    if (/party|dance|dj/.test(t)) return 'party dance';
    if (/workout|gym|energy/.test(t)) return 'energetic workout';
    if (/acoustic|soulful|soft/.test(t)) return 'slow acoustic';
    return '';
}

// ════════════════════════════════════════════════════════════════
//  UP NEXT PANEL
// ════════════════════════════════════════════════════════════════
let upNextFilter = 'all';
let upNextLoading = false;
let activeUpNextTab = 'upnext';
let upNextRecommendations = [];
let lastRecommendedSongId = null;
let upNextPersonalized = false;

function openUpNext() {
    document.getElementById('upNextPanel').classList.add('open');
    renderUpNextPanel();
}
function closeUpNext() { document.getElementById('upNextPanel').classList.remove('open'); }

function switchUpNextTab(tab, btn) {
    document.querySelectorAll('.upnext-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeUpNextTab = tab;
    renderUpNextPanel();
}
function applyUpNextFilter(filter, btn) {
    upNextFilter = filter;
    document.querySelectorAll('.upnext-chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    lastRecommendedSongId = null; // force refetch with new filter
    renderUpNextPanel();
}
function toggleAutoplay(on) {
    const vis = document.getElementById('autoplayToggleVis');
    if (vis) {
        vis.style.background = on ? 'var(--accent)' : '#444';
        vis.children[0].style.transform = on ? 'translateX(20px)' : 'translateX(0)';
    }
    isAutoplay = on;
    renderUpNextPanel(); // rerender to show/hide recommended section in "Up Next" tab
}
// showToast is an alias for toast()
function showToast(msg) { toast(msg); }

async function fetchRecommendations(song) {
    if (upNextLoading) return;
    upNextLoading = true;
    const list = document.getElementById('upnextList');
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px"><i class="fa-solid fa-circle-notch fa-spin"></i>&nbsp;Loading...</div>';
    try {
        const params = new URLSearchParams({
            title: song.title || '', artist: song.artist || '', filter: upNextFilter,
            ...(currentUser?.token ? { token: currentUser.token } : {}),
        });
        const res = await fetch(`/api/upnext/${song.id}?${params}`);
        const data = await res.json();
        upNextRecommendations = data.items || [];
        upNextPersonalized = !!data.personalized;
        lastRecommendedSongId = song.id;
        if (data.chips?.length) updateUpNextChips(data.chips);
    } catch (err) {
        console.error("Error fetching recommendations:", err);
    } finally {
        upNextLoading = false;
    }
}

async function renderUpNextPanel() {
    const song = queue[queueIdx];
    if (!song) {
        document.getElementById('upnextPlayingTitle').textContent = '—';
        document.getElementById('upnextList').innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Play a song to see Up Next</div>';
        return;
    }

    document.getElementById('upnextPlayingTitle').textContent = song.title || '—';

    if (lastRecommendedSongId !== song.id) {
        await fetchRecommendations(song);
    }

    const list = document.getElementById('upnextList');
    const badgeEl = document.getElementById('upnextPersonalizedBadge');
    badgeEl.style.display = upNextPersonalized ? 'flex' : 'none';

    if (activeUpNextTab === 'upnext') {
        let html = '';
        queue.forEach((s, idx) => {
            const isPast = idx < queueIdx;
            const isCurrent = idx === queueIdx;
            const opacityStyle = isPast ? 'opacity: 0.45;' : '';
            const activeClass = isCurrent ? ' playing' : '';
            const borderStyle = isCurrent ? 'border-left: 3px solid var(--accent); background: rgba(255, 0, 64, 0.04);' : '';

            html += `
        <div class="upnext-item${activeClass}" style="${opacityStyle} ${borderStyle}" onclick="playFromQueue(${idx})">
          <img class="upnext-thumb" src="${s.thumbnail}" loading="lazy" onerror="this.src='https://img.youtube.com/vi/${s.id}/hqdefault.jpg'">
          <div class="upnext-item-info">
            <div class="upnext-item-title" style="${isCurrent ? 'color: var(--accent); font-weight: 600;' : ''}">${s.title}</div>
            <div class="upnext-item-artist">${s.artist || ''}</div>
          </div>
          <div class="upnext-duration">${fmtTime(s.duration || 0)}</div>
        </div>
      `;
        });

        if (isAutoplay && upNextRecommendations.length > 0) {
            html += `
        <div class="upnext-divider" style="padding: 16px 20px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); letter-spacing: 1px;">
          Autoplay - Similar Songs
        </div>
      `;
            upNextRecommendations.forEach((s, idx) => {
                html += `
          <div class="upnext-item" onclick="playSongFromUpNextByIndex(${idx})">
            <img class="upnext-thumb" src="${s.thumbnail}" loading="lazy" onerror="this.src='https://img.youtube.com/vi/${s.id}/hqdefault.jpg'">
            <div class="upnext-item-info">
              <div class="upnext-item-title">${s.title}</div>
              <div class="upnext-item-artist">${s.artist || ''}</div>
            </div>
            <div class="upnext-duration">${fmtTime(s.duration || 0)}</div>
          </div>
        `;
            });
        }

        list.innerHTML = html || '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Queue is empty</div>';
    } else if (activeUpNextTab === 'related') {
        list.innerHTML = upNextRecommendations.length
            ? upNextRecommendations.map((s, idx) => `
          <div class="upnext-item" onclick="playSongFromUpNextByIndex(${idx})">
            <img class="upnext-thumb" src="${s.thumbnail}" loading="lazy" onerror="this.src='https://img.youtube.com/vi/${s.id}/hqdefault.jpg'">
            <div class="upnext-item-info">
              <div class="upnext-item-title">${s.title}</div>
              <div class="upnext-item-artist">${s.artist || ''}</div>
            </div>
            <div class="upnext-duration">${fmtTime(s.duration || 0)}</div>
          </div>`).join('')
            : '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px">No related songs found</div>';
    }
}

function updateUpNextChips(chips) {
    document.getElementById('upnextFilterRow').innerHTML = chips.map(c =>
        `<button class="upnext-chip${c === upNextFilter ? ' active' : ''}" data-filter="${c}" onclick="applyUpNextFilter('${c}',this)">${c === 'all' ? 'All' : c}</button>`
    ).join('');
}

function playSongFromUpNext(song) {
    queue.splice(queueIdx + 1, 0, song);
    playFromQueue(queueIdx + 1);
}

function playSongFromUpNextByIndex(idx) {
    const song = upNextRecommendations[idx];
    if (song) playSongFromUpNext(song);
}

// ════════════════════════════════════════════════════════════════
//  HISTORY PAGE
// ════════════════════════════════════════════════════════════════
function setView(viewName) {
    document.querySelectorAll('.nav-item').forEach(b => {
        b.classList.toggle('active', b.dataset.view === viewName);
    });
    document.querySelectorAll('#mobileNav .mob-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === viewName);
    });
}

async function renderHistoryPage() {
    setView('history');
    const el = document.getElementById('content');
    if (!currentUser) {
        el.innerHTML = `<h2 style="font-family:var(--font-head);margin-bottom:12px">Listening History</h2>
      <div style="color:var(--muted);font-size:14px;text-align:center;padding:40px 20px">
        <i class="fa-solid fa-clock-rotate-left" style="font-size:40px;margin-bottom:16px;display:block"></i>
        Sign in to track your history and get personalized music.<br><br>
        <button onclick="showLogin()" style="background:var(--accent);color:white;border:none;padding:12px 28px;border-radius:12px;font-size:14px;cursor:pointer;font-family:var(--font-head);font-weight:700">Sign In</button>
      </div>`; return;
    }
    el.innerHTML = '<p style="color:var(--muted);font-size:13px"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading...</p>';
    try {
        const hdr = { 'Authorization': 'Bearer ' + currentUser.token };
        const [hr, pr] = await Promise.all([
            fetch('/api/history?limit=50', { headers: hdr }),
            fetch('/api/profile', { headers: hdr }),
        ]);
        const hist = await hr.json();
        const prof = pr.ok ? await pr.json() : {};
        const ago = ts => { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
        window._historyItems = hist.items || [];
        el.innerHTML = `
      <div class="profile-card">
        <button class="user-logout" onclick="logoutUser(event); renderHistoryPage();" title="Logout" style="position: absolute; top: 20px; right: 20px; border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px; transition: color 0.2s;"><i class="fa-solid fa-right-from-bracket"></i></button>
        <div class="profile-avatar-lg">${currentUser.name[0].toUpperCase()}</div>
        <div style="font-family:var(--font-head);font-size:20px;font-weight:800">${currentUser.name}</div>
        <div style="color:var(--muted);font-size:12px;margin-top:4px">Your Taste Profile</div>
        <div class="profile-stats">
          <div class="profile-stat"><div class="profile-stat-num">${prof.totalPlays || 0}</div><div class="profile-stat-label">Played</div></div>
          <div class="profile-stat"><div class="profile-stat-num">${prof.liked || 0}</div><div class="profile-stat-label">Liked</div></div>
          <div class="profile-stat"><div class="profile-stat-num">${(prof.topArtists || []).length}</div><div class="profile-stat-label">Artists</div></div>
        </div>
        ${prof.topArtists?.length ? `<div style="margin-top:12px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🎤 Top Artists</div>${prof.topArtists.map(a => `<span class="taste-chip">${a}</span>`).join('')}</div>` : ''}
        ${prof.topGenres?.length ? `<div style="margin-top:10px"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🎵 Top Genres</div>${prof.topGenres.map(g => `<span class="taste-chip">${g}</span>`).join('')}</div>` : ''}
      </div>
      <h3 style="font-family:var(--font-head);margin-bottom:12px">🗓️ Recently Played</h3>
      ${window._historyItems.length === 0
                ? '<p style="color:var(--muted);font-size:13px">No history yet. Start listening!</p>'
                : window._historyItems.map((h, idx) => `
          <div class="history-item" onclick="playSongFromHistoryByIndex(${idx})">
            <img class="history-thumb" src="https://img.youtube.com/vi/${h.id}/hqdefault.jpg">
            <div class="history-info">
              <div class="history-title">${h.title || 'Unknown'}</div>
              <div class="history-artist">${h.artist || ''}</div>
            </div>
            <div class="history-time">${ago(h.playedAt)}</div>
          </div>`).join('')
            }`;
    } catch { el.innerHTML = '<p style="color:var(--accent)">Failed to load history.</p>'; }
}

function playSongFromHistoryByIndex(idx) {
    const item = window._historyItems?.[idx];
    if (item) {
        playSong({
            id: item.id,
            title: item.title,
            artist: item.artist,
            thumbnail: `https://img.youtube.com/vi/${item.id}/hqdefault.jpg`
        });
    }
}

function renderProfile() {
    setView('history');
    renderHistoryPage();
}

// ─── BOOT ────────────────────────────────────────────────────────────────
initAuth();
renderHome();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
}

