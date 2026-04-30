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
  // single /in/ profile page. Priority chain handles both the old layout
  // (H1 with name) and the 2026 layout (H2 with name, hashed CSS classes).
  function extractProfileName() {
    const main = document.querySelector('main') || document.body;

    // 1. H1 / H2 aria-label or textContent. LinkedIn's new layout uses H2
    //    for the profile name — old layout used H1. Try both.
    for (const tag of ['h1', 'h2']) {
      const headings = main.querySelectorAll(tag);
      for (const h of headings) {
        const aria = h.getAttribute && h.getAttribute('aria-label');
        if (aria) {
          const cleaned = cleanLinkedInA11yText(aria);
          if (isValidName(cleaned)) {
            console.log(LOG, `extractProfileName: matched ${tag} aria-label`, cleaned);
            return cleaned;
          }
        }
        let raw = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ');
        raw = raw.replace(/\s*•\s*(?:1st|2nd|3rd)(?:\+)?\s*/g, ' ').trim();
        const cleaned = cleanLinkedInA11yText(raw);
        if (isValidName(cleaned)) {
          console.log(LOG, `extractProfileName: matched ${tag} textContent`, cleaned);
          return cleaned;
        }
      }
    }

    // 2. "View NAME's verifications" / "View NAME's profile" aria-label on
    //    nearby SVG icons. Often only the FIRST name. Combine with slug.
    const verifIcon = main.querySelector(
      'svg[aria-label*="verifications"], svg[aria-label*="profile"], a[aria-label*="profile"]',
    );
    if (verifIcon) {
      const aria = verifIcon.getAttribute('aria-label') || '';
      const m = aria.match(/View\s+(.+?)(?:[’'‘`]s\s+(?:verifications|profile)|\s+(?:verifications|profile))/i);
      if (m && m[1]) {
        const partial = m[1].trim();
        const slug = location.pathname.match(/\/in\/([^/?#]+)/)?.[1];
        const slugName = slug ? decodeSlugToName(slug) : '';
        // If the slug-derived name starts with the partial (likely first name),
        // use the slug version (it has the full name).
        if (slugName && slugName.toLowerCase().startsWith(partial.toLowerCase())) {
          if (isValidName(slugName)) {
            console.log(LOG, 'extractProfileName: aria-label first name + slug', slugName);
            return slugName;
          }
        }
        if (isValidName(partial)) {
          console.log(LOG, 'extractProfileName: aria-label partial name', partial);
          return partial;
        }
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

    // 4. URL slug fallback
    const slugMatch = location.pathname.match(/\/in\/([^/?#]+)/);
    if (slugMatch && slugMatch[1]) {
      const decoded = decodeSlugToName(slugMatch[1]);
      if (isValidName(decoded)) {
        console.log(LOG, 'extractProfileName: matched URL slug', decoded);
        return decoded;
      }
    }

    // 5. <title> fallback
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

  // Returns the H1/H2 element holding the profile name, so callers can
  // walk DOM relative to it (e.g. find the headline <p> right below).
  function findNameHeading() {
    const main = document.querySelector('main') || document.body;
    for (const tag of ['h1', 'h2']) {
      const headings = main.querySelectorAll(tag);
      for (const h of headings) {
        const text = (h.innerText || h.textContent || '').trim();
        const cleaned = cleanLinkedInA11yText(text);
        if (isValidName(cleaned)) return h;
      }
    }
    return null;
  }

  // ─── Headline / title / company extraction ───────────────────────────
  // LinkedIn renames classes constantly, so each helper runs a multi-
  // selector cascade and logs which selector hit. When the next class
  // rename breaks something, the user pastes the console output and we
  // know exactly which step needs a new selector.

  // Reject strings that are obviously not the headline / role.
  function looksLikeJunkText(text) {
    if (!text || text.length < 3 || text.length > 400) return true;
    if (/^Status\s+is/i.test(text)) return true;
    if (/^(Home|My Network|Jobs|Messaging|Notifications|Me|Search|Connect|Message|Follow|More)$/i.test(text)) return true;
    if (/^connections?$/i.test(text)) return true;
    if (/^\d+\+?$/.test(text)) return true; // "500+", "1234"
    if (/^Contact info$/i.test(text)) return true;
    if (/^·$/.test(text)) return true;
    return false;
  }

  // Walk up from the name heading to a container that holds it AND the
  // sibling <p> elements (headline, company-line, location). The sibling
  // chain is the most reliable structure across LinkedIn layout versions.
  function findTopCardContainer(nameHeading) {
    if (!nameHeading) return null;
    let node = nameHeading;
    for (let i = 0; i < 8 && node; i++) {
      const ps = node.querySelectorAll(':scope > p, :scope > div > p, :scope > div > div > p');
      // We need at least 1 sibling-ish <p> for it to count as the top card.
      if (ps.length >= 1) return node;
      node = node.parentElement;
    }
    // Fallback: just walk up 4 levels.
    let up = nameHeading;
    for (let i = 0; i < 4 && up && up.parentElement; i++) up = up.parentElement;
    return up || nameHeading.parentElement;
  }

  // Get all <p> elements that appear visually after the name heading
  // within the same top-card region, in document order.
  function topCardParagraphs() {
    const nameHeading = findNameHeading();
    if (!nameHeading) return [];
    const container = findTopCardContainer(nameHeading);
    if (!container) return [];
    const allPs = [...container.querySelectorAll('p')];
    // Keep only the <p>s positioned AFTER the name heading in document order.
    const after = allPs.filter((p) => {
      const pos = nameHeading.compareDocumentPosition(p);
      return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    return after;
  }

  function readHeadline() {
    // Priority 1: first non-junk <p> sibling in the top card after the name.
    const ps = topCardParagraphs();
    for (const p of ps) {
      const text = (p.innerText || p.textContent || '').trim().replace(/\s+/g, ' ');
      if (looksLikeJunkText(text)) continue;
      // Skip the "Company · School" line — usually has a dot-separator and
      // is short. The headline is usually the longest descriptive line.
      if (/·/.test(text) && text.length < 120) continue;
      // Skip pure location strings like "United States" or "City, Country"
      if (/^[A-Za-zÀ-ÿ\s.,'-]+$/.test(text) && text.length < 50 && !/\b\w{6,}\b/.test(text)) continue;
      console.log(LOG, 'readHeadline: matched top-card <p>', text);
      return text;
    }

    // Priority 2: legacy class selectors for older LinkedIn layouts.
    const main = document.querySelector('main') || document.body;
    const legacySelectors = [
      '.pv-text-details__left-panel .text-body-medium',
      '.ph5 .text-body-medium.break-words',
      '.pv-top-card .text-body-medium',
      '.text-body-medium.break-words',
      '[data-test-id="profile-headline"]',
      'main .text-body-medium',
    ];
    for (const sel of legacySelectors) {
      const candidates = main.querySelectorAll(sel);
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').trim();
        if (looksLikeJunkText(text)) continue;
        console.log(LOG, 'readHeadline: matched legacy selector', { selector: sel, text });
        return text;
      }
    }
    console.warn(LOG, 'readHeadline: no headline found');
    return '';
  }

  function extractCurrentCompany() {
    const main = document.querySelector('main') || document.body;

    // Priority 1: SVG logo marker. LinkedIn's new layout uses
    // <svg id="company-accent-N"> for company cards and
    // <svg id="school-accent-N"> for schools. Walk up to the clickable
    // card container and read the inner <p> with the company name.
    const companyAccent = main.querySelector('svg[id^="company-accent"]');
    if (companyAccent) {
      const card = companyAccent.closest('[role="button"]')
        || companyAccent.closest('div[style*="min-width"]')
        || companyAccent.parentElement?.parentElement
        || companyAccent.parentElement;
      if (card) {
        const p = card.querySelector('p');
        if (p) {
          const text = cleanLinkedInA11yText((p.innerText || p.textContent || '').trim());
          if (text && text.length >= 2 && text.length <= 100) {
            console.log(LOG, 'extractCurrentCompany: matched company-accent SVG card', text);
            return { name: text, source: 'svg-company-accent' };
          }
        }
      }
    }

    // Priority 2: top-card current-employer link/button (older layouts).
    const topCardSelectors = [
      'a[aria-label^="Current company"]',
      'button[aria-label^="Current company"]',
      '[data-section="topCard"] a[href*="/company/"]',
      '.pv-text-details__right-panel a[href*="/company/"]',
      '.ph5 a[href*="/company/"]',
      '.pv-top-card a[href*="/company/"]',
    ];
    for (const sel of topCardSelectors) {
      const el = main.querySelector(sel);
      if (!el) continue;
      const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
      if (aria) {
        const ariaMatch = aria.match(/Current company:\s*(.+?)(?:\s+\(.+?\))?$/i);
        if (ariaMatch && ariaMatch[1]) {
          const name = ariaMatch[1].trim();
          console.log(LOG, 'extractCurrentCompany: matched aria-label', { selector: sel, name });
          return { name, source: 'topcard-aria' };
        }
      }
      const text = cleanLinkedInA11yText((el.innerText || el.textContent || '').trim());
      if (text && text.length >= 2 && text.length <= 100) {
        console.log(LOG, 'extractCurrentCompany: matched topcard link text', { selector: sel, text });
        return { name: text, source: 'topcard-text' };
      }
    }

    // Priority 3: "Company · School" pattern in the top-card sibling <p>s.
    const ps = topCardParagraphs();
    for (const p of ps) {
      const text = (p.innerText || p.textContent || '').trim().replace(/\s+/g, ' ');
      if (looksLikeJunkText(text)) continue;
      if (!/·/.test(text)) continue;
      const company = text.split('·')[0].trim();
      if (company.length >= 2 && company.length <= 100 && !/connection|follower|location/i.test(company)) {
        console.log(LOG, 'extractCurrentCompany: matched top-card · pattern', company);
        return { name: company, source: 'topcard-dot' };
      }
    }

    // Priority 4: experience section first entry.
    const headers = document.querySelectorAll('section h2, section h3');
    let expSection = document.getElementById('experience')
      || document.querySelector('section[data-section="experience"]');
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
        const name = text.split('·')[0].trim();
        if (name.length >= 2 && name.length <= 100) {
          console.log(LOG, 'extractCurrentCompany: matched experience link', name);
          return { name, source: 'experience-link' };
        }
      }
    }

    // Priority 5: headline "Title at Company" parsing.
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
      // Accept H1 OR H2 — newer LinkedIn layouts put the name in H2.
      const h = document.querySelector('main h1, main h2')
        || document.querySelector('h1, h2');
      const text = h ? (h.innerText || h.textContent || '').trim() : '';
      if (text.length > 0) return true;
      // Slug fallback: as long as the URL is /in/<handle>/, extractProfileName
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
