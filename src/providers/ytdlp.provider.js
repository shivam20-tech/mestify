const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const env = require('../config/env');

// Indian ISP IPs for geo-bypass (Jio, Airtel, BSNL, Vodafone)
const INDIAN_IPS = ['49.44.0.1', '103.21.124.1', '117.196.0.1', '122.160.0.1'];
const randomIndianIp = () => INDIAN_IPS[Math.floor(Math.random() * INDIAN_IPS.length)];

const STRATEGIES = [
  {
    clientArg: 'youtube:player_client=ios',
    extraArgs: ['--add-header', `X-Forwarded-For:${randomIndianIp()}`],
  },
  {
    clientArg: 'youtube:player_client=android',
    extraArgs: ['--add-header', `X-Forwarded-For:${randomIndianIp()}`],
  },
  {
    clientArg: 'youtube:player_client=web',
    extraArgs: [
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      '--add-header', `X-Forwarded-For:${randomIndianIp()}`,
    ],
  },
  {
    clientArg: 'youtube:player_client=tv',
    extraArgs: ['--add-header', `X-Forwarded-For:${randomIndianIp()}`],
  },
];

function attempt(videoId, strategy) {
  return new Promise((resolve, reject) => {
    const cookiesPath = path.join(process.cwd(), 'cookies.txt');
    const hasCookies = fs.existsSync(cookiesPath);

    const args = [
      ...(hasCookies ? ['--cookies', cookiesPath] : []),
      '--extractor-args', strategy.clientArg,
      ...strategy.extraArgs,
      '--no-playlist',
      '--geo-bypass',
      '--geo-bypass-country', 'IN',
      '--no-check-certificates',
      '--socket-timeout', '10',
      '--retries', '2',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--get-url',
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const proc = spawn(env.YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`timeout (${strategy.clientArg})`));
    }, process.env.YTDLP_TIMEOUT ? parseInt(process.env.YTDLP_TIMEOUT) : 25000);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      const url = stdout.trim().split('\n')[0];
      if (code === 0 && url.startsWith('http')) {
        resolve({ url, ext: 'm4a', isHLS: false });
      } else {
        if (stderr.includes('Sign in to confirm') || stderr.includes('bot')) {
          console.error('🍪 [yt-dlp] Bot detection — re-export cookies.txt from your browser');
        }
        reject(new Error(stderr.slice(0, 300) || `exit ${code}`));
      }
    });

    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function extract(videoId) {
  // Run ALL strategies simultaneously — first success wins.
  // This means worst-case time is 1×timeout, not 4×timeout.
  try {
    const result = await Promise.any(
      STRATEGIES.map(strategy => attempt(videoId, strategy))
    );
    return result;
  } catch (err) {
    // AggregateError — all strategies failed
    const msgs = err.errors
      ? err.errors.map(e => e.message.slice(0, 60)).join(' | ')
      : err.message;
    throw new Error(`All yt-dlp strategies failed: ${msgs}`);
  }
}

module.exports = { extract };

