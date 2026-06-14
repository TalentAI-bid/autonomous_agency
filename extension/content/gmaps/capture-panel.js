// ─── Floating capture panel on Google Maps search results ──────────────────
// Injected by manifest.json content_scripts alongside maps-core.js (which is
// listed first so window.__mapsCore exists). Lets the user select business
// listings from the visible results feed and push them to the CRM as leads
// via the background service worker (kind: 'gmaps_capture').
//
// Google Maps is an SPA — we poll location.pathname every 1s, mount the panel
// only on search results pages, and unmount on place/detail routes. While
// mounted we periodically re-extract the feed so listings the user loads by
// scrolling (or via "Load more") appear in the list, preserving selection.
//
// All scraping goes through the self-contained maps-core module; this file is
// pure UI + messaging glue and is NOT part of the clone-out boundary.

(() => {
  'use strict';

  const PANEL_ID = 'talentai-gmaps-panel';
  const STYLE_ID = 'talentai-gmaps-panel-style';
  const LOG = '[TalentAI gmaps]';

  const core = window.__mapsCore;
  if (!core) {
    console.warn(LOG, 'maps-core not loaded, aborting');
    return;
  }
  if (!core.guardHost()) {
    console.log(LOG, 'non-maps host, aborting', location.hostname);
    return;
  }

  console.log(LOG, 'booted', { url: location.href });

  // ─── State ────────────────────────────────────────────────────────────────

  // mapsUrl → { record, checked, status: null|'saved'|'duplicate'|'error' }
  const listings = new Map();
  let mounted = false;
  let busy = false;

  // ─── Search context ───────────────────────────────────────────────────────

  function getSearchQuery() {
    const m = location.pathname.match(/\/maps\/search\/([^/]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim(); } catch (_) { return ''; }
  }

  // "restaurants in Riyadh" → "Riyadh". Best-effort tag only; '' when the
  // query has no obvious location part.
  function getLocationFromQuery(query) {
    const m = query.match(/\s(?:in|near)\s+(.{2,80})$/i);
    return m ? m[1].trim() : '';
  }

  // ─── Extraction / merge ───────────────────────────────────────────────────

  function refreshListings() {
    const locationCtx = getLocationFromQuery(getSearchQuery());
    const records = core.extractLoaded({ location: locationCtx });
    let added = 0;
    for (const r of records) {
      if (!listings.has(r.mapsUrl)) {
        listings.set(r.mapsUrl, { record: r, checked: true, status: null });
        added++;
      }
    }
    return added;
  }

  // ─── Messaging (resilient to MV3 quirks) ─────────────────────────────────

  function safeSendMessage(msg, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (val) => { if (settled) return; settled = true; resolve(val); };
      try {
        const p = chrome.runtime.sendMessage(msg);
        if (p && typeof p.then === 'function') {
          p.then((res) => settle(res ?? null)).catch((err) => {
            console.warn(LOG, 'sendMessage rejected', msg.kind, err);
            settle(null);
          });
        }
      } catch (err) {
        console.warn(LOG, 'sendMessage threw', msg.kind, err);
        settle(null);
        return;
      }
      setTimeout(() => {
        if (!settled) console.warn(LOG, 'sendMessage timed out', msg.kind);
        settle(null);
      }, timeoutMs);
    });
  }

  // ─── UI ───────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} { position: fixed; top: 72px; right: 16px; z-index: 2147483646;
        width: 320px; background: #fff; border: 1px solid #d6d9de; border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,.18); font-family: Roboto, Arial, sans-serif;
        font-size: 13px; color: #1f2328; display: flex; flex-direction: column; }
      #${PANEL_ID} .tai-gm-head { display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid #eceef1; }
      #${PANEL_ID} .tai-gm-title { font-weight: 600; flex: 1; }
      #${PANEL_ID} .tai-gm-close { cursor: pointer; border: none; background: none;
        font-size: 16px; line-height: 1; color: #5f6368; padding: 2px 4px; }
      #${PANEL_ID} .tai-gm-count { padding: 6px 12px; color: #5f6368; font-size: 12px; }
      #${PANEL_ID} .tai-gm-list { overflow-y: auto; max-height: 320px; padding: 0 6px; }
      #${PANEL_ID} .tai-gm-row { display: flex; align-items: flex-start; gap: 8px;
        padding: 6px; border-radius: 6px; }
      #${PANEL_ID} .tai-gm-row:hover { background: #f6f8fa; }
      #${PANEL_ID} .tai-gm-row input { margin-top: 3px; }
      #${PANEL_ID} .tai-gm-meta { flex: 1; min-width: 0; }
      #${PANEL_ID} .tai-gm-name { font-weight: 500; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; }
      #${PANEL_ID} .tai-gm-sub { color: #5f6368; font-size: 11.5px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #${PANEL_ID} .tai-gm-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 8px;
        align-self: center; flex-shrink: 0; }
      #${PANEL_ID} .tai-gm-badge.saved { background: #e3f5e8; color: #137333; }
      #${PANEL_ID} .tai-gm-badge.duplicate { background: #fef3da; color: #8a5a00; }
      #${PANEL_ID} .tai-gm-badge.error { background: #fde8e8; color: #b3261e; }
      #${PANEL_ID} .tai-gm-actions { display: flex; gap: 6px; padding: 10px 12px;
        border-top: 1px solid #eceef1; }
      #${PANEL_ID} .tai-gm-btn { flex: 1; border: 1px solid #d6d9de; background: #fff;
        border-radius: 6px; padding: 6px 4px; cursor: pointer; font-size: 12px; }
      #${PANEL_ID} .tai-gm-btn:hover:not(:disabled) { background: #f6f8fa; }
      #${PANEL_ID} .tai-gm-btn:disabled { opacity: .5; cursor: default; }
      #${PANEL_ID} .tai-gm-btn.primary { background: #0b57d0; border-color: #0b57d0;
        color: #fff; }
      #${PANEL_ID} .tai-gm-btn.primary:hover:not(:disabled) { background: #0a4cba; }
      #${PANEL_ID} .tai-gm-status { padding: 0 12px 10px; font-size: 12px; color: #5f6368;
        min-height: 16px; }
      #${PANEL_ID} .tai-gm-status.err { color: #b3261e; }
      #${PANEL_ID} .tai-gm-status.ok { color: #137333; }
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const rows = Array.from(listings.values());
    const selected = rows.filter((r) => r.checked).length;
    panel.querySelector('.tai-gm-count').textContent =
      `${rows.length} loaded · ${selected} selected`;

    const list = panel.querySelector('.tai-gm-list');
    list.innerHTML = rows.map(({ record, checked, status }) => {
      const sub = [record.category, record.address].filter(Boolean).join(' · ');
      const badge = status
        ? `<span class="tai-gm-badge ${status}">${status === 'duplicate' ? 'dup' : status}</span>`
        : '';
      return `
        <label class="tai-gm-row" data-url="${escapeHtml(record.mapsUrl)}">
          <input type="checkbox" ${checked ? 'checked' : ''} ${busy ? 'disabled' : ''}>
          <span class="tai-gm-meta">
            <span class="tai-gm-name">${escapeHtml(record.name)}</span>
            <span class="tai-gm-sub">${escapeHtml(sub)}</span>
          </span>
          ${badge}
        </label>`;
    }).join('');

    list.querySelectorAll('.tai-gm-row input').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const url = e.target.closest('.tai-gm-row')?.getAttribute('data-url');
        const entry = url ? listings.get(url) : null;
        if (entry) entry.checked = e.target.checked;
        render();
      });
    });

    panel.querySelectorAll('.tai-gm-btn').forEach((b) => { b.disabled = busy; });
    if (!busy) {
      panel.querySelector('[data-act="selected"]').disabled = selected === 0;
      panel.querySelector('[data-act="all"]').disabled = rows.length === 0;
    }
  }

  function setStatus(text, cls = '') {
    const el = document.getElementById(PANEL_ID)?.querySelector('.tai-gm-status');
    if (!el) return;
    el.className = `tai-gm-status ${cls}`;
    el.textContent = text;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function onLoadMore() {
    busy = true;
    render();
    setStatus('Loading more results…');
    try {
      const { atEnd } = await core.loadMore();
      const added = refreshListings();
      setStatus(atEnd && added === 0 ? 'End of results.' : `${added} new listing(s) loaded.`);
    } catch (err) {
      console.warn(LOG, 'loadMore failed', err);
      setStatus('Could not load more results.', 'err');
    } finally {
      busy = false;
      render();
    }
  }

  async function onCapture(which) {
    const rows = Array.from(listings.values()).filter((r) =>
      which === 'all' ? true : r.checked,
    );
    // Skip rows already saved this session; re-capturing duplicates is noise.
    const toSend = rows.filter((r) => r.status !== 'saved');
    if (toSend.length === 0) {
      setStatus('Nothing new to capture.');
      return;
    }

    busy = true;
    render();
    setStatus(`Capturing ${toSend.length} listing(s)…`);

    const searchQuery = getSearchQuery();
    const res = await safeSendMessage({
      kind: 'gmaps_capture',
      payload: {
        searchQuery: searchQuery || undefined,
        location: getLocationFromQuery(searchQuery) || undefined,
        businesses: toSend.map((r) => r.record),
      },
    });

    busy = false;

    if (!res) {
      setStatus('No response from extension — is it running?', 'err');
      render();
      return;
    }
    if (!res.ok) {
      const msg = /unauth|401/i.test(res.error || '')
        ? 'Please sign in from the extension popup.'
        : (res.error || 'Capture failed.');
      setStatus(msg, 'err');
      render();
      return;
    }

    const results = res.data?.results || [];
    for (const item of results) {
      const entry = (item.mapsUrl && listings.get(item.mapsUrl))
        || Array.from(listings.values()).find((r) => r.record.name === item.name && !r.status);
      if (entry) {
        entry.status = item.status;
        if (item.status === 'saved' || item.status === 'duplicate') entry.checked = false;
      }
    }
    setStatus(`Saved ${res.data?.saved ?? 0} · duplicates ${res.data?.duplicate ?? 0}`, 'ok');
    render();
  }

  // ─── Mount / unmount ──────────────────────────────────────────────────────

  function mount() {
    if (mounted || document.getElementById(PANEL_ID)) { mounted = true; return; }
    injectStyles();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="tai-gm-head">
        <span class="tai-gm-title">TalentAI — Capture leads</span>
        <button class="tai-gm-close" title="Hide">×</button>
      </div>
      <div class="tai-gm-count">0 loaded · 0 selected</div>
      <div class="tai-gm-list"></div>
      <div class="tai-gm-status"></div>
      <div class="tai-gm-actions">
        <button class="tai-gm-btn" data-act="more">Load more</button>
        <button class="tai-gm-btn" data-act="selected">Capture selected</button>
        <button class="tai-gm-btn primary" data-act="all">Capture all</button>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector('.tai-gm-close').addEventListener('click', unmount);
    panel.querySelector('[data-act="more"]').addEventListener('click', onLoadMore);
    panel.querySelector('[data-act="selected"]').addEventListener('click', () => onCapture('selected'));
    panel.querySelector('[data-act="all"]').addEventListener('click', () => onCapture('all'));

    mounted = true;
    refreshListings();
    render();
    console.log(LOG, 'panel mounted', { listings: listings.size });
  }

  function unmount() {
    document.getElementById(PANEL_ID)?.remove();
    mounted = false;
    console.log(LOG, 'panel unmounted');
  }

  // ─── SPA route watcher ────────────────────────────────────────────────────

  let lastPath = '';
  let lastQuery = '';
  let tick = 0;
  setInterval(() => {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      if (core.isMapsSearchPage()) {
        // New search query → listings from the previous query are stale.
        const query = getSearchQuery();
        if (query !== lastQuery) {
          lastQuery = query;
          listings.clear();
        }
        mount();
        refreshListings();
        render();
      } else if (mounted) {
        unmount();
      }
      return;
    }
    // Same route: pick up listings the user loaded by scrolling the feed
    // themselves (every ~3s, cheap DOM read).
    if (mounted && !busy && ++tick % 3 === 0) {
      if (refreshListings() > 0) render();
    }
  }, 1000);
})();
