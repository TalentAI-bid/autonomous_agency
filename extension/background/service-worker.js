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
} from '../lib/auth-client.js';

const DEFAULT_SERVER = 'http://localhost:3000';
const rateLimiter = new RateLimiter();
let ws = null;
let paused = false;
let currentTask = null;
let currentMasterAgentName = null;
let currentStatus = 'idle';

// ─── Adapter registry (files injected for each {site, type}) ───────────────
const ADAPTER_FILES = {
  'linkedin:search_companies': ['lib/scraper-utils.js', 'content/linkedin/search-companies.js'],
  'linkedin:fetch_company':    ['lib/scraper-utils.js', 'content/linkedin/fetch-company.js'],
  'gmaps:search_businesses':   ['lib/scraper-utils.js', 'content/gmaps/search-businesses.js'],
  'gmaps:fetch_business':      ['lib/scraper-utils.js', 'content/gmaps/fetch-business.js'],
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
  });
  ws.connect();
}

function setStatus(status) {
  currentStatus = status;
  chrome.storage.local.set({ connectionStatus: status }).catch(() => {});
  try {
    chrome.runtime.sendMessage({ kind: 'status', status }).catch(() => {});
  } catch (_) { /* no listeners yet */ }
}

async function handleMessage(msg) {
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
    await processTask(msg);
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
}

async function processTask(msg) {
  const { taskId, site, taskType, params, masterAgentName } = msg;
  const adapterKey = `${site}:${taskType}`;
  const files = ADAPTER_FILES[adapterKey];

  if (!files) {
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: `no_adapter_for:${adapterKey}` });
    return;
  }
  if (paused) {
    ws?.send({ type: 'task_result', taskId, status: 'failed', error: 'extension_paused' });
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
  try {
    const target = buildUrl(site, taskType, params);
    tab = await openOrFocusTab(target, site);

    // Stash params for the injected adapter (via chrome.storage.session if available)
    const storageKey = `task_${taskId}`;
    await chrome.storage.session?.set({ [storageKey]: { taskId, params } }).catch(() => {});

    // Inject scraper utils + the adapter; adapter returns its result to us via message passing.
    const resultMsg = await new Promise(async (resolve) => {
      const listener = (m, _sender, _sendResponse) => {
        if (m && m.kind === 'scrape_result' && m.taskId === taskId) {
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

    await rateLimiter.record(site, taskType);

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
    currentTask = null;
    currentMasterAgentName = null;
    broadcast('current_task', null);
  }
}

function buildUrl(site, type, params) {
  if (site === 'linkedin' && type === 'search_companies') {
    const kw = encodeURIComponent([params.role, params.industry].filter(Boolean).join(' '));
    const geo = params.location ? `&companyHqGeo=${encodeURIComponent(params.location)}` : '';
    return `https://www.linkedin.com/search/results/companies/?keywords=${kw}${geo}`;
  }
  if (site === 'linkedin' && type === 'fetch_company') {
    return params.linkedinUrl;
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
      await chrome.tabs.update(tab.id, { url, active: false });
      await waitForTabComplete(tab.id);
      return tab;
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(tab.id);
  return tab;
}

function waitForTabComplete(tabId, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
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
        const result = await signIn({
          serverUrl: msg.serverUrl || DEFAULT_SERVER,
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
  })();
  return true; // async sendResponse
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => { ensureConnected(); });
chrome.runtime.onStartup.addListener(() => { ensureConnected(); });
// Also attempt a connection when the worker first wakes up.
ensureConnected();

// Keepalive alarm — MV3 workers get terminated after 30s of inactivity; this
// ping wakes us periodically so the WS stays up.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
// Token refresh alarm — checked every 10 minutes; refreshes if within the 3-min window.
chrome.alarms.create('refresh-token', { periodInMinutes: 10 });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'keepalive') {
    ensureConnected();
    return;
  }
  if (a.name === 'refresh-token') {
    const session = await getSession();
    if (!session) return;
    const remainingMs = (session.expiresAt ?? 0) - Date.now();
    if (remainingMs < 3 * 60 * 1000) {
      try { await refreshSession(); } catch (_) { /* next authedFetch will retry */ }
    }
  }
});
