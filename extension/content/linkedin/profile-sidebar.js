// ─── Floating "Add to CRM" widget on LinkedIn /in/<handle>/ pages ─────────
// Snov.io-style widget injected by manifest.json content_scripts. Lets the
// user manually add the currently-viewed profile as a contact in the CRM,
// even if the auto-crawler missed them. Posts to /api/extension/contacts/manual
// via the background service worker (which holds the JWT).
//
// LinkedIn is an SPA — pushState navigation does NOT trigger document_idle
// again. We poll location.pathname every 1s and re-render the widget on
// route changes, hiding it whenever the URL stops matching /in/<handle>.
//
// Every code path logs to the console so the widget never fails silently.
// Search the page console for "[TalentAI sidebar]" to trace what happened.

(() => {
  'use strict';

  const PATH_RE = /^\/in\/[^/]+\/?$/;
  const WIDGET_ID = 'talentai-profile-sidebar';
  const STYLE_ID = 'talentai-profile-sidebar-style';
  const SESSION_DISMISS_KEY = 'talentai_widget_dismissed';
  const LOG = '[TalentAI sidebar]';

  console.log(LOG, 'booted', { url: location.href, pathname: location.pathname });

  // ─── DOM helpers ─────────────────────────────────────────────────────────

  // ─── Reused helpers from fetch-company.js ────────────────────────────
  // Content scripts injected via manifest can't share globals across files,
  // so we inline the helpers verbatim. Keep these in sync if fetch-company
  // gets fixed. Source: extension/content/linkedin/fetch-company.js.

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

  function isValidName(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 150) return false;
    if (/^Status\s+is/i.test(t)) return false;
    if (t === 'LinkedIn Member') return false;
    if (/^View\s+.*profile/i.test(t)) return false;
    if (/View\s+.+?(?:[’'‘`]s\s+profile|\s+profile)/i.test(t)) return false;
    if (/View\b/i.test(t)) return false;
    if (/\bprofile\b/i.test(t)) return false;
    if (/%[0-9A-Fa-f]{2}/.test(t)) return false;
    return true;
  }

  function decodeSlugToName(slug) {
    let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
    try { cleaned = decodeURIComponent(cleaned); } catch (_) {}
    const name = cleaned
      .split('-')
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(' ');
    return name || null;
  }

  // Adapted from fetch-company.js::extractPersonName, but scoped to a
  // single /in/ profile page (no "card" element — the whole page is the
  // profile). Priority chain:
  //   1. H1 aria-label
  //   2. H1 textContent, cleaned
  //   3. visually-hidden span aria-label / textContent inside main
  //   4. URL slug → "Jithin Joy"
  //   5. <title> tag → "<Name> | LinkedIn"
  function extractProfileName() {
    const main = document.querySelector('main') || document.body;

    // 1. H1 aria-label
    const h1s = main.querySelectorAll('h1');
    for (const h1 of h1s) {
      const aria = h1.getAttribute && h1.getAttribute('aria-label');
      if (aria) {
        const cleaned = cleanLinkedInA11yText(aria);
        if (isValidName(cleaned)) {
          console.log(LOG, 'extractProfileName: matched H1 aria-label', cleaned);
          return cleaned;
        }
      }
    }

    // 2. H1 textContent (most common path on a working profile)
    for (const h1 of h1s) {
      let raw = (h1.innerText || h1.textContent || '').trim().replace(/\s+/g, ' ');
      raw = raw.replace(/\s*•\s*(?:1st|2nd|3rd)(?:\+)?\s*/g, ' ').trim();
      const cleaned = cleanLinkedInA11yText(raw);
      if (isValidName(cleaned)) {
        console.log(LOG, 'extractProfileName: matched H1 textContent', cleaned);
        return cleaned;
      }
    }

    // 3. Hidden a11y spans inside main
    const hiddenSpans = main.querySelectorAll(
      '.visually-hidden, .a11y-text, [class*="sr-only"], span[aria-label]',
    );
    for (const span of hiddenSpans) {
      const aria = span.getAttribute && span.getAttribute('aria-label');
      if (aria) {
        const cleaned = cleanLinkedInA11yText(aria);
        if (isValidName(cleaned)) {
          console.log(LOG, 'extractProfileName: matched hidden span aria-label', cleaned);
          return cleaned;
        }
      }
      const text = (span.textContent || '').trim();
      const cleaned = cleanLinkedInA11yText(text);
      if (isValidName(cleaned)) {
        console.log(LOG, 'extractProfileName: matched hidden span text', cleaned);
        return cleaned;
      }
    }

    // 4. URL slug fallback — works even when LinkedIn hasn't hydrated yet
    const slugMatch = location.pathname.match(/\/in\/([^/?#]+)/);
    if (slugMatch && slugMatch[1]) {
      const decoded = decodeSlugToName(slugMatch[1]);
      if (isValidName(decoded)) {
        console.log(LOG, 'extractProfileName: matched URL slug', decoded);
        return decoded;
      }
    }

    // 5. <title> fallback — "<Name> | LinkedIn" or "(NN) <Name> | LinkedIn"
    const titleStr = (document.title || '').trim();
    const tm = titleStr.match(/^(?:\(\d+\)\s+)?(.+?)\s*[|·-]\s*LinkedIn/i);
    if (tm && tm[1]) {
      const cleaned = cleanLinkedInA11yText(tm[1].trim());
      if (isValidName(cleaned)) {
        console.log(LOG, 'extractProfileName: matched <title>', cleaned);
        return cleaned;
      }
    }

    console.warn(LOG, 'extractProfileName: no match via any selector / title / slug');
    return '';
  }

  // ─── Headline / title / company extraction ───────────────────────────
  // LinkedIn renames classes constantly, so each helper runs a multi-
  // selector cascade and logs which selector hit. When the next class
  // rename breaks something, the user pastes the console output and we
  // know exactly which step needs a new selector.

  function readHeadline() {
    const main = document.querySelector('main') || document.body;
    const selectors = [
      '.pv-text-details__left-panel .text-body-medium',
      '.ph5 .text-body-medium.break-words',
      '.pv-top-card .text-body-medium',
      '.text-body-medium.break-words',
      '[data-test-id="profile-headline"]',
      'main .text-body-medium',
    ];
    for (const sel of selectors) {
      const candidates = main.querySelectorAll(sel);
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length < 3) continue;
        // Reject LinkedIn-wide nav elements that match similar classes.
        if (/^Status\s+is/i.test(text)) continue;
        if (/^(Home|My Network|Jobs|Messaging|Notifications|Me)$/i.test(text)) continue;
        // Reject location strings (typically "City, Region, Country").
        if (/^[\w\s.-]+,\s*[\w\s.-]+(?:,\s*[\w\s.-]+)?$/.test(text) && text.length < 60) continue;
        console.log(LOG, 'readHeadline: matched', { selector: sel, text });
        return text;
      }
    }
    console.warn(LOG, 'readHeadline: no headline found');
    return '';
  }

  function extractCurrentCompany() {
    const main = document.querySelector('main') || document.body;

    // Priority 1: top-card current-employer link/button.
    const topCardSelectors = [
      'a[aria-label^="Current company"]',
      'button[aria-label^="Current company"]',
      '[data-section="topCard"] a[href*="/company/"]',
      '.pv-text-details__right-panel a[href*="/company/"]',
      '.pv-text-details__right-panel-item a[href*="/company/"]',
      '.ph5 a[href*="/company/"]',
      '.pv-top-card a[href*="/company/"]',
      '.pv-top-card--list a[href*="/company/"]',
    ];
    for (const sel of topCardSelectors) {
      const el = main.querySelector(sel);
      if (!el) continue;
      const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
      if (aria) {
        const ariaMatch = aria.match(/Current company:\s*(.+?)(?:\s+\(.+?\))?$/i);
        if (ariaMatch && ariaMatch[1]) {
          const name = ariaMatch[1].trim();
          console.log(LOG, 'extractCurrentCompany: matched topcard aria', { selector: sel, name });
          return { name, source: 'topcard-aria' };
        }
      }
      const text = cleanLinkedInA11yText((el.innerText || el.textContent || '').trim());
      if (text && text.length >= 2 && text.length <= 100) {
        console.log(LOG, 'extractCurrentCompany: matched topcard text', { selector: sel, text });
        return { name: text, source: 'topcard-text' };
      }
    }

    // Priority 2: experience section's first entry company.
    const headers = document.querySelectorAll('section h2, section h3');
    let expSection = document.getElementById('experience');
    if (!expSection) {
      expSection = document.querySelector('section[data-section="experience"]');
    }
    if (!expSection) {
      for (const h of headers) {
        if (/experience/i.test(h.textContent || '')) {
          expSection = h.closest('section');
          if (expSection) break;
        }
      }
    }
    if (expSection) {
      const firstCompanyLink = expSection.querySelector('a[href*="/company/"]');
      if (firstCompanyLink) {
        const text = cleanLinkedInA11yText(
          (firstCompanyLink.innerText || firstCompanyLink.textContent || '').trim(),
        );
        if (text) {
          const name = text.split('·')[0].trim();
          if (name.length >= 2 && name.length <= 100) {
            console.log(LOG, 'extractCurrentCompany: matched experience link', name);
            return { name, source: 'experience-link' };
          }
        }
      }
      // Fallback: first <li> spans, looking for "Acme · Full-time" pattern.
      const firstItem = expSection.querySelector('li');
      if (firstItem) {
        const spans = firstItem.querySelectorAll('span[aria-hidden="true"], span.t-14');
        for (const s of spans) {
          const t = (s.innerText || s.textContent || '').trim();
          if (t && /·/.test(t)) {
            const name = t.split('·')[0].trim();
            if (name.length >= 2 && name.length <= 100 && !/year|month|present/i.test(name)) {
              console.log(LOG, 'extractCurrentCompany: matched experience span', name);
              return { name, source: 'experience-span' };
            }
          }
        }
      }
    }

    // Priority 3: headline "Title at Company" parsing.
    const headline = readHeadline();
    const m = headline.match(/^(.+?)\s+(?:at|@|chez|bei|en)\s+(.+)$/i);
    if (m && m[2]) {
      const name = m[2].trim().split('·')[0].trim();
      if (name.length >= 2 && name.length <= 100) {
        console.log(LOG, 'extractCurrentCompany: matched headline parse', name);
        return { name, source: 'headline' };
      }
    }

    console.warn(LOG, 'extractCurrentCompany: no company found');
    return { name: '', source: 'none' };
  }

  function extractTitle(headline) {
    if (!headline) return '';
    // If headline matches "Title at Company", strip the company off.
    const m = headline.match(/^(.+?)\s+(?:at|@|chez|bei|en)\s+(.+)$/i);
    if (m) return m[1].trim();
    // Otherwise the whole headline is the title (free-text positioning).
    return headline.trim();
  }

  function scrapeProfile() {
    const name = extractProfileName();
    const headline = readHeadline();
    const company = extractCurrentCompany();
    const title = extractTitle(headline);
    const linkedinUrl = location.href.split('?')[0].split('#')[0];
    const result = { name, title, companyName: company.name, linkedinUrl };
    console.log(LOG, 'scrapeProfile result', {
      ...result,
      companySource: company.source,
      headline,
    });
    return result;
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
  }

  // Wait for the profile name to be readable. We accept the H1 having text
  // (the normal case), OR our extractProfileName fallback chain returning
  // anything valid (slug / title work even before hydration). Uses a
  // MutationObserver with a 6s upper-bound — past that, rendering with
  // the slug-derived name is still better than waiting forever.
  async function waitForProfileReady(maxMs = 6000) {
    const ok = () => {
      const h1 = document.querySelector('main h1') || document.querySelector('h1');
      const h1Text = h1 ? (h1.innerText || h1.textContent || '').trim() : '';
      if (h1Text.length > 0) return true;
      // Slug fallback: as long as the URL is a /in/<handle>/, extractProfileName
      // can derive a name immediately — no need to wait for LinkedIn.
      return !!extractProfileName();
    };
    if (ok()) return true;
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(t);
        resolve(val);
      };
      const observer = new MutationObserver(() => { if (ok()) finish(true); });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      const t = setTimeout(() => finish(ok()), maxMs);
    });
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
      #${WIDGET_ID} .tai-hint {
        margin-bottom: 10px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 11px;
        background: #fff8c5;
        color: #7a4c00;
        border: 1px solid #f5e8a2;
        line-height: 1.45;
      }
      #${WIDGET_ID} .tai-banner {
        margin-bottom: 10px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 11px;
        background: #fff8c5;
        color: #7a4c00;
        border: 1px solid #f5e8a2;
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
      #${WIDGET_ID} .tai-skeleton {
        color: #8d96a0;
        font-style: italic;
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

  function buildWidget(state) {
    const { profile, agents, signedIn, dashboardUrl, loadError } = state;
    const wrap = document.createElement('div');
    wrap.id = WIDGET_ID;

    const agentOpts = agents.length
      ? agents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')
      : '<option value="">No agents — create one in dashboard</option>';

    const banner = !signedIn
      ? `<div class="tai-banner">Sign in via the extension popup to enable saving.</div>`
      : loadError
        ? `<div class="tai-banner">Couldn't load agents: ${escapeHtml(loadError)}</div>`
        : '';

    const nameDisplay = profile.name
      ? escapeHtml(profile.name)
      : '<span class="tai-skeleton">Loading profile…</span>';
    const headlineParts = [profile.title, profile.companyName].filter(Boolean);
    const headlineDisplay = headlineParts.length
      ? escapeHtml(headlineParts.join(' · '))
      : '<span class="tai-skeleton">—</span>';

    // Surface what's missing so the user knows BEFORE saving.
    const hints = [];
    if (!profile.title) hints.push('No role detected — will save without a title.');
    if (!profile.companyName) hints.push('No company detected — won\'t be linked to a company.');
    const hintsHtml = hints.length
      ? `<div class="tai-hint">${hints.map(escapeHtml).join('<br/>')}</div>`
      : '';

    const canSubmit = signedIn && agents.length > 0;

    wrap.innerHTML = `
      <div class="tai-header">
        <strong>TalentAI · Add to CRM</strong>
        <button type="button" class="tai-close" aria-label="Dismiss">×</button>
      </div>
      <div class="tai-body">
        ${banner}
        <div class="tai-row">
          <div class="tai-avatar">${escapeHtml(initials(profile.name))}</div>
          <div style="min-width:0;flex:1">
            <div class="tai-name">${nameDisplay}</div>
            <div class="tai-headline">${headlineDisplay}</div>
          </div>
        </div>
        ${hintsHtml}
        <div class="tai-label">Save to agent</div>
        <select class="tai-agent">${agentOpts}</select>
        <button type="button" class="tai-primary" ${canSubmit ? '' : 'disabled'}>+ Add to CRM</button>
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
      mounted = false;
      console.log(LOG, 'dismissed by user');
    });

    submit.addEventListener('click', async () => {
      const masterAgentId = select.value;
      if (!masterAgentId) return;
      submit.disabled = true;
      submit.textContent = 'Saving…';
      resultBox.className = 'tai-result';
      resultBox.textContent = '';

      try {
        const fresh = scrapeProfile();
        const payload = { ...fresh, masterAgentId };
        if (!payload.name) throw new Error('Could not read name from profile');
        console.log(LOG, 'saving', payload);
        const res = await chrome.runtime.sendMessage({ kind: 'manual_add_profile', payload });
        if (!res || !res.ok) throw new Error(res?.error || 'Save failed');

        const dashboardLink = dashboardUrl
          ? `<a href="${dashboardUrl}/contacts/${res.contactId}" target="_blank">View in dashboard ↗</a>`
          : '';
        const dedupNote = res.dedup ? ' (already existed — reused)' : '';
        const roleLine = `Role: ${escapeHtml(payload.title || '—')}`;
        const companyLine = `Company: ${escapeHtml(payload.companyName || 'not detected')}`;
        resultBox.className = 'tai-result tai-ok';
        resultBox.innerHTML = `✓ Saved to CRM${dedupNote} as <strong>${escapeHtml(payload.name)}</strong>.<br/>${roleLine}<br/>${companyLine}<br/>${dashboardLink}`;
        submit.textContent = '✓ Saved';
        console.log(LOG, 'saved', res);
      } catch (err) {
        console.warn(LOG, 'save failed', err);
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

  // ─── Background-message helpers (resilient to MV3 quirks) ───────────────

  function safeSendMessage(msg, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (val) => { if (settled) return; settled = true; resolve(val); };
      try {
        const p = chrome.runtime.sendMessage(msg);
        // Newer Chromes return a Promise; older ones use a callback.
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

  // ─── Mount / unmount ─────────────────────────────────────────────────────

  let mounted = false;
  let mounting = false;

  async function mount() {
    if (mounted || mounting) {
      console.log(LOG, 'mount: already mounted/mounting, skip');
      return;
    }
    if (!PATH_RE.test(location.pathname)) {
      console.log(LOG, 'mount: path does not match /in/<handle>/, skip', location.pathname);
      return;
    }

    let dismissed = '';
    try { dismissed = sessionStorage.getItem(SESSION_DISMISS_KEY) || ''; } catch (_) {}
    if (dismissed === '1') {
      console.log(LOG, 'mount: user dismissed for this session, skip');
      return;
    }

    if (document.getElementById(WIDGET_ID)) {
      console.log(LOG, 'mount: widget element already in DOM, skip');
      mounted = true;
      return;
    }

    mounting = true;
    console.log(LOG, 'mount: path matches, waiting for profile to be readable');

    const profileReady = await waitForProfileReady(6000);
    console.log(LOG, 'mount: profile-ready wait done', { profileReady });

    const profile = scrapeProfile();
    console.log(LOG, 'mount: scraped profile', profile);

    // Always render the widget — even if scrape returned nothing.
    // The submit handler re-scrapes on click, so late hydration still works.

    let agents = [];
    let signedIn = false;
    let dashboardUrl = '';
    let loadError = '';

    const stateResp = await safeSendMessage({ kind: 'popup_get_state' });
    console.log(LOG, 'mount: popup_get_state', stateResp);
    signedIn = !!(stateResp && stateResp.signedIn);
    if (stateResp?.serverUrl) dashboardUrl = deriveDashboardUrl(stateResp.serverUrl);

    if (signedIn) {
      const agentsResp = await safeSendMessage({ kind: 'list_master_agents' });
      console.log(LOG, 'mount: list_master_agents', agentsResp);
      if (agentsResp?.ok) {
        agents = Array.isArray(agentsResp.agents) ? agentsResp.agents : [];
      } else if (agentsResp && !agentsResp.ok) {
        loadError = agentsResp.error || 'Unknown error';
      } else {
        loadError = 'No response from background';
      }
    }

    injectStyles();
    const widget = buildWidget({ profile, agents, signedIn, dashboardUrl, loadError });
    (document.body || document.documentElement).appendChild(widget);
    mounted = true;
    mounting = false;
    console.log(LOG, 'widget mounted', { signedIn, agentCount: agents.length, hasName: !!profile.name });
  }

  function unmount() {
    const w = document.getElementById(WIDGET_ID);
    if (w) w.remove();
    mounted = false;
    mounting = false;
  }

  function deriveDashboardUrl(apiBase) {
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
    console.log(LOG, 'path changed to', here);
    if (PATH_RE.test(here)) {
      try { sessionStorage.removeItem(SESSION_DISMISS_KEY); } catch (_) {}
      unmount();
      mount();
    } else {
      unmount();
    }
  }

  mount();
  lastPath = location.pathname;
  setInterval(pollPath, 1000);
})();
