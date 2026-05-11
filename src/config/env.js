require('dotenv').config();
const os = require('os');

// Auto-detect yt-dlp binary path by platform
// Windows: 'yt-dlp' or 'yt-dlp.exe' (must be in PATH or set YTDLP_PATH)
// Linux/Mac: '/usr/local/bin/yt-dlp'
function defaultYtdlpPath() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  return os.platform() === 'win32' ? 'yt-dlp' : '/usr/local/bin/yt-dlp';
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '8080', 10),
  REDIS_URL: process.env.REDIS_URL || null,
  YTDLP_PATH: defaultYtdlpPath(),
  AUDIO_CACHE_MAX: parseInt(process.env.AUDIO_CACHE_MAX || '100', 10),
  STREAM_URL_TTL_SEC: parseInt(process.env.STREAM_URL_TTL_SEC || String(6 * 3600), 10),
  PREFETCH_CONCURRENCY: parseInt(process.env.PREFETCH_CONCURRENCY || '4', 10),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
};
