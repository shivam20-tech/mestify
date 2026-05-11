const env = require('./env');

class MemoryCache {
  constructor() { this._store = new Map(); }

  async get(key) {
    const item = this._store.get(key);
    if (!item) return null;
    if (item.ttl && item.ttl < Date.now()) { this._store.delete(key); return null; }
    return item.value;
  }

  async setex(key, ttlSec, value) {
    this._store.set(key, { value, ttl: Date.now() + ttlSec * 1000 });
    if (this._store.size > 500) {
      this._store.delete(this._store.keys().next().value);
    }
  }

  async set(key, value) { this._store.set(key, { value, ttl: null }); }
  async del(key) { this._store.delete(key); }
  async quit() {}
}

let _cache = null;

async function initCache() {
  if (_cache) return _cache;

  if (env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      const redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        connectTimeout: 5000,
        lazyConnect: true,
      });
      await redis.connect();
      console.log('✅ Redis connected');
      _cache = redis;
      return _cache;
    } catch (e) {
      console.warn('⚠️  Redis failed, using in-memory cache:', e.message);
    }
  } else {
    console.log('ℹ️  No REDIS_URL — using in-memory cache (set REDIS_URL for production scale)');
  }

  _cache = new MemoryCache();
  return _cache;
}

function getCache() {
  if (!_cache) throw new Error('Cache not initialized. Call initCache() first.');
  return _cache;
}

module.exports = { initCache, getCache };
