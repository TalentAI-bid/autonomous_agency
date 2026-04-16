// ─── Client-side defensive rate limiter ────────────────────────────────────
// The server is authoritative — this is an extra safety net that stops us
// from making two LinkedIn requests within minDelayMs of each other, even if
// the server dispatches them back-to-back.

const DEFAULT_LIMITS = {
  linkedin: {
    search_companies: { dailyCap: 10, minDelayMs: 4000 },
    fetch_company:    { dailyCap: 100, minDelayMs: 4000 },
  },
  gmaps: {
    search_businesses: { dailyCap: 20, minDelayMs: 2000 },
    fetch_business:    { dailyCap: 200, minDelayMs: 2000 },
  },
  crunchbase: {
    search_companies: { dailyCap: 10, minDelayMs: 5000 },
    fetch_company:    { dailyCap: 50, minDelayMs: 5000 },
  },
};

const STORAGE_KEY = 'rateLimiterState';

export class RateLimiter {
  constructor() {
    this.limits = DEFAULT_LIMITS;
    this.lastAction = {};        // { "site:type": timestampMs }
    this.dailyCounts = {};       // { "site:type": n }
    this.dailyResetAt = Date.now();
    this._loaded = this._load();
  }

  async _load() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const saved = data[STORAGE_KEY];
      if (saved && typeof saved === 'object') {
        this.lastAction = saved.lastAction ?? {};
        this.dailyCounts = saved.dailyCounts ?? {};
        this.dailyResetAt = saved.dailyResetAt ?? Date.now();
      }
      this._maybeResetDaily();
    } catch (err) {
      console.warn('[rate-limiter] load failed', err);
    }
  }

  async _persist() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          lastAction: this.lastAction,
          dailyCounts: this.dailyCounts,
          dailyResetAt: this.dailyResetAt,
        },
      });
    } catch (err) {
      console.warn('[rate-limiter] persist failed', err);
    }
  }

  _maybeResetDaily() {
    const now = Date.now();
    if (now - this.dailyResetAt > 24 * 60 * 60 * 1000) {
      this.dailyCounts = {};
      this.dailyResetAt = now;
    }
  }

  getLimit(site, type) {
    return this.limits[site]?.[type];
  }

  async waitForSlot(site, type) {
    await this._loaded;
    this._maybeResetDaily();
    const key = `${site}:${type}`;
    const limit = this.getLimit(site, type);
    if (!limit) return;

    const used = this.dailyCounts[key] ?? 0;
    if (used >= limit.dailyCap) {
      const err = new Error('daily_cap_reached');
      err.code = 'daily_cap_reached';
      throw err;
    }

    const last = this.lastAction[key] ?? 0;
    const elapsed = Date.now() - last;
    const jitterPct = 0.3;
    const jitter = (Math.random() * 2 - 1) * jitterPct * limit.minDelayMs; // ±30%
    const required = limit.minDelayMs + jitter;
    if (elapsed < required) {
      await new Promise((r) => setTimeout(r, Math.ceil(required - elapsed)));
    }
  }

  async record(site, type) {
    const key = `${site}:${type}`;
    this.lastAction[key] = Date.now();
    this.dailyCounts[key] = (this.dailyCounts[key] ?? 0) + 1;
    this._persist();
  }

  getUsage() {
    this._maybeResetDaily();
    const usage = [];
    for (const [siteName, types] of Object.entries(this.limits)) {
      for (const [typeName, cfg] of Object.entries(types)) {
        const key = `${siteName}:${typeName}`;
        usage.push({
          site: siteName,
          type: typeName,
          used: this.dailyCounts[key] ?? 0,
          cap: cfg.dailyCap,
        });
      }
    }
    return { usage, dailyResetAt: this.dailyResetAt };
  }
}

export function randomDelay(baseMs, pct = 0.3) {
  const jitter = (Math.random() * 2 - 1) * pct * baseMs;
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(baseMs + jitter))));
}
