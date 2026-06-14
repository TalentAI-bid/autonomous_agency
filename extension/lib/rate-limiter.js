// ─── Client-side defensive rate limiter ────────────────────────────────────
// The server is authoritative — this is an extra safety net that stops us
// from making two LinkedIn requests within minDelayMs of each other, even if
// the server dispatches them back-to-back.

const DEFAULT_LIMITS = {
  linkedin: {
    // Per-task minDelayMs is enforced by waitForSlot's slot-reservation math.
    // Batch cadence (batchSize/batchCooldownMs) was removed: the service
    // worker's single-flight taskQueueTail already serialises tasks, and
    // the server staggers dispatchAfter on bulk fanouts, so the extra
    // batch counter only ever produced spurious 60s cooldowns that
    // fail-fast'd the global sentinel and tanked auto-fanned-out fetches.
    search_companies:  { dailyCap: 30, minDelayMs: 4000 },
    fetch_company:     { dailyCap: 100, minDelayMs: 8000 },
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
    this.lastAction = {};        // { "site:type": timestampMs of next reserved slot }
    this.dailyCounts = {};       // { "site:type": n successful tasks today }
    this.reservedCounts = {};    // { "site:type": n reservations issued (for batch cadence) }
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
      this.reservedCounts = {};
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

    // Reserve the next slot atomically. Concurrent waitForSlot calls each
    // bump lastAction to the next available slot, so the 58 fetch_company
    // tasks that arrive together over WebSocket actually serialize instead
    // of racing to open 58 tabs at once. Previously lastAction was only
    // written by record() AFTER task success — so all concurrent reservations
    // saw last=0 and proceeded immediately, tripping LinkedIn 429s.
    const now = Date.now();
    const last = this.lastAction[key] ?? 0;
    const prevReserved = this.reservedCounts[key] ?? 0;
    const jitterPct = 0.3;
    const jitter = (Math.random() * 2 - 1) * jitterPct * limit.minDelayMs;
    const required = limit.minDelayMs + jitter;

    // Batch cadence: after every `batchSize` reservations, add a longer
    // cooldown so LinkedIn gets breathing room on long runs.
    this.reservedCounts[key] = prevReserved + 1;
    const batchSize = limit.batchSize ?? 0;
    const batchCooldownMs = limit.batchCooldownMs ?? 0;
    const inBatchEnd = batchSize > 0 && prevReserved > 0 && prevReserved % batchSize === 0;
    const extraCooldown = inBatchEnd ? batchCooldownMs : 0;

    const nextSlot = Math.max(now, last + required) + extraCooldown;
    const waitMs = nextSlot - now;

    // Long waits (batch cooldown) cannot be done via setTimeout in an MV3
    // service worker — Chrome can idle-kill the SW mid-await, taking the
    // whole single-flight queue chain with it. Roll back the reservation
    // and throw so the caller can schedule a chrome.alarms-based cooldown
    // and fail-fast subsequent tasks until the alarm fires.
    if (waitMs > 5000) {
      this.lastAction[key] = last;
      this.reservedCounts[key] = prevReserved;
      const err = new Error('batch_cooldown_pending');
      err.code = 'batch_cooldown_pending';
      err.cooldownUntil = nextSlot;
      throw err;
    }

    this.lastAction[key] = nextSlot;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
    }
  }

  async record(site, type) {
    const key = `${site}:${type}`;
    // lastAction is owned by waitForSlot's slot reservation — do not regress
    // it here, otherwise long-running tasks (which finish AFTER the next
    // reservation) would let later concurrent calls advance ahead.
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

  // Server-triggered purge — clears the in-memory + persisted daily counters
  // for the listed taskTypes (or all when null/empty). Called from the
  // service-worker on receipt of a `rate_limits_purged` WS push, and also
  // on WS reconnect when reconciling against /api/extension/me/rate-limits.
  async purgeDailyCounts(taskTypes) {
    await this._loaded;
    if (!taskTypes || taskTypes.length === 0) {
      this.dailyCounts = {};
      this.reservedCounts = {};
    } else {
      for (const k of taskTypes) {
        delete this.dailyCounts[k];
        delete this.reservedCounts[k];
      }
    }
    this.dailyResetAt = Date.now();
    await this._persist();
  }

  // Reconcile-from-server — overwrites local daily counts with the
  // authoritative server values. Used on WS reconnect to recover from any
  // missed `rate_limits_purged` push while the extension was offline.
  async reconcileFromServer({ dailyCounts, dailyResetAt }) {
    await this._loaded;
    if (dailyCounts && typeof dailyCounts === 'object') {
      this.dailyCounts = { ...dailyCounts };
    }
    if (dailyResetAt) {
      const t = typeof dailyResetAt === 'number' ? dailyResetAt : new Date(dailyResetAt).getTime();
      if (Number.isFinite(t)) this.dailyResetAt = t;
    }
    await this._persist();
  }
}

export function randomDelay(baseMs, pct = 0.3) {
  const jitter = (Math.random() * 2 - 1) * pct * baseMs;
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(baseMs + jitter))));
}
