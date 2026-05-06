// ─── Background service worker (MV3) ──────────────────────────────────────
// Connects to the TalentAI backend via WebSocket, receives task messages,
// opens/focuses a site tab, injects the matching adapter, and posts results
// back to the server.

import { TalentAIWebSocket } from '../lib/ws-client.js';
import { RateLimiter } from '../lib/rate-limiter.js';
import {
  getSession,
  signIn,
  signOut,
  refreshSession,
  toWsOrigin,
  authedFetch,
} from '../lib/auth-client.js';
import { BACKEND_URL } from '../config.js';

// Hardcoded backend — edit `extension/config.js` to point at a different server.
const DEFAULT_SERVER = BACKEND_URL;
const rateLimiter = new RateLimiter();
let ws = null;
let paused = false;
let currentTask = null;
let currentMasterAgentName = null;
let currentStatus = 'idle';

// Single-flight task queue. WebSocket delivers task messages concurrently
// (e.g. 58 fetch_company tasks fire from the server in rapid succession);
// without this chain, 58 processTask calls would race and open 58 tabs at
// once, tripping LinkedIn 429s. Each new task tail-chains onto the
// previous, so processTask runs sequentially and the rate-limiter's
// per-task delays + batch cooldown are actually honored.
let taskQueueTail = Promise.resolve();

// Post-task pacing — pause between consecutive dispatches so we avoid
// burning through LinkedIn's per-minute ceiling. Round 11 dial-back from
// Round 9's settings: ~half wall-clock, still well under LinkedIn's 429
// floor (sustained ~1 hit/sec).
const TASK_DELAYS_MS = {
  search_companies: 3000,
  fetch_company_info: 2000,
  fetch_company_team: 3000,
  fetch_company: 2500,
  default: 2000,
};
function taskJitter(ms, fraction = 0.3) {
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * fraction * ms));
}
function taskSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── LinkedIn geo-code map ─────────────────────────────────────────────────
// LinkedIn's `companyHqGeo` URL parameter expects numeric geo IDs, not free
// text. If we don't map, LinkedIn silently ignores the filter and returns
// globally-irrelevant results. Extend this table as needed.
const LINKEDIN_GEO_CODES = {
  'united kingdom': '101165590',
  'uk': '101165590',
  'england': '101165590',
  'london': '102257491',
  'ireland': '104738515',
  'france': '105015875',
  'paris': '105259460',
  'germany': '101282230',
  'spain': '105646813',
  'united states': '103644278',
  'usa': '103644278',
  'estonia': '102974008',
};

// ─── Adapter registry (files injected for each {site, type}) ───────────────
const ADAPTER_FILES = {
  'linkedin:search_companies':   ['lib/scraper-utils.js', 'content/linkedin/search-companies.js'],
  'linkedin:fetch_company':      ['lib/scraper-utils.js', 'content/linkedin/fetch-company.js'],
  // Parallel-fetch split — info loads /about, team loads /people. They run
  // as independent extension_tasks rows so one failure doesn't block the
  // other. Legacy fetch_company stays for already-queued rows.
  'linkedin:fetch_company_info': ['lib/scraper-utils.js', 'content/linkedin/fetch-company-info.js'],
  'linkedin:fetch_company_team': ['lib/scraper-utils.js', 'content/linkedin/fetch-company-team.js'],
  'gmaps:search_businesses':     ['lib/scraper-utils.js', 'content/gmaps/search-businesses.js'],
  'gmaps:fetch_business':        ['lib/scraper-utils.js', 'content/gmaps/fetch-business.js'],
  'crunchbase:search_companies': ['lib/scraper-utils.js', 'content/crunchbase/search-companies.js'],
  'crunchbase:fetch_company':    ['lib/scraper-utils.js', 'content/crunchbase/fetch-company.js'],
};

// ─── Startup: open WS if we have an active session ─────────────────────────
async function ensureConnected() {
  const { paused: storedPaused } = await chrome.storage.local.get('paused');
  paused = !!storedPaused;

  const session = await getSession();
  if (!session) { setStatus('idle'); return; }
  if (!session.apiKey) { setStatus('idle'); return; } // signed in but WS key missing
  if (paused) { setStatus('paused'); return; }
  if (ws) return;

  ws = new TalentAIWebSocket({
    serverUrl: toWsOrigin(session.serverUrl || DEFAULT_SERVER),
    apiKey: session.apiKey,
    onStatus: (s) => setStatus(s),
    onMessage: (msg) => handleMessage(msg),
    onOpen: () => { reconcileRateLimitsFromServer().catch(() => {}); },
  });
  ws.connect();
}

// Pulls authoritative server-side daily counters and overwrites the local
// chrome.storage mirror. Best-effort: any failure (offline, server down,
// auth expired) is logged at debug and ignored — the next reconnect retries.
async function reconcileRateLimitsFromServer() {
  try {
    const res = await authedFetch('/api/extension/me/rate-limits');
    if (!res.ok) {
      console.debug('[TalentAI sw] rate-limit reconcile: http', res.status);
      return;
    }
    const body = await res.json().catch(() => null);
    const data = body?.data;
    if (!data || typeof data !== 'object') return;
    await rateLimiter.reconcileFromServer({
      dailyCounts: data.dailyCounts ?? {},
      dailyResetAt: data.dailyResetAt ?? null,
    });
    console.info('[TalentAI sw] rate-limit reconcile complete', { dailyCounts: data.dailyCounts });
  } catch (err) {
    console.debug('[TalentAI sw] rate-limit reconcile failed', err?.message ?? err);
  }
}

function setStatus(status) {
  currentStatus = status;
  chrome.storage.local.set({ connectionStatus: status }).catch(() => {});
  try {
    chrome.runtime.sendMessage({ kind: 'status', status }).catch(() => {});
  } catch (_) { /* no listeners yet */ }
}

async function handleMessage(msg) {
  console.log('[TalentAI sw] ws_recv', { type: msg?.type, taskId: msg?.taskId });
  if (msg.type === 'welcome') return;
  if (msg.type === 'revoked') {
    // WS-side key is dead, but keep the JWT so the popup can auto re-provision
    // without a full sign-in.
    const session = await getSession();
    if (session) {
      await chrome.storage.local.set({ session: { ...session, apiKey: null } });
    }
    ws?.close();
    ws = null;
    setStatus('unauthorized');
    return;
  }
  if (msg.type === 'task') {
    console.log('[TalentAI sw] queueing', { taskId: msg.taskId, site: msg.site, taskType: msg.taskType });
    // Tail-chain onto the single-flight queue. Don't await — the WS client
    // must remain free to receive subsequent messages while this task runs.
    taskQueueTail = taskQueueTail.then(() => processTask(msg).catch((err) => {
      console.error('[TalentAI sw] task processing error', { taskId: msg.taskId, err: err?.message ?? String(err) });
    }));
    return;
  }
  if (msg.type === 'cancel') {
    // best-effort: just clear currentTask
    if (currentTask?.taskId === msg.taskId) {
      currentTask = null;
      currentMasterAgentName = null;
      broadcast('current_task', null);
    }
    return;
  }
  if (msg.type === 'rate_limits_purged') {
    // Server (or an admin via /api/admin/extension/reset-rate-limits) reset
    // the daily counters. Clear our local mirror so the next dispatch isn't
    // blocked by a stale cap. Also clear the consecutive-429 backoff state
    // and the daily-block sentinel — those are separate, but a user-triggered
    // reset is the right time to give the extension a clean slate.
    try {
      await rateLimiter.purgeDailyCounts(msg.taskTypes ?? null);
      await chrome.storage.local.set({ consecutive429s: 0, dailyBlockUntil: null });
      console.info('[TalentAI sw] rate_limits_purged from server', { taskTypes: msg.taskTypes ?? '<all>' });
      broadcast('popup_update', { status: 'idle', message: 'Rate limits reset.' });
    } catch (err) {
      console.warn('[TalentAI sw] rate_limits_purged handler failed', err);
    }
    return;
  }
}

async function processTask(msg) {
  const { taskId, site, taskType, params, masterAgentName } = msg;
  const adapterKey = `${site}:${taskType}`;
  const files = ADAPTER_FILES[adapterKey];
  console.log('[TalentAI sw] adapter', { adapterKey, hasFiles: !!files, taskId });

  if (!files) {
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: `no_adapter_for:${adapterKey}` });
    return;
  }
  if (paused) {
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: 'extension_paused' });
    return;
  }

  // Check daily block (5+ consecutive 429s → blocked until midnight UTC)
  const blockState = await chrome.storage.local.get(['dailyBlockUntil']);
  if (blockState.dailyBlockUntil && Date.now() < blockState.dailyBlockUntil) {
    console.log('[TalentAI sw] daily_block_active', { taskId, until: new Date(blockState.dailyBlockUntil).toISOString() });
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: 'rate_limited_429' });
    return;
  }

  currentTask = { taskId, site, taskType, params };
  currentMasterAgentName = masterAgentName ?? null;
  broadcast('current_task', { task: currentTask, masterAgentName: currentMasterAgentName });

  // Defensive client-side rate-limit (server is authoritative, but this protects against bursty dispatch)
  try {
    await rateLimiter.waitForSlot(site, taskType);
  } catch (err) {
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: err.code || String(err.message) });
    currentTask = null;
    currentMasterAgentName = null;
    broadcast('current_task', null);
    return;
  }

  let tab = null;
  // Only the legacy single-shot detail tasks open a brand-new tab and
  // close it after. fetch_company_info / fetch_company_team go through
  // the openOrFocusTab path so the LinkedIn session stays warm across
  // many sequential fetches. The race that produced the chrome-extension
  // /about/ loop is fixed by the listener-before-update pattern in
  // navigateExistingTab below.
  const isDetailTask = (taskType === 'fetch_company' || taskType === 'fetch_business');
  try {
    const target = buildUrl(site, taskType, params);
    console.log('[TalentAI sw] navigate begin', { taskId, taskType, target, isDetailTask });
    if (isDetailTask) {
      // Detail pages open in a NEW tab to avoid navigating away from search results.
      tab = await createAndWaitTab(target);
    } else {
      tab = await openOrFocusTab(target, site);
    }
    console.log('[TalentAI sw] tab', { tabId: tab?.id, url: target, isDetailTask });

    // Pre-inject hostname check: never inject an adapter onto a chrome-extension://
    // (or any non-target-host) tab — that's how the chrome-extension://<id>/about/
    // navigation loop happens. navigateExistingTab / createAndWaitTab already
    // ensure this, but assert once more right before the inject in case the
    // user manually navigated the tab during the wait or LinkedIn redirected
    // post-complete.
    const expectedHost = (() => {
      try { return new URL(target).hostname; } catch (_) { return ''; }
    })();
    const liveTab = await chrome.tabs.get(tab.id).catch(() => null);
    const liveHost = (() => {
      try { return new URL(liveTab?.url || '').hostname; } catch (_) { return ''; }
    })();
    if (!expectedHost || liveHost !== expectedHost) {
      console.log('[TalentAI sw] inject_aborted_wrong_host', { expectedHost, liveHost, liveUrl: liveTab?.url });
      ws?.send({
        type: 'task_result',
        taskId,
        status: 'failed',
        error: `tab_not_on_expected_host:${liveHost || 'unknown'}`,
      });
      return;
    }

    // Stash params for the injected adapter (via chrome.storage.session if available)
    const storageKey = `task_${taskId}`;
    await chrome.storage.session?.set({ [storageKey]: { taskId, params } }).catch(() => {});

    // Inject scraper utils + the adapter; adapter returns its result to us via message passing.
    const resultMsg = await new Promise(async (resolve) => {
      const listener = (m, _sender, _sendResponse) => {
        if (m && m.kind === 'scrape_result' && m.taskId === taskId) {
          console.log('[TalentAI sw] adapter_result', {
            taskId: m.taskId,
            status: m.status,
            hasResult: !!m.result,
            error: m.error ?? null,
          });
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timeout);
          resolve(m);
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ kind: 'scrape_result', taskId, status: 'failed', error: 'adapter_timeout_180s' });
      }, 180_000);

      try {
        console.log('[TalentAI sw] inject', { files, taskId });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files,
        });
        // Kick off the adapter — adapters export a global entrypoint `window.__talentaiRun(params)`.
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [taskId, params],
          func: (taskIdArg, paramsArg) => {
            (async () => {
              try {
                const fn = window.__talentaiRun;
                if (typeof fn !== 'function') {
                  chrome.runtime.sendMessage({ kind: 'scrape_result', taskId: taskIdArg, status: 'failed', error: 'adapter_not_loaded' });
                  return;
                }
                const res = await fn(paramsArg);
                chrome.runtime.sendMessage({ kind: 'scrape_result', taskId: taskIdArg, status: 'completed', result: res });
              } catch (err) {
                chrome.runtime.sendMessage({
                  kind: 'scrape_result',
                  taskId: taskIdArg,
                  status: 'failed',
                  error: (err && err.message) ? err.message : String(err),
                });
              }
            })();
          },
        });
      } catch (injErr) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ kind: 'scrape_result', taskId, status: 'failed', error: `inject_failed:${injErr.message || injErr}` });
      }
    });

    // ─── Blocked-by-popup short-circuit ────────────────────────────────────
    // Adapter detected a terms/premium/cookie modal on the page. We do NOT
    // auto-dismiss — we pause the whole extension, surface a message in the
    // popup, and tell the server to keep the task retryable. User must
    // dismiss the modal in the visible tab and click Resume.
    if (
      resultMsg.status === 'completed' &&
      resultMsg.result?.debug?.reason === 'blocked_by_popup'
    ) {
      const debug = resultMsg.result.debug;
      console.log('[TalentAI sw] blocked_by_popup', { taskId, blockedBy: debug.blockedBy });
      paused = true;
      await chrome.storage.local.set({ paused: true });
      setStatus('blocked');
      broadcast('popup_update', {
        status: 'blocked',
        message: debug.userAction || 'LinkedIn popup detected. Please dismiss it and click Resume.',
        blockedBy: debug.blockedBy,
      });
      ws?.send({
        type: 'task_result',
        taskId,
        status: 'failed',
        error: 'blocked_by_popup',
        result: resultMsg.result,
      });
      return;
    }

    // ─── Rate-limited (429) short-circuit with exponential backoff ─────
    if (
      resultMsg.status === 'completed' &&
      resultMsg.result?.debug?.reason === 'rate_limited_429'
    ) {
      console.log('[TalentAI sw] rate_limited_429', { taskId });
      ws?.send({
        type: 'task_result',
        taskId,
        status: 'failed',
        error: 'rate_limited_429',
        result: resultMsg.result,
      });

      // Exponential backoff: 30s → 60s → 120s → 240s → 480s → 600s (cap)
      const MAX_BACKOFF_MS = 600_000; // 10 minutes
      const MAX_CONSECUTIVE_BEFORE_DAILY_BLOCK = 5;
      const stored = await chrome.storage.local.get(['consecutive429s']);
      const consecutive = (stored.consecutive429s ?? 0) + 1;
      await chrome.storage.local.set({ consecutive429s: consecutive });

      if (consecutive >= MAX_CONSECUTIVE_BEFORE_DAILY_BLOCK) {
        // Block until next UTC midnight
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        await chrome.storage.local.set({ dailyBlockUntil: midnight.getTime() });
        console.log('[TalentAI sw] daily_block_set', { consecutive, until: midnight.toISOString() });
        broadcast('popup_update', {
          status: 'rate_limited',
          message: `LinkedIn rate limit hit ${consecutive} times. Pausing all LinkedIn tasks until ${midnight.toUTCString()}.`,
        });
      } else {
        const backoffMs = Math.min(30_000 * Math.pow(2, consecutive - 1), MAX_BACKOFF_MS);
        console.log('[TalentAI sw] 429_backoff', { consecutive, backoffMs });
        broadcast('popup_update', {
          status: 'rate_limited',
          message: `LinkedIn rate limited. Backing off for ${Math.round(backoffMs / 1000)}s (attempt ${consecutive}/${MAX_CONSECUTIVE_BEFORE_DAILY_BLOCK}).`,
        });
        // Auto-resume after backoff (don't pause permanently like blocked_by_popup)
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      return;
    }

    // ─── Successful task: reset 429 counter ───────────────────────────
    if (resultMsg.status === 'completed') {
      const stored = await chrome.storage.local.get(['consecutive429s']);
      if (stored.consecutive429s > 0) {
        await chrome.storage.local.set({ consecutive429s: 0 });
        console.log('[TalentAI sw] 429_counter_reset');
      }
    }

    await rateLimiter.record(site, taskType);

    console.log('[TalentAI sw] ws_send_task_result', { taskId, status: resultMsg.status });
    ws?.send({
      type: 'task_result',
      taskId,
      status: resultMsg.status,
      result: resultMsg.status === 'completed' ? resultMsg.result : undefined,
      error:  resultMsg.status === 'failed'    ? resultMsg.error  : undefined,
    });
  } catch (err) {
    console.error('[TalentAI] task failed', err);
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: err.message || String(err) });
  } finally {
    // Close detail-task tabs after completion — search tabs stay open.
    if (isDetailTask && tab) {
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
    currentTask = null;
    currentMasterAgentName = null;
    broadcast('current_task', null);

    // Post-task pace — sleep between consecutive dispatches so the
    // single-flight queue spreads load over time. Per task type, with
    // ±30% jitter to avoid a regular pattern.
    const delayMs = TASK_DELAYS_MS[taskType] ?? TASK_DELAYS_MS.default;
    await taskSleep(taskJitter(delayMs));
  }
}

function buildUrl(site, type, params) {
  if (site === 'linkedin' && type === 'search_companies') {
    // Server is now the single source of truth for the search URL — when
    // params.searchUrl is provided by agentcore (built via the
    // linkedin-url.service with companyHqGeo + companySize facets), use it
    // as-is. The fall-through below is a backward-compat path for any
    // extension_tasks rows enqueued by an older agentcore.
    if (typeof params.searchUrl === 'string' && params.searchUrl.startsWith('https://www.linkedin.com/')) {
      return params.searchUrl;
    }
    const keywords = encodeURIComponent(params.industry || '');
    const locLower = (params.location || '').toLowerCase().trim();
    const geoCode = LINKEDIN_GEO_CODES[locLower];
    if (geoCode) {
      // companyHqGeo=["<code>"] — must be URL-encoded as %5B%22...%22%5D.
      return `https://www.linkedin.com/search/results/companies/?keywords=${keywords}&companyHqGeo=%5B%22${geoCode}%22%5D`;
    }
    // Fallback: fold the location text into the keyword query so at least
    // some filtering happens client-side in LinkedIn's search ranking.
    return `https://www.linkedin.com/search/results/companies/?keywords=${keywords}%20${encodeURIComponent(params.location || '')}`;
  }
  if (site === 'linkedin' && type === 'fetch_company') {
    return params.linkedinUrl;
  }
  if (site === 'linkedin' && type === 'fetch_company_info') {
    // Force /about/ so the adapter lands on the about page directly.
    const base = (params.linkedinUrl || '').replace(/\/?$/, '/');
    return base.includes('/about/') ? base : base + 'about/';
  }
  if (site === 'linkedin' && type === 'fetch_company_team') {
    // /people/ shows the in-app team listing; the adapter further clicks
    // through to /search/results/people/?currentCompany=... when needed.
    const base = (params.linkedinUrl || '').replace(/\/?$/, '/');
    return base.includes('/people/') ? base : base + 'people/';
  }
  if (site === 'gmaps' && type === 'search_businesses') {
    const q = encodeURIComponent([params.query, params.location].filter(Boolean).join(' '));
    return `https://www.google.com/maps/search/${q}`;
  }
  if (site === 'gmaps' && type === 'fetch_business') {
    return params.mapsUrl;
  }
  if (site === 'crunchbase' && type === 'search_companies') {
    const q = encodeURIComponent(params.query ?? '');
    return `https://www.crunchbase.com/discover/organization.companies/search/?q=${q}`;
  }
  if (site === 'crunchbase' && type === 'fetch_company') {
    return params.crunchbaseUrl;
  }
  throw new Error(`no_url_builder_for:${site}:${type}`);
}

async function openOrFocusTab(url, site) {
  const hostMatch = {
    linkedin: '*://*.linkedin.com/*',
    gmaps: '*://*.google.com/maps*',
    crunchbase: '*://*.crunchbase.com/*',
  }[site];

  if (hostMatch) {
    const existing = await chrome.tabs.query({ url: hostMatch });
    if (existing.length > 0) {
      const tab = existing[0];
      console.log('[TalentAI sw] reusing tab', { tabId: tab.id, currentUrl: tab.url, target: url });
      try {
        await navigateExistingTab(tab.id, url);
        return tab;
      } catch (err) {
        console.warn('[TalentAI sw] navigate existing failed, creating new', err?.message ?? err);
      }
    }
  }
  console.log('[TalentAI sw] opening new tab', { target: url });
  return await createAndWaitTab(url);
}

// Navigate an existing tab to a new URL. Listener is attached BEFORE the
// chrome.tabs.update call so we can never miss the next `complete` event
// (especially for cached pages that load instantly). Hostname-matched so
// we don't resolve on the prior page's stale complete state.
function navigateExistingTab(tabId, url, timeoutMs = 45_000) {
  let expectedHost = '';
  try { expectedHost = new URL(url).hostname; } catch (_) {}

  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = () => chrome.tabs.onUpdated.removeListener(listener);
    const finishOnce = (label) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      console.log('[TalentAI sw] navigateExistingTab done', { tabId, label });
      resolve();
    };
    const listener = (updatedId, info, tab) => {
      if (updatedId !== tabId || resolved) return;
      if (info.status !== 'complete' || !tab || !tab.url) return;
      try {
        if (new URL(tab.url).hostname === expectedHost) finishOnce('listener_complete');
      } catch (_) {}
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => finishOnce('timeout'), timeoutMs);

    // Kick off navigation AFTER listener attached.
    chrome.tabs.update(tabId, { url, active: true }).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

// Create a new tab on the URL and wait for its first `complete` event on
// the expected hostname.
function createAndWaitTab(url, timeoutMs = 45_000) {
  let expectedHost = '';
  try { expectedHost = new URL(url).hostname; } catch (_) {}

  return new Promise((resolve, reject) => {
    let resolved = false;
    let createdTab = null;
    const cleanup = () => chrome.tabs.onUpdated.removeListener(listener);
    const finishOnce = (label) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      console.log('[TalentAI sw] createAndWaitTab done', { tabId: createdTab?.id, label });
      resolve(createdTab);
    };
    const listener = (updatedId, info, tab) => {
      if (!createdTab || updatedId !== createdTab.id || resolved) return;
      if (info.status !== 'complete' || !tab || !tab.url) return;
      try {
        if (new URL(tab.url).hostname === expectedHost) finishOnce('listener_complete');
      } catch (_) {}
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => finishOnce('timeout'), timeoutMs);

    chrome.tabs.create({ url, active: true }).then((tab) => {
      createdTab = tab;
    }).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

function broadcast(kind, data) {
  try {
    chrome.runtime.sendMessage({ kind, data }).catch(() => {});
  } catch (_) {}
}

// ─── Popup messages ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.kind === 'popup_get_state') {
      const session = await getSession();
      const usage = rateLimiter.getUsage();
      sendResponse({
        signedIn: !!session,
        hasKey: !!session?.apiKey,
        user: session?.user ?? null,
        tenant: session?.tenant ?? null,
        serverUrl: session?.serverUrl || DEFAULT_SERVER,
        status: currentStatus,
        paused,
        currentTask,
        masterAgentName: currentMasterAgentName,
        usage: usage.usage,
        dailyResetAt: usage.dailyResetAt,
      });
      return;
    }

    if (msg?.kind === 'popup_signin') {
      try {
        // Server URL is no longer user-configurable; always use the constant
        // from config.js. Any `msg.serverUrl` is ignored (defensive — the
        // popup doesn't send it anymore).
        const result = await signIn({
          serverUrl: BACKEND_URL,
          email: msg.email,
          password: msg.password,
        });
        paused = false;
        await chrome.storage.local.set({ paused: false });
        if (ws) { ws.close(); ws = null; }
        await ensureConnected();
        sendResponse({ ok: true, user: result.user, tenant: result.tenant });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return;
    }

    if (msg?.kind === 'popup_signout') {
      try { await signOut(); } catch (_) {}
      ws?.close();
      ws = null;
      currentTask = null;
      currentMasterAgentName = null;
      setStatus('idle');
      sendResponse({ ok: true });
      return;
    }

    if (msg?.kind === 'popup_toggle_pause') {
      paused = !paused;
      await chrome.storage.local.set({ paused });
      if (paused) {
        ws?.close();
        ws = null;
        setStatus('paused');
      } else {
        await ensureConnected();
      }
      sendResponse({ ok: true, paused });
      return;
    }

    // ─── Snov.io-style profile widget ────────────────────────────────────
    if (msg?.kind === 'list_master_agents') {
      try {
        const cached = await getCachedMasterAgents();
        if (cached) { sendResponse({ ok: true, agents: cached }); return; }
        const res = await authedFetch('/api/master-agents');
        if (!res.ok) throw new Error(`http_${res.status}`);
        const body = await res.json();
        const agents = (body?.data ?? []).map((a) => ({ id: a.id, name: a.name, useCase: a.useCase }));
        await setCachedMasterAgents(agents);
        sendResponse({ ok: true, agents });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return;
    }

    if (msg?.kind === 'manual_add_profile') {
      try {
        const payload = msg.payload || {};
        const res = await authedFetch('/api/extension/contacts/manual', {
          method: 'POST',
          body: payload,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ ok: false, error: body?.error || `http_${res.status}` });
          return;
        }
        sendResponse({ ok: true, ...(body?.data ?? {}) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return;
    }
  })();
  return true; // async sendResponse
});

// ─── Master-agent cache (5 min) ────────────────────────────────────────────
async function getCachedMasterAgents() {
  try {
    const { masterAgentsCache } = await chrome.storage.session.get('masterAgentsCache');
    if (masterAgentsCache && Date.now() - masterAgentsCache.fetchedAt < 5 * 60_000) {
      return masterAgentsCache.agents;
    }
  } catch (_) { /* session storage unavailable in some contexts */ }
  return null;
}

async function setCachedMasterAgents(agents) {
  try {
    await chrome.storage.session.set({
      masterAgentsCache: { agents, fetchedAt: Date.now() },
    });
  } catch (_) { /* ignore */ }
}

// ─── Update check ──────────────────────────────────────────────────────────
// Self-hosted CRX auto-update is blocked on consumer Chrome since 2018, so
// we poll the backend's latest.json and surface a "NEW" badge + popup banner
// when a newer version is published. We never auto-download or auto-reload.
async function checkForUpdate() {
  try {
    const res = await fetch(`${DEFAULT_SERVER}/extension/latest.json`, { cache: 'no-store' });
    if (!res.ok) return;
    const latest = await res.json();
    const remoteVersion = String(latest.version || '').trim();
    const currentVersion = chrome.runtime.getManifest().version;
    if (!remoteVersion || !isNewerVersion(remoteVersion, currentVersion)) {
      // No update — also clear any stale banner if the user already updated past it.
      const { updateAvailable } = await chrome.storage.local.get('updateAvailable');
      if (updateAvailable && !isNewerVersion(updateAvailable.version, currentVersion)) {
        await chrome.storage.local.remove('updateAvailable');
        await chrome.action.setBadgeText({ text: '' });
      }
      return;
    }
    await chrome.storage.local.set({
      updateAvailable: {
        version: remoteVersion,
        releasedAt: latest.releasedAt ?? null,
        releaseNotes: latest.releaseNotes ?? null,
        downloadUrl: `${DEFAULT_SERVER}/extension/talentai-v${remoteVersion}.zip`,
        seenAt: Date.now(),
      },
    });
    await chrome.action.setBadgeText({ text: 'NEW' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } catch {
    // Silent — offline / server down is normal.
  }
}

function isNewerVersion(remote, local) {
  const r = String(remote).split('.').map((n) => parseInt(n, 10) || 0);
  const l = String(local).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const ri = r[i] ?? 0;
    const li = l[i] ?? 0;
    if (ri > li) return true;
    if (ri < li) return false;
  }
  return false;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => { ensureConnected(); checkForUpdate(); });
chrome.runtime.onStartup.addListener(() => { ensureConnected(); checkForUpdate(); });
// Also attempt a connection when the worker first wakes up.
ensureConnected();
checkForUpdate();

// Keepalive alarm — MV3 workers get terminated after 30s of inactivity; fire
// at ~24s so we always beat Chrome's idle-kill timer with a healthy margin.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
// Token refresh alarm — checked every 10 minutes; refreshes if within the 3-min window.
chrome.alarms.create('refresh-token', { periodInMinutes: 10 });
// Update check alarm — once an hour. Cheap; matches Chrome's own update cadence.
chrome.alarms.create('check-update', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'keepalive') {
    // Touching a chrome.* API resets the idle-kill timer defensively.
    chrome.storage.local.get(['session'], () => { /* no-op */ });
    // Reconnect if the socket dropped since last tick.
    ensureConnected();
    // Proactive WS ping — surfaces half-open sockets before the server times us out.
    try {
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    } catch (_) { /* ignore — next ensureConnected will rebuild */ }
    return;
  }
  if (a.name === 'refresh-token') {
    const session = await getSession();
    if (!session) return;
    const remainingMs = (session.expiresAt ?? 0) - Date.now();
    if (remainingMs < 3 * 60 * 1000) {
      try { await refreshSession(); } catch (_) { /* next authedFetch will retry */ }
    }
    return;
  }
  if (a.name === 'check-update') {
    await checkForUpdate();
    return;
  }
});
