require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ── Inject cookies.txt from Railway env var ──────────────────────────
// On Railway: set COOKIES_B64 = base64-encoded contents of cookies.txt
// To encode locally (PowerShell):
//   [Convert]::ToBase64String([IO.File]::ReadAllBytes("d:\mestify\cookies.txt")) | clip
if (process.env.COOKIES_B64) {
  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    fs.writeFileSync(cookiesPath, Buffer.from(process.env.COOKIES_B64, 'base64').toString('utf8'));
    console.log('✅ cookies.txt written from COOKIES_B64 env var');
  } catch (e) {
    console.warn('⚠️  Failed to write cookies.txt from COOKIES_B64:', e.message);
  }
}
// ────────────────────────────────────────────────────────────────────

const { initCache } = require('./src/config/redis');
const env = require('./src/config/env');

// Routes
const searchRoute  = require('./src/routes/search.route');
const streamRoute  = require('./src/routes/stream.route');
const relatedRoute = require('./src/routes/related.route');
const healthRoute  = require('./src/routes/health.route');

async function bootstrap() {
  // Init cache (Redis or in-memory fallback)
  await initCache();

  const app = express();

  // ── Middleware ──────────────────────────────────────────────────────
  app.use(cors({
    origin: env.ALLOWED_ORIGINS === '*' ? '*' : env.ALLOWED_ORIGINS.split(','),
    methods: ['GET', 'POST'],
  }));
  app.use(express.json());

  // ── Trust Railway/Heroku/Fly.io reverse proxy ──────────────────────
  // MUST be set before rate-limit middleware or X-Forwarded-For throws
  app.set('trust proxy', 1);

  // ── Rate limiting (uses express-rate-limit if installed) ───────────
  try {
    const rateLimit = require('express-rate-limit');

    // Global: 200 req/min
    app.use('/api', rateLimit({
      windowMs: 60 * 1000, max: 200,
      standardHeaders: true, legacyHeaders: false,
      message: { error: 'Too many requests — slow down' },
    }));

    // Stream endpoints: 30 req/min (prevents abuse)
    app.use('/api/stream', rateLimit({
      windowMs: 60 * 1000, max: 30,
      message: { error: 'Stream rate limit exceeded' },
    }));

    // Search: 60 req/min
    app.use('/api/search', rateLimit({
      windowMs: 60 * 1000, max: 60,
      message: { error: 'Search rate limit exceeded' },
    }));

    console.log('✅ Rate limiting enabled');
  } catch (_) {
    console.warn('⚠️  express-rate-limit not installed — run: npm install express-rate-limit');
  }

  // ── Static files (serves index.html + manifest + icons) ───────────
  app.use(express.static(path.join(__dirname)));

  // ── API Routes ─────────────────────────────────────────────────────
  app.use('/api', searchRoute);
  app.use('/api', streamRoute);
  app.use('/api', relatedRoute);
  app.use('/',    healthRoute);

  // ── SPA fallback ───────────────────────────────────────────────────
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, 'index.html'));
    }
  });

  // ── Start ──────────────────────────────────────────────────────────
  app.listen(env.PORT, () => {
    console.log(`🎵 Mestify → http://localhost:${env.PORT}`);
    console.log(`   NODE_ENV:   ${env.NODE_ENV}`);
    console.log(`   REDIS_URL:  ${env.REDIS_URL ? '✅ set' : '⚠️  not set (in-memory)'}`);
    console.log(`   YTDLP_PATH: ${env.YTDLP_PATH}`);

    // Verify yt-dlp binary is accessible
    const { exec } = require('child_process');
    exec(`"${env.YTDLP_PATH}" --version`, (err, stdout) => {
      if (err) {
        console.error(`   ❌ yt-dlp NOT found at "${env.YTDLP_PATH}"`);
        console.error(`      → Install: pip install yt-dlp  OR  winget install yt-dlp`);
        console.error(`      → Or set YTDLP_PATH=C:\\path\\to\\yt-dlp.exe in .env`);
      } else {
        console.log(`   yt-dlp:     ✅ v${stdout.trim()}`);
      }
    });
  });
}

bootstrap().catch(err => {
  console.error('💥 Fatal startup error:', err);
  process.exit(1);
});