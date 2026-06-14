// ─── LinkedIn: fetch company TEAM adapter ──────────────────────────────────
// Entry point: window.__talentaiRun(params)
// Loads the company's "X employees" people search page and extracts the
// people array ONLY:  { people: [{ name, title, linkedinUrl }] }
// Does NOT scrape the about page — that's the info adapter's job.
//
// Time budget: ~8s (deeper scroll than info; LinkedIn lazy-loads cards).

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const keyword = (typeof params?.keyword === 'string' && params.keyword.trim()) ? params.keyword.trim() : '';
    console.log('[TalentAI cs] li/fetch-team start', { href: location.href, linkedinUrl: params?.linkedinUrl, keyword: keyword || null });
    // Hostname guard: if the SW injected us onto a non-linkedin tab (e.g.
    // chrome-extension:// page from a stale tab reuse), bail loudly instead
    // of looping on the wrong origin.
    const host = location.hostname || '';
    if (!/(^|\.)linkedin\.com$/i.test(host)) {
      console.log('[TalentAI cs] li/fetch-team aborted_non_linkedin_host', { host, href: location.href });
      return { debug: { reason: 'non_linkedin_host', host, href: location.href } };
    }
    // Reject a malformed `linkedinUrl` if the SW passed one — see fetch-
    // company-info.js for the rationale.
    const linkedinUrlParam = params?.linkedinUrl;
    if (linkedinUrlParam !== undefined && linkedinUrlParam !== null
        && (typeof linkedinUrlParam !== 'string' || !linkedinUrlParam.startsWith('https://www.linkedin.com/'))) {
      console.log('[TalentAI cs] li/fetch-team aborted_invalid_linkedin_url', { linkedinUrlParam });
      return { debug: { reason: 'invalid_linkedin_url', linkedinUrl: linkedinUrlParam } };
    }

    // The SW already navigates the tab to /company/<slug>/people/?keywords=X
    // so we should be on the right page. Only navigate as a fallback if we
    // somehow landed off the people page.
    const currentUrl = new URL(location.href);
    const onPeoplePage = currentUrl.pathname.includes('/people')
        || currentUrl.pathname.includes('/search/results/people');

    if (!onPeoplePage) {
      const slug = currentUrl.pathname.match(/\/company\/([^/]+)/)?.[1];
      if (slug) {
        const fallback = `${currentUrl.origin}/company/${slug}/people/`
            + (keyword ? `?keywords=${encodeURIComponent(keyword)}` : '');
        location.href = fallback;
        await u.sleep(4000);
      }
    }

    await Promise.race([
      u.waitForSelector('div[data-chameleon-result-urn]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('a[href*="/in/"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    if (RATE_LIMIT_INDICATORS.some((t) => pageTextLower.includes(t))) {
      console.log('[TalentAI cs] li/fetch-team rate_limited_429');
      return { debug: { reason: 'rate_limited_429' } };
    }

    // Page-by-page extraction. /search/results/people/ uses the same
    // .artdeco-pagination paginator as company search — Next/Previous
    // arrows + numbered Page N buttons + ?page= URL. We extract per
    // page, dedup by profile URL, then advance via goToNextPage().
    const MAX_PAGES = 3;
    const seen = new Set();
    const people = [];
    let pagesScraped = 0;
    let stoppedReason = null;
    let prevFirstHref = '';
    let matchedSelector = null;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      // Pre-extraction settle + deep scroll so LinkedIn lazy-loads cards.
      await u.sleep(u.jitter(1500));
      await u.scrollAndLoad({ scrolls: 4, scrollDelay: 1500, settleDelay: 1500 });

      const result = extractPagePeople(seen, people);
      pagesScraped = pageNum;
      prevFirstHref = result.firstAnchorHref;
      if (result.matchedSelector) matchedSelector = result.matchedSelector;
      console.log('[TalentAI cs] li/fetch-team page', {
        pageNum,
        added: result.added,
        cardCount: result.cardCount,
        totalPeople: people.length,
        matchedSelector: result.matchedSelector,
      });

      if (result.cardCount === 0) {
        stoppedReason = pageNum === 1 ? 'no_cards_matched' : 'no_cards_on_page';
        break;
      }
      if (pageNum >= MAX_PAGES) { stoppedReason = 'max_pages_reached'; break; }

      const nav = await goToNextPage(pageNum);
      if (!nav.ok) { stoppedReason = 'no_pagination_path'; break; }
      console.log('[TalentAI cs] li/fetch-team next_page', { from: pageNum, to: pageNum + 1, via: nav.via });

      await awaitPageRender(prevFirstHref, 'a[href*="/in/"]');
    }

    console.log('[TalentAI cs] li/fetch-team done', { pagesScraped, totalPeople: people.length, stoppedReason, matchedSelector });

    return {
      linkedinUrl: params.linkedinUrl || location.href.split('?')[0],
      keyword: keyword || null,
      people,
      pagination: { pagesScraped, maxPages: MAX_PAGES, stoppedReason, matchedSelector },
    };
  };

  // ─── Per-page extraction (factored out so the paging loop can call it
  // each iteration) — pushes into the shared `people` array, dedups via
  // the shared `seen` Set on profile URL ─────────────────────────────────
  // Container-agnostic people-card selection. LinkedIn's /search/results/people/
  // (incl. the COMPANY_PAGE_CANNED_SEARCH redirect) and the /company/<slug>/people/
  // org tab render different wrappers across redesigns, so try a cascade and
  // fall back to mapping each profile anchor to its closest container.
  // Mirrors CARD_SELECTORS in search-companies.js.
  const PEOPLE_CARD_SELECTORS = [
    'li.reusable-search__result-container',
    'div[data-view-name="search-entity-result-universal-template"]',
    'div[data-chameleon-result-urn]',
    'li.org-people-profile-card',
    'div.org-people-profile-card',
    'ul.search-results__list > li',
    'div.search-results__list > div',
    'li.artdeco-list__item',
  ];

  function selectPeopleCards() {
    for (const sel of PEOPLE_CARD_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) return { cards: Array.from(found), matchedSelector: sel };
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

  function extractPagePeople(seen, people) {
    const { cards, matchedSelector } = selectPeopleCards();
    const firstAnchorHref =
      cards[0]?.querySelector?.('a[href*="/in/"]')?.getAttribute('href') || '';
    let added = 0;

    for (const card of cards) {
      const profileAnchor = findProfileAnchor(card);
      if (!profileAnchor) continue;

      const profileUrl = (profileAnchor.href || '').split('?')[0];
      if (!profileUrl || seen.has(profileUrl)) continue;
      seen.add(profileUrl);

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

      const isPureName = (t) => pName && t.includes(pName)
        && t.split(pName).join('').replace(/[·•\-|\s]/g, '').length < 3;
      let title = '';
      // Pass 1: prefer a granular occupation line with no degree/mutual markers
      // in its RAW text (the subtitle is its own element, separate from the
      // degree badge + "mutual connections" node).
      for (const t of allText) {
        if (DEGREE_RAW.test(t) || MUTUAL.test(t) || isPureName(t)) continue;
        const cleaned = sanitizeTitle(t, pName);
        if (cleaned.length >= 3) { title = cleaned; break; }
      }
      // Pass 2 (fallback): clean a marker-laden line when no granular one exists.
      if (!title) {
        for (const t of allText) {
          if (isPureName(t)) continue;
          const cleaned = sanitizeTitle(t, pName);
          if (cleaned.length >= 3) { title = cleaned; break; }
        }
      }

      people.push({ name: pName, title, linkedinUrl: profileUrl });
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
      const ariaLabel = profileAnchor.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/View\s+(.+?)(?:'s\s+profile|\s+profile)/i);
      if (match && isValidName(match[1])) return match[1].trim();
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
