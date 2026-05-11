const fs = require('fs');
const path = require('path');

let ytdl = null;
try {
  ytdl = require('@distube/ytdl-core');
  console.log('✅ @distube/ytdl-core loaded (fallback engine)');
} catch (e) {
  console.warn('⚠️  @distube/ytdl-core not available:', e.message);
}

// Parse Netscape cookies.txt → Cookie header string
function readCookieHeader() {
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

async function extract(videoId) {
  if (!ytdl) throw new Error('ytdl-core not loaded');

  const cookie = readCookieHeader();
  const requestOptions = cookie
    ? { headers: { Cookie: cookie, 'X-Forwarded-For': '49.44.0.1' } }
    : { headers: { 'X-Forwarded-For': '49.44.0.1' } };

  const info = await ytdl.getInfo(videoId, { requestOptions });
  const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw new Error('No audio format found via ytdl-core');

  return {
    url: format.url,
    ext: format.container || 'mp4',
    isHLS: format.isHLS || false,
  };
}

module.exports = { extract };
