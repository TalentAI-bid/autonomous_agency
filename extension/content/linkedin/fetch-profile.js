// ─── LinkedIn: fetch single PROFILE adapter ────────────────────────────────
// Entry point: window.__talentaiRun(params)  →  { name, title, linkedinUrl }
//
// User-triggered contact correction: the dashboard's "Re-scrape from LinkedIn"
// button enqueues a `fetch_profile` task pointed at ONE person's
// /in/<handle>/ page. The SW navigates the warm LinkedIn tab there; we read the
// canonical name + headline and hand them back. The backend stores them as a
// SUGGESTION (contacts.rawData.linkedinRescrape) — it never auto-overwrites.
//
// The name/headline extractors are ported verbatim from profile-sidebar.js
// (the manual "Add to Pipeline" widget), which already solved the 2026-layout
// quirks. Content scripts injected via chrome.scripting can't share globals,
// so the helpers are inlined here — keep them in sync with profile-sidebar.js.
//
// Every path logs to the page console; search for "[TalentAI cs] li/profile".

(() => {
  const u = window.__talentaiUtils;
  const LOG = '[TalentAI cs] li/profile';

  // ─── Reused name/headline helpers (source: profile-sidebar.js) ────────────

  function cleanLinkedInA11yText(text) {
    if (!text) return text;
    let t = String(text).trim();
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+(?:verifications|profile)|\s+(?:verifications|profile))/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    t = t.replace(/(^|\s)Verified(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
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
    if (/\bVerified\b/i.test(t)) return false;
    if (/\bverifications?\b/i.test(t)) return false;
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

  function extractProfileName() {
    const main = document.querySelector('main') || document.body;

    // 0. <title> tag — most stable. "Olivia Shepherd | LinkedIn" / "... - Role | LinkedIn".
    const titleStr = (document.title || '').trim();
    const tmFirst = titleStr.match(/^(?:\(\d+\)\s+)?(.+?)\s+(?:[|·]|[-–—])\s+/);
    if (tmFirst && tmFirst[1]) {
      const cleaned = cleanLinkedInA11yText(tmFirst[1].trim());
      if (isValidName(cleaned)) { console.log(LOG, 'name via <title>', cleaned); return cleaned; }
    }

    // 1. H1 / H2 aria-label or textContent (new layout uses H2).
    for (const tag of ['h1', 'h2']) {
      const headings = main.querySelectorAll(tag);
      for (const h of headings) {
        const aria = h.getAttribute && h.getAttribute('aria-label');
        if (aria) {
          const cleaned = cleanLinkedInA11yText(aria);
          if (isValidName(cleaned)) { console.log(LOG, `name via ${tag} aria-label`, cleaned); return cleaned; }
        }
        let raw = (h.innerText || h.textContent || '').trim().replace(/\s+/g, ' ');
        raw = raw.replace(/\s*•\s*(?:1st|2nd|3rd)(?:\+)?\s*/g, ' ').trim();
        const cleaned = cleanLinkedInA11yText(raw);
        if (isValidName(cleaned)) { console.log(LOG, `name via ${tag} text`, cleaned); return cleaned; }
      }
    }

    // 2. "View NAME's verifications/profile" aria-label, combined with slug.
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
        if (slugName && slugName.toLowerCase().startsWith(partial.toLowerCase()) && isValidName(slugName)) {
          console.log(LOG, 'name via aria partial + slug', slugName); return slugName;
        }
        if (isValidName(partial)) { console.log(LOG, 'name via aria partial', partial); return partial; }
      }
    }

    // 3. Hidden a11y spans.
    const hiddenSpans = main.querySelectorAll('.visually-hidden, .a11y-text, [class*="sr-only"], span[aria-label]');
    for (const span of hiddenSpans) {
      const aria = span.getAttribute && span.getAttribute('aria-label');
      if (aria) {
        const cleaned = cleanLinkedInA11yText(aria);
        if (isValidName(cleaned)) { console.log(LOG, 'name via hidden aria', cleaned); return cleaned; }
      }
      const text = (span.textContent || '').trim();
      const cleaned = cleanLinkedInA11yText(text);
      if (isValidName(cleaned)) { console.log(LOG, 'name via hidden text', cleaned); return cleaned; }
    }

    // 4. URL slug fallback.
    const slugMatch = location.pathname.match(/\/in\/([^/?#]+)/);
    if (slugMatch && slugMatch[1]) {
      const decoded = decodeSlugToName(slugMatch[1]);
      if (isValidName(decoded)) { console.log(LOG, 'name via slug', decoded); return decoded; }
    }

    console.warn(LOG, 'no name via any selector/title/slug');
    return '';
  }

  function findNameHeading() {
    const main = document.querySelector('main') || document.body;
    for (const tag of ['h1', 'h2']) {
      for (const h of main.querySelectorAll(tag)) {
        const cleaned = cleanLinkedInA11yText((h.innerText || h.textContent || '').trim());
        if (isValidName(cleaned)) return h;
      }
    }
    return null;
  }

  function looksLikeJunkText(text) {
    if (!text || text.length < 3 || text.length > 400) return true;
    if (/^Status\s+is/i.test(text)) return true;
    if (/^(Home|My Network|Jobs|Messaging|Notifications|Me|Search|Connect|Message|Follow|More)$/i.test(text)) return true;
    if (/^connections?$/i.test(text)) return true;
    if (/^\d+\+?$/.test(text)) return true;
    if (/^Contact info$/i.test(text)) return true;
    if (/^·$/.test(text)) return true;
    return false;
  }

  function findTopCardContainer(nameHeading) {
    if (!nameHeading) return null;
    let node = nameHeading;
    for (let i = 0; i < 8 && node; i++) {
      const ps = node.querySelectorAll(':scope > p, :scope > div > p, :scope > div > div > p');
      if (ps.length >= 1) return node;
      node = node.parentElement;
    }
    let up = nameHeading;
    for (let i = 0; i < 4 && up && up.parentElement; i++) up = up.parentElement;
    return up || nameHeading.parentElement;
  }

  function topCardParagraphs() {
    const nameHeading = findNameHeading();
    if (!nameHeading) return [];
    const container = findTopCardContainer(nameHeading);
    if (!container) return [];
    return [...container.querySelectorAll('p')].filter(
      (p) => !!(nameHeading.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  }

  function isMetaCompanyLine(text) {
    return /·/.test(text)
      && /\b(\d{1,3}(?:[.,]\d{3})*\+?|followers?|connections?|abonné|relation)\b/i.test(text);
  }
  function isLikelyLocation(text) {
    return /^[A-Za-zÀ-ÿ\s.,'-]+$/.test(text)
      && text.length < 40
      && /,/.test(text)
      && !/\b(at|@|chez|bei|en)\b/i.test(text);
  }

  function readHeadline() {
    const ps = topCardParagraphs();
    for (const p of ps) {
      const text = (p.innerText || p.textContent || '').trim().replace(/\s+/g, ' ');
      if (looksLikeJunkText(text) || isMetaCompanyLine(text) || isLikelyLocation(text)) continue;
      console.log(LOG, 'headline via top-card <p>', text); return text;
    }
    const nameHeading = findNameHeading();
    if (nameHeading) {
      const container = findTopCardContainer(nameHeading);
      if (container) {
        const candidates = [...container.querySelectorAll('div, span')].filter((el) => {
          if (!(nameHeading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
          if (el.contains(nameHeading)) return false;
          const own = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          return own.length >= 5 && own.length <= 200;
        });
        for (const el of candidates) {
          const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
          if (looksLikeJunkText(text) || isMetaCompanyLine(text) || isLikelyLocation(text)) continue;
          console.log(LOG, 'headline via top-card div/span', text); return text;
        }
      }
    }
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
      for (const el of main.querySelectorAll(sel)) {
        const text = (el.innerText || el.textContent || '').trim();
        if (looksLikeJunkText(text)) continue;
        console.log(LOG, 'headline via legacy selector', { sel, text }); return text;
      }
    }
    console.warn(LOG, 'no headline found');
    return '';
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  window.__talentaiRun = async function run(params) {
    console.log(LOG, 'start', { href: location.href, linkedinUrl: params?.linkedinUrl });

    const host = location.hostname || '';
    if (!/(^|\.)linkedin\.com$/i.test(host)) {
      console.log(LOG, 'aborted_non_linkedin_host', { host, href: location.href });
      return { debug: { reason: 'non_linkedin_host', host, href: location.href } };
    }

    // The SW already navigated the tab to the /in/<handle>/ page. Wait for the
    // top card, then settle + a light scroll so LinkedIn hydrates the name/headline.
    await Promise.race([
      u.waitForSelector('main h1', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main h2', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);
    await u.sleep(u.jitter(1200));
    await u.scrollAndLoad({ scrolls: 1, scrollDelay: 800, settleDelay: 800 }).catch(() => {});

    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    if (["you've reached the", 'you have reached the', 'rate limit', 'too many requests']
        .some((t) => pageTextLower.includes(t))) {
      console.log(LOG, 'rate_limited_429');
      return { debug: { reason: 'rate_limited_429' } };
    }

    const name = extractProfileName();
    const title = readHeadline();
    const linkedinUrl = (params?.linkedinUrl || location.href.split('?')[0]);

    console.log(LOG, 'done', { name, title });
    return { linkedinUrl, name: name || null, title: title || null };
  };
})();
