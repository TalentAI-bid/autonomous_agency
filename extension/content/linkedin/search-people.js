// ─── LinkedIn: GLOBAL People search adapter ────────────────────────────────
// Entry point: window.__talentaiRun(params)
// The SW navigates the tab to a server-built /search/results/people/?keywords=…&geoUrn=…
// URL (params.searchUrl). We scrape the people results across pages and return
//   { keyword, people: [{ name, title, linkedinUrl, location }], pagination }
// People belong to many companies — ingest saves them as leads with companyId=null.
// Card extraction helpers are copied from fetch-company-team.js (standalone-adapter
// convention) so a fix in one is mirrored here.
(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const keyword = (typeof params?.keyword === 'string' && params.keyword.trim()) ? params.keyword.trim() : '';
    console.log('[TalentAI cs] li/search-people start', { href: location.href, keyword: keyword || null });
    const host = location.hostname || '';
    if (!/(^|\.)linkedin\.com$/i.test(host)) {
      console.log('[TalentAI cs] li/search-people aborted_non_linkedin_host', { host, href: location.href });
      return { debug: { reason: 'non_linkedin_host', host, href: location.href } };
    }

    // The SW already navigated to /search/results/people/?keywords=…&geoUrn=…
    await Promise.race([
      u.waitForSelector('div[data-chameleon-result-urn]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('a[href*="/in/"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

    const RATE_LIMIT_INDICATORS = ["you've reached the", 'you have reached the', 'rate limit', 'too many requests'];
    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    if (RATE_LIMIT_INDICATORS.some((t) => pageTextLower.includes(t))) {
      console.log('[TalentAI cs] li/search-people rate_limited_429');
      return { debug: { reason: 'rate_limited_429' } };
    }

    const MAX_PAGES = 3;
    const seen = new Set();
    const people = [];
    let pagesScraped = 0;
    let stoppedReason = null;
    let prevFirstHref = '';
    let matchedSelector = null;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      await u.sleep(u.jitter(1500));
      await u.scrollAndLoad({ scrolls: 4, scrollDelay: 1500, settleDelay: 1500 });

      const result = extractPagePeople(seen, people);
      pagesScraped = pageNum;
      prevFirstHref = result.firstAnchorHref;
      if (result.matchedSelector) matchedSelector = result.matchedSelector;
      console.log('[TalentAI cs] li/search-people page', {
        pageNum, added: result.added, cardCount: result.cardCount,
        totalPeople: people.length, matchedSelector: result.matchedSelector,
      });

      if (result.cardCount === 0) { stoppedReason = pageNum === 1 ? 'no_cards_matched' : 'no_cards_on_page'; break; }
      if (pageNum >= MAX_PAGES) { stoppedReason = 'max_pages_reached'; break; }

      const nav = await goToNextPage(pageNum);
      if (!nav.ok) { stoppedReason = 'no_pagination_path'; break; }
      await awaitPageRender(prevFirstHref, 'a[href*="/in/"]');
    }

    console.log('[TalentAI cs] li/search-people done', { pagesScraped, totalPeople: people.length, stoppedReason, matchedSelector });
    return {
      keyword: keyword || null,
      people,
      pagination: { pagesScraped, maxPages: MAX_PAGES, stoppedReason, matchedSelector },
    };
  };


  // People-search cards carry a location line (secondary subtitle / caption).
  // Best-effort + locale-independent (class-based); null when absent.
  function extractLocation(card) {
    const el = card.querySelector(
      '.entity-result__secondary-subtitle, .artdeco-entity-lockup__caption, .entity-result__summary',
    );
    if (el) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2 && t.length <= 100) return t;
    }
    return null;
  }

  // ─── Per-page extraction (factored out so the paging loop can call it
  // each iteration) — pushes into the shared `people` array, dedups via
  // the shared `seen` Set on profile URL ─────────────────────────────────
  // Container-agnostic people-card selection. LinkedIn's /search/results/people/
  // (incl. the COMPANY_PAGE_CANNED_SEARCH redirect) and the /company/<slug>/people/
  // org tab render different wrappers across redesigns, so try a cascade and
  // fall back to mapping each profile anchor to its closest container.
  // Mirrors CARD_SELECTORS in search-companies.js.
  // NOTE: use attribute-CONTAINS for the org people card — the live DOM class is
  // `org-people-profile-card__profile-card-spacing` (a BEM modifier), so the exact
  // `.org-people-profile-card` never matched and the cascade fell through to the
  // too-generic `li.artdeco-list__item` (which matched filter/empty rows → 0 people)
  // or the lossy anchor fallback. The entity-lockup selector is the content wrapper.
  const PEOPLE_CARD_SELECTORS = [
    'li.reusable-search__result-container',
    'div[data-view-name="search-entity-result-universal-template"]',
    'div[data-chameleon-result-urn]',
    'li[class*="org-people-profile-card"]',
    'div[class*="org-people-profile-card"]',
    'ul.search-results__list > li',
    'div.search-results__list > div',
    'li.artdeco-list__item',
  ];

  function selectPeopleCards() {
    for (const sel of PEOPLE_CARD_SELECTORS) {
      // Only accept a selector whose matches actually contain a profile link —
      // guards against generic selectors (artdeco-list__item) matching filter
      // chips / empty rows and reporting "cards found" with 0 extractable people.
      const found = Array.from(document.querySelectorAll(sel))
        .filter((el) => el.querySelector && el.querySelector('a[href*="/in/"]'));
      if (found.length > 0) return { cards: found, matchedSelector: sel };
    }
    // Generic fallback: every profile anchor → its closest plausible container.
    const seenCards = new Set();
    const cards = Array.from(document.querySelectorAll('a[href*="/in/"]'))
      .map((a) => a.closest(
        'li, div[data-chameleon-result-urn], div[data-view-name], article, div[data-display-contents="true"]',
      ) || a)
      .filter((el) => { if (seenCards.has(el)) return false; seenCards.add(el); return true; });
    return { cards, matchedSelector: cards.length ? 'fallback_a_in_href' : null };
  }

  // Followers / "Pages similaires" (similar pages) sidebar markers. Cards
  // carrying these are page-followers or other companies, not employees:
  //   FR "X suit/suivent cette page", "Pages similaires", "Page Vitrine"
  //   "<industry> N abonnés", EN "follows this page" / "N followers".
  const JUNK_CARD = /\b(?:suit|suivent)\s+cette\s+page\b|\bfollows?\s+this\s+page\b|\bpages?\s+(?:similaires|associées)\b|\bpage\s+vitrine\b|\d[\d\s.,]*\s*(?:abonnés?|followers?)\b/i;
  // Right-rail / sidebar containers the employee list never lives in.
  const SIDEBAR_SELECTOR =
    'aside, .scaffold-layout__aside, section[class*="similar"], div[class*="similar"], div[class*="discover"], [class*="follows-this-page"], [class*="org-similar"]';

  function extractPagePeople(seen, people) {
    const { cards, matchedSelector } = selectPeopleCards();
    const firstAnchorHref =
      cards[0]?.querySelector?.('a[href*="/in/"]')?.getAttribute('href') || '';
    let added = 0;

    for (const card of cards) {
      // Skip cards living in the followers / similar-pages right rail — those
      // are not employees (locale-independent: matches on container class).
      if (card.closest && card.closest(SIDEBAR_SELECTOR)) continue;

      const profileAnchor = findProfileAnchor(card);
      if (!profileAnchor) continue;

      const profileUrl = (profileAnchor.href || '').split('?')[0];
      if (!profileUrl || seen.has(profileUrl)) continue;
      seen.add(profileUrl);

      // Text-level guard: even if a sidebar card escapes the container check
      // (LinkedIn redesigns), reject it when its text carries follower /
      // similar-page markers ("suit cette page", "N abonnés").
      const cardText = (card.textContent || '').replace(/\s+/g, ' ');
      if (JUNK_CARD.test(cardText)) continue;

      let pName = extractPersonName(card);
      if (!pName) continue;
      pName = pName.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
      if (!pName) continue;

      const MUTUAL = /relations? en commun|mutual connection|relation que vous avez/i;

      function isHiddenForA11y(el) {
        let node = el;
        while (node && node !== card) {
          if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
          const cls = (node.className && typeof node.className === 'string') ? node.className : '';
          if (/\bvisually-hidden\b|\bsr-only\b|\ba11y-text\b/.test(cls)) return true;
          node = node.parentElement;
        }
        return false;
      }

      const allText = Array.from(card.querySelectorAll('div, span, p'))
        .filter((el) => !isHiddenForA11y(el))
        .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
        .filter((t) => t.length > 5 && t.length < 200);

      // Case-insensitive so a slug-derived name ("Sankalp Ks") still matches the
      // visible name line ("Sankalp KS") and isn't mistaken for the title.
      const isPureName = (t) => {
        if (!pName) return false;
        const lt = t.toLowerCase();
        const ln = pName.toLowerCase();
        return lt.includes(ln) && lt.split(ln).join('').replace(/[·•\-|\s]/g, '').length < 3;
      };
      let title = '';
      // Pass 0 (preferred): the structured occupation subtitle. Locale-independent
      // (class-based) and unambiguous — it's a sibling of the title, never the name.
      // Two layouts: org people-card uses `.artdeco-entity-lockup__subtitle`; the
      // people-search result uses `.entity-result__primary-subtitle` (the location
      // sits in `__secondary-subtitle`, which we deliberately do NOT pick here).
      const lockupSubtitle = card.querySelector(
        '.artdeco-entity-lockup__subtitle, .entity-result__primary-subtitle',
      );
      if (lockupSubtitle) {
        const cleaned = sanitizeTitle((lockupSubtitle.textContent || '').replace(/\s+/g, ' ').trim(), pName);
        if (cleaned.length >= 3 && !isPureName(cleaned)) title = cleaned;
      }
      // Pass 1 (fallback when no structured subtitle): prefer a granular
      // occupation line with no degree/mutual markers in its RAW text (the
      // subtitle is its own element, separate from the degree badge + "mutual
      // connections" node).
      if (!title) {
        for (const t of allText) {
          if (DEGREE_RAW.test(t) || MUTUAL.test(t) || isPureName(t)) continue;
          const cleaned = sanitizeTitle(t, pName);
          if (cleaned.length >= 3) { title = cleaned; break; }
        }
      }
      // Pass 2 (fallback): clean a marker-laden line when no granular one exists.
      if (!title) {
        for (const t of allText) {
          if (isPureName(t)) continue;
          const cleaned = sanitizeTitle(t, pName);
          if (cleaned.length >= 3) { title = cleaned; break; }
        }
      }

      people.push({ name: pName, title, linkedinUrl: profileUrl, location: extractLocation(card) });
      added++;
    }
    return { added, cardCount: cards.length, firstAnchorHref, matchedSelector };
  }

  // ─── Pagination helpers (mirror the implementation in
  // search-companies.js so each adapter stays standalone) ───────────────────
  async function goToNextPage(currentPage) {
    const nextArrow = document.querySelector(
      'button[aria-label="Next"]:not([disabled]),'
      + ' .artdeco-pagination__button--next:not([disabled])'
    );
    if (nextArrow) {
      nextArrow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await u.sleep(u.jitter(800));
      if (u.safeClick(nextArrow)) return { ok: true, via: 'next_button' };
    }

    const target = currentPage + 1;
    const pageBtn = document.querySelector(
      `button[aria-label="Page ${target}"]:not([disabled])`
    ) || Array.from(
      document.querySelectorAll('.artdeco-pagination__indicator button:not([disabled])')
    ).find((b) => (b.textContent || '').trim() === String(target));
    if (pageBtn) {
      pageBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await u.sleep(u.jitter(800));
      if (u.safeClick(pageBtn)) return { ok: true, via: 'page_button' };
    }

    try {
      const urlObj = new URL(location.href);
      urlObj.searchParams.set('page', String(target));
      history.pushState({}, '', urlObj.toString());
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return { ok: true, via: 'url_pushstate' };
    } catch {
      return { ok: false, via: null };
    }
  }

  async function awaitPageRender(prevFirstHref, anchorSelector) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const a = document.querySelector(anchorSelector);
      const href = a?.getAttribute?.('href') || '';
      if (href && href !== prevFirstHref) break;
      await u.sleep(300);
    }
    await u.sleep(u.jitter(1500));
  }

  // ─── Helpers (copied from fetch-company.js so each adapter is standalone) ─

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
    if (/\bprofil\b/i.test(t)) return false;          // FR "profil" (EN "profile" above)
    if (/Relation de\s+\d/i.test(t)) return false;    // FR connection-degree leak
    if (/degree connection/i.test(t)) return false;   // EN connection-degree leak
    if (/\b(?:suit|suivent) cette page\b/i.test(t)) return false; // FR followers-sidebar leak
    if (/\bfollows? this page\b/i.test(t)) return false;          // EN followers-sidebar leak
    if (/[·•]\s*\d/.test(t)) return false;            // visible degree badge leak ("· 3e")
    if (/%[0-9A-Fa-f]{2}/.test(t)) return false;
    return true;
  }

  // Connection-degree markers leak into anchor text on non-English LinkedIn UIs.
  // Cut everything from the first degree marker onward (locale-agnostic):
  //   EN  "• 1st" / "1st degree connection" / "2nd" / "3rd+"
  //   FR  "· 3e"  / "Relation de 2e niveau" / "Relation de 3e niveau et plus"
  function stripConnectionDegree(text) {
    if (!text) return text;
    let t = String(text);
    t = t.replace(/\s*Relation de\s+\d.*$/is, '');                       // FR a11y degree phrase
    t = t.replace(/\s*\b\d(?:st|nd|rd|th)\b[^|]*?\bdegree\b.*$/is, '');   // EN "Nth degree connection"
    t = t.replace(/\s*[·•]\s*(?:1re|2e|3e|1st|2nd|3rd)\+?.*$/is, '');     // visible badge "· 3e"/"• 3rd+"
    t = t.replace(/\s*\b(?:1st|2nd|3rd)\+?\b.*$/is, '');                  // EN bare degree
    t = t.replace(/\s*\b(?:1re|2e|3e)\b.*$/is, '');                       // FR bare degree
    return t.trim();
  }

  // Clean a candidate title line of name duplication, connection-degree
  // fragments, and CTA buttons (EN + FR). Returns '' when nothing meaningful
  // survives so the caller keeps looking.
  function sanitizeTitle(raw, pName) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (pName) s = s.split(pName).join(' ');
    s = s.replace(/Relation de\s+\d\w*\s+niveau(?:\s+et\s+plus)?/gi, ' ');   // FR degree phrase
    s = s.replace(/\b\d(?:st|nd|rd|th)\s+degree(?:\s+connection)?\b/gi, ' '); // EN degree phrase
    s = s.replace(/[·•]\s*(?:1re|2e|3e|1st|2nd|3rd)\+?/gi, ' ');             // degree badge
    s = s.replace(/\b(?:Message|Se\s+connecter|Connect|Follow|Suivre|S['’]abonner)\b/gi, ' '); // CTAs
    s = s.replace(/\s+et\s+\d+\s+autres?\s+relations?\s+en\s+commun.*$/i, ' '); // FR "et N autres relations en commun"
    s = s.replace(/\s*\b(?:relations?\s+en\s+commun|mutual connections?|est une relation que vous avez en commun)\b.*$/i, ' ');
    s = s.replace(/\s+/g, ' ').replace(/^[·•\-|\s]+/, '').replace(/[·•\-|\s]+$/, '').trim();
    return s;
  }

  // Raw markers that mean a text node is a degree/connection-insight node, not
  // the occupation subtitle — used to prefer a clean granular line first.
  const DEGREE_RAW = /Relation de\s+\d|[·•]\s*(?:1re|2e|3e|1st|2nd|3rd)|\bdegree connection\b/i;

  function cleanLinkedInA11yText(text) {
    if (!text) return text;
    let t = text.trim();
    // French a11y: "Voir le profil de NAME" → NAME (mirror of the English arm).
    const fr = t.match(/Voir le profil de\s+(.+)/i);
    if (fr && fr[1]) {
      const inner = fr[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    return t;
  }

  function decodeSlugToName(slug) {
    let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
    try { cleaned = decodeURIComponent(cleaned); } catch (e) { /* ignore */ }
    const name = cleaned
      .split('-')
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return name || null;
  }

  function findProfileAnchor(card) {
    const anchors = card.querySelectorAll('a[href*="/in/"]');
    for (const a of anchors) {
      const text = (a.textContent || '').trim();
      if (/^Status\s+is/i.test(text)) continue;
      if (a.getAttribute('aria-hidden') === 'true') continue;
      return a;
    }
    return anchors[0] || null;
  }

  function extractPersonName(card) {
    // Structured entity-lockup (the modern org-people card): the visible name
    // lives in .artdeco-entity-lockup__title. Locale-independent (class-based)
    // and the most reliable source — prefer it over anchor-text/slug guesses,
    // which mis-fire on non-English UIs (e.g. FR "Voir le profil de NAME" the
    // English-only aria-label regex below can't read, forcing a slug fallback
    // whose casing then leaks the name into the title field).
    const lockupTitle = card.querySelector('.artdeco-entity-lockup__title');
    if (lockupTitle) {
      const titleAnchor = lockupTitle.querySelector('a[aria-label]');
      if (titleAnchor) {
        const cleaned = cleanLinkedInA11yText((titleAnchor.getAttribute('aria-label') || '').trim());
        if (isValidName(cleaned)) return cleaned;
      }
      const txt = stripConnectionDegree((lockupTitle.textContent || '').trim().replace(/\s+/g, ' '));
      if (isValidName(txt)) return txt;
    }
    const hiddenSpan = card.querySelector(
      '.visually-hidden, .a11y-text, [class*="sr-only"], span[aria-label]',
    );
    if (hiddenSpan) {
      const ariaLabel = hiddenSpan.getAttribute && hiddenSpan.getAttribute('aria-label');
      if (ariaLabel) {
        const cleaned = cleanLinkedInA11yText(ariaLabel.trim());
        if (isValidName(cleaned)) return cleaned;
      }
      const text = (hiddenSpan.textContent || '').trim();
      const cleanedText = cleanLinkedInA11yText(text);
      if (isValidName(cleanedText)) return cleanedText;
    }
    const profileAnchor = findProfileAnchor(card);
    if (profileAnchor) {
      // Route the aria-label through cleanLinkedInA11yText, which handles BOTH
      // apostrophe styles ("View Jane Doe’s profile") and the French phrasing
      // ("Voir le profil de NAME") — the old inline regex only matched a straight
      // "'s" and left a trailing "’s" on the name.
      const ariaLabel = (profileAnchor.getAttribute('aria-label') || '').trim();
      if (ariaLabel) {
        const cleaned = cleanLinkedInA11yText(ariaLabel);
        if (cleaned && cleaned !== ariaLabel && isValidName(cleaned)) return cleaned;
      }
    }
    if (profileAnchor) {
      let text = (profileAnchor.textContent || '').trim().replace(/\s+/g, ' ');
      text = stripConnectionDegree(text);
      text = text.replace(/Status is (online|offline|away)/gi, '').trim();
      text = cleanLinkedInA11yText(text);
      if (isValidName(text)) return text;
    }
    if (profileAnchor) {
      const href = profileAnchor.getAttribute('href') || '';
      const slugMatch = href.match(/\/in\/([^\/?#]+)/);
      if (slugMatch) {
        const decoded = decodeSlugToName(slugMatch[1]);
        if (isValidName(decoded)) return decoded;
      }
    }
    return null;
  }
})();
