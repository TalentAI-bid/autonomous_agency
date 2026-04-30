// ─── Floating "Add to CRM" widget on LinkedIn /in/<handle>/ pages ─────────
// Snov.io-style widget injected by manifest.json content_scripts. Lets the
// user manually add the currently-viewed profile as a contact in the CRM,
// even if the auto-crawler missed them. Posts to /api/extension/contacts/manual
// via the background service worker (which holds the JWT).
//
// LinkedIn is an SPA — pushState navigation does NOT trigger document_idle
// again. We poll location.pathname every 1s and re-render the widget on
// route changes, hiding it whenever the URL stops matching /in/<handle>.

(() => {
  'use strict';

  const PATH_RE = /^\/in\/[^/]+\/?$/;
  const WIDGET_ID = 'talentai-profile-sidebar';
  const STYLE_ID = 'talentai-profile-sidebar-style';
  const SESSION_DISMISS_KEY = 'talentai_widget_dismissed';

  // ─── DOM helpers ─────────────────────────────────────────────────────────

  // Inlined copy of the cleaner used by fetch-company.js. Content scripts
  // injected via manifest can't share globals across files, so duplicating
  // the ~10 lines is cheaper than wiring scraper-utils into the manifest.
  function cleanLinkedInA11yText(text) {
    if (!text) return text;
    let t = String(text).trim();
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    return t;
  }

  function scrapeProfile() {
    const h1 = document.querySelector('h1');
    const rawName = h1 ? (h1.innerText || h1.textContent || '').trim() : '';
    const name = cleanLinkedInA11yText(rawName);

    // Headline often lives in `.text-body-medium.break-words` near the H1.
    let headline = '';
    const headlineEl = document.querySelector('.text-body-medium.break-words');
    if (headlineEl) headline = (headlineEl.innerText || '').trim();

    // Best-effort split "Title at Company" / "Title @ Company"
    let title = headline;
    let companyName = '';
    const m = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (m) {
      title = m[1].trim();
      companyName = m[2].trim();
    }

    // Fallback: first /company/ anchor in the page (usually the current role)
    if (!companyName) {
      const aCompany = document.querySelector('section a[href*="/company/"]');
      if (aCompany) companyName = (aCompany.innerText || '').trim();
    }

    const linkedinUrl = location.href.split('?')[0].split('#')[0];

    return { name, title, companyName, linkedinUrl };
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${WIDGET_ID} {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 300px;
        background: #ffffff;
        color: #1f2328;
        border: 1px solid #d0d7de;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        z-index: 999999;
        overflow: hidden;
      }
      #${WIDGET_ID} .tai-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #eaeef2;
        background: linear-gradient(135deg,#0a66c2 0%,#0a55a3 100%);
        color: #fff;
      }
      #${WIDGET_ID} .tai-header strong {
        flex: 1;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      #${WIDGET_ID} .tai-close {
        background: transparent;
        border: 0;
        color: rgba(255,255,255,0.85);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0 4px;
      }
      #${WIDGET_ID} .tai-close:hover { color: #fff; }
      #${WIDGET_ID} .tai-body {
        padding: 12px;
      }
      #${WIDGET_ID} .tai-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
      }
      #${WIDGET_ID} .tai-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: #0a66c2;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 13px;
        flex-shrink: 0;
      }
      #${WIDGET_ID} .tai-name {
        font-weight: 600;
        font-size: 13px;
        color: #1f2328;
        margin: 0 0 2px 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${WIDGET_ID} .tai-headline {
        font-size: 11px;
        color: #57606a;
        margin: 0;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      #${WIDGET_ID} .tai-label {
        font-size: 10px;
        font-weight: 600;
        color: #57606a;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        margin-bottom: 4px;
      }
      #${WIDGET_ID} select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        background: #fff;
        font-size: 12px;
        color: #1f2328;
        font-family: inherit;
        margin-bottom: 10px;
      }
      #${WIDGET_ID} button.tai-primary {
        width: 100%;
        padding: 8px 12px;
        border: 0;
        background: #0a66c2;
        color: #fff;
        font-weight: 600;
        font-size: 12px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
      }
      #${WIDGET_ID} button.tai-primary:hover { background: #0a55a3; }
      #${WIDGET_ID} button.tai-primary:disabled {
        background: #8c959f;
        cursor: not-allowed;
      }
      #${WIDGET_ID} .tai-result {
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 12px;
        display: none;
      }
      #${WIDGET_ID} .tai-result.tai-ok {
        background: #dafbe1;
        color: #1a7f37;
        border: 1px solid #aceebb;
        display: block;
      }
      #${WIDGET_ID} .tai-result.tai-err {
        background: #ffebe9;
        color: #cf222e;
        border: 1px solid #ffcecb;
        display: block;
      }
      #${WIDGET_ID} .tai-result a {
        color: inherit;
        text-decoration: underline;
        font-weight: 600;
      }
      @media (prefers-color-scheme: dark) {
        #${WIDGET_ID} {
          background: #1c1f24;
          color: #e6edf3;
          border-color: #30363d;
        }
        #${WIDGET_ID} .tai-name { color: #e6edf3; }
        #${WIDGET_ID} .tai-headline { color: #8d96a0; }
        #${WIDGET_ID} .tai-label { color: #8d96a0; }
        #${WIDGET_ID} select {
          background: #0d1117;
          color: #e6edf3;
          border-color: #30363d;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  // ─── Widget render ───────────────────────────────────────────────────────

  function buildWidget(profile, agents, dashboardUrl) {
    const wrap = document.createElement('div');
    wrap.id = WIDGET_ID;
    const agentOpts = agents.length
      ? agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')
      : '<option value="">No agents — create one in dashboard</option>';

    wrap.innerHTML = `
      <div class="tai-header">
        <strong>TalentAI · Add to CRM</strong>
        <button type="button" class="tai-close" aria-label="Dismiss">×</button>
      </div>
      <div class="tai-body">
        <div class="tai-row">
          <div class="tai-avatar">${escapeHtml(initials(profile.name))}</div>
          <div style="min-width:0;flex:1">
            <div class="tai-name">${escapeHtml(profile.name || 'Unknown')}</div>
            <div class="tai-headline">${escapeHtml([profile.title, profile.companyName].filter(Boolean).join(' · '))}</div>
          </div>
        </div>
        <div class="tai-label">Save to agent</div>
        <select class="tai-agent">${agentOpts}</select>
        <button type="button" class="tai-primary" ${agents.length ? '' : 'disabled'}>+ Add to CRM</button>
        <div class="tai-result"></div>
      </div>
    `;

    const closeBtn = wrap.querySelector('.tai-close');
    const select = wrap.querySelector('select.tai-agent');
    const submit = wrap.querySelector('button.tai-primary');
    const resultBox = wrap.querySelector('.tai-result');

    closeBtn.addEventListener('click', () => {
      try { sessionStorage.setItem(SESSION_DISMISS_KEY, '1'); } catch (_) {}
      wrap.remove();
    });

    submit.addEventListener('click', async () => {
      const masterAgentId = select.value;
      if (!masterAgentId) return;
      submit.disabled = true;
      submit.textContent = 'Saving…';
      resultBox.className = 'tai-result';
      resultBox.textContent = '';

      try {
        const fresh = scrapeProfile(); // re-scrape in case the SPA updated
        const payload = { ...fresh, masterAgentId };
        if (!payload.name) throw new Error('Could not read name from profile');
        const res = await chrome.runtime.sendMessage({ kind: 'manual_add_profile', payload });
        if (!res || !res.ok) throw new Error(res?.error || 'Save failed');

        const dashboardLink = dashboardUrl
          ? `<a href="${dashboardUrl}/contacts/${res.contactId}" target="_blank">View in dashboard ↗</a>`
          : '';
        const dedupNote = res.dedup ? ' (already existed — reused)' : '';
        resultBox.className = 'tai-result tai-ok';
        resultBox.innerHTML = `✓ Saved to CRM${dedupNote}.<br/>${dashboardLink}`;
        submit.textContent = '✓ Saved';
      } catch (err) {
        resultBox.className = 'tai-result tai-err';
        resultBox.textContent = err.message || 'Save failed';
        submit.disabled = false;
        submit.textContent = '+ Add to CRM';
      }
    });

    return wrap;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Mount / unmount ─────────────────────────────────────────────────────

  let mounted = false;

  async function mount() {
    if (mounted) return;
    if (!PATH_RE.test(location.pathname)) return;

    let dismissed = '';
    try { dismissed = sessionStorage.getItem(SESSION_DISMISS_KEY) || ''; } catch (_) {}
    if (dismissed === '1') return;

    if (document.getElementById(WIDGET_ID)) return;

    // Wait briefly for LinkedIn to populate the H1 (SPA hydration).
    let attempts = 0;
    while (attempts < 10 && !document.querySelector('h1')) {
      await new Promise((r) => setTimeout(r, 300));
      attempts++;
    }

    const profile = scrapeProfile();
    if (!profile.name) return; // nothing to save

    let agents = [];
    let dashboardUrl = '';
    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'list_master_agents' });
      if (resp?.ok) agents = resp.agents || [];
      // Pull the dashboard origin from the API base if exposed in storage.
      const { session } = await chrome.storage.local.get('session');
      const apiBase = session?.serverUrl || '';
      // Convention: dashboard lives at the same origin's UI host.
      dashboardUrl = apiBase ? deriveDashboardUrl(apiBase) : '';
    } catch (_) {
      // Not signed in or background unavailable — don't render.
      return;
    }

    injectStyles();
    const widget = buildWidget(profile, agents, dashboardUrl);
    document.body.appendChild(widget);
    mounted = true;
  }

  function unmount() {
    const w = document.getElementById(WIDGET_ID);
    if (w) w.remove();
    mounted = false;
  }

  function deriveDashboardUrl(apiBase) {
    // api.talentailabs.com → app.talentailabs.com  (best-effort heuristic)
    try {
      const u = new URL(apiBase);
      if (u.hostname.startsWith('api.')) {
        u.hostname = 'app.' + u.hostname.slice(4);
        return `${u.protocol}//${u.host}`;
      }
      if (u.hostname.startsWith('agents.api.')) {
        return `${u.protocol}//app.${u.hostname.slice('agents.api.'.length)}`;
      }
    } catch (_) {}
    return '';
  }

  // ─── SPA navigation polling ─────────────────────────────────────────────

  let lastPath = '';
  function pollPath() {
    const here = location.pathname;
    if (here === lastPath) return;
    lastPath = here;
    if (PATH_RE.test(here)) {
      // Re-mount — strip the dismissed flag for a NEW profile URL
      try { sessionStorage.removeItem(SESSION_DISMISS_KEY); } catch (_) {}
      unmount();
      mount();
    } else {
      unmount();
    }
  }

  // Initial mount + polling
  mount();
  lastPath = location.pathname;
  setInterval(pollPath, 1000);
})();
