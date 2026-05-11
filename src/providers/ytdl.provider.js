const fs = require('fs');
const path = require('path');

let ytdl = null;
try {
  ytdl = require('@distube/ytdl-core');
  console.log('✅ @distube/ytdl-core loaded (fallback engine)');
} catch (e) {
  console.warn('⚠️  @distube/ytdl-core not available:', e.message);
}

// Parse Netscape cookies.txt → array of {name, value} objects for ytdl agent
function parseCookies() {
  const cookiesPath = path.join(process.cwd(), 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) return [];
  try {
    return fs.readFileSync(cookiesPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => {
        const p = l.split('\t');
        if (p.length < 7) return null;
        return { domain: p[0], path: p[2], secure: p[3] === 'TRUE', name: p[5], value: p[6].trim() };
      })
      .filter(Boolean);
  } catch (_) { return []; }
}

async function extract(videoId) {
  if (!ytdl) throw new Error('ytdl-core not loaded');

  const cookies = parseCookies();
  const agent = cookies.length
    ? ytdl.createAgent(cookies)
    : ytdl.createAgent();

  const info = await ytdl.getInfo(videoId, { agent });
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('No audio format found via ytdl-core');

  return {
    url: format.url,
    ext: format.container || 'mp4',
    isHLS: format.isHLS || false,
  };
}

module.exports = { extract };

