// ─── LinkedIn: search companies adapter ────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns
//   { companies: [...], debug?: { url, title, ... } }
//
// LinkedIn changes their search-results DOM frequently. We try several
// generations of selectors. When NOTHING matches we still return successfully
// with a `debug` payload so the dashboard can show the user why nothing was
// extracted (login wall, captcha, "premium only" overlay, new DOM, etc.).

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const limit = Math.min(50, params.limit || 20);
    console.log('[TalentAI cs] li/search start', { limit, url: location.href, params });

    // ─── Early popup detection ──────────────────────────────────────────────
    // LinkedIn sometimes covers the results with a "Update to our terms"
    // banner, a premium-upsell modal, or a cookie prompt. We don't click
    // through these programmatically — the user needs to acknowledge them.
    // If we detect one, bail out with a specific debug reason so the service
    // worker can pause the extension and prompt the user.
    const POPUP_SELECTORS = [
      '[data-test-modal-close-btn]',
      '.artdeco-modal__dismiss',
      '[class*="premium-upsell"]',
      '[data-test-premium-upsell]',
    ];
    const TERMS_INDICATORS = [
      'Update to our terms',
      'Mise à jour de nos conditions',
    ];
    const pageText = document.body?.innerText?.slice(0, 500) || '';
    const hasTermsBanner = TERMS_INDICATORS.some((t) => pageText.includes(t));
    const hasModal = POPUP_SELECTORS.some((sel) => document.querySelector(sel));
    if (hasTermsBanner || hasModal) {
      const blockedBy = hasTermsBanner ? 'terms_update' : 'modal_overlay';
      console.log('[TalentAI cs] li/search blocked_by_popup', { blockedBy });
      return {
        companies: [],
        debug: {
          ...collectDebug({ reason: 'blocked_by_popup' }),
          blockedBy,
          userAction: 'Please dismiss the popup on the LinkedIn tab, then click Resume in the extension.',
        },
      };
    }

    // 429 / rate-limit page detection
    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const lowerPageText = pageText.toLowerCase();
    const isRateLimited = RATE_LIMIT_INDICATORS.some((t) => lowerPageText.includes(t));
    if (isRateLimited) {
      console.log('[TalentAI cs] li/search rate_limited_429');
      return {
        companies: [],
        debug: {
          ...collectDebug({ reason: 'rate_limited_429' }),
          userAction: 'LinkedIn is rate-limiting requests. The extension will back off automatically.',
        },
      };
    }

    // Wait for the search results container (selector varies across LI redesigns).
    const container = await Promise.race([
      u.waitForSelector('.search-results-container', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('ul.reusable-search__entity-result-list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('div.search-results__list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);
    console.log('[TalentAI cs] li/search container', {
      matched: !!container,
      url: location.href,
      title: document.title,
    });

    if (!container) {
      return { companies: [], debug: collectDebug({ reason: 'no_container_found' }) };
    }

    // Page-by-page extraction. LinkedIn search results paginate via
    // .artdeco-pagination — Next/Previous arrows + numbered Page N
    // buttons. We try Next first, then numbered, then a ?page= URL
    // pushState fallback. See goToNextPage() below.
    const maxPages = 3;
    const all = [];
    const seenUrls = new Set();
    let pagesScraped = 0;
    let lastMatchedSelector = null;
    let stoppedReason = null;
    let prevFirstHref = '';

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // Pre-extraction settle: LinkedIn's search results lazy-load below
      // the fold (description previews, location subtitles).
      await u.sleep(u.jitter(1500));
      await u.scrollAndLoad({ scrolls: 2, scrollDelay: 1000, settleDelay: 1000 });

      const page = extractPageCompanies(limit);
      pagesScraped = pageNum;
      lastMatchedSelector = page.matchedSelector;
      prevFirstHref = page.firstAnchorHref;
      console.log('[TalentAI cs] li/search page', {
        pageNum,
        extracted: page.companies.length,
        cardCount: page.cardCount,
        matchedSelector: page.matchedSelector,
      });

      if (page.cardCount === 0) {
        // No cards on the very first page → genuine empty (debug-worthy).
        // No cards on later pages → past the last LinkedIn page; stop quietly.
        stoppedReason = pageNum === 1 ? 'no_cards_matched' : 'no_cards_on_page';
        if (pageNum === 1) {
          return {
            companies: [],
            debug: collectDebug({ reason: 'no_cards_matched', triedSelectors: CARD_SELECTORS }),
          };
        }
        break;
      }

      for (const c of page.companies) {
        if (!c.linkedinUrl || seenUrls.has(c.linkedinUrl)) continue;
        seenUrls.add(c.linkedinUrl);
        all.push(c);
        if (all.length >= limit) break;
      }
      if (all.length >= limit) { stoppedReason = 'limit_reached'; break; }
      if (pageNum >= maxPages) { stoppedReason = 'max_pages_reached'; break; }

      const nav = await goToNextPage(pageNum);
      if (!nav.ok) { stoppedReason = 'no_pagination_path'; break; }
      console.log('[TalentAI cs] li/search next_page', { from: pageNum, to: pageNum + 1, via: nav.via });

      await awaitPageRender(prevFirstHref, 'a[href*="/company/"]');
    }

    if (all.length === 0) {
      console.log('[TalentAI cs] li/search zero_data', { stoppedReason, lastMatchedSelector });
      return {
        companies: [],
        debug: collectDebug({
          reason: 'cards_matched_but_no_data',
          matchedSelector: lastMatchedSelector,
          stoppedReason,
        }),
      };
    }

    // No client-side keyword filter — every scraped row is sent back to
    // agentcore. The server-side LLM scorer ranks them; the dashboard
    // sorts by score. See plan: discovery-pipeline refactor PART 1.
    console.log('[TalentAI cs] li/search done', {
      extracted: all.length,
      pagesScraped,
      stoppedReason,
      matchedSelector: lastMatchedSelector,
    });
    return {
      companies: all,
      pagination: { pagesScraped, maxPages, stoppedReason, matchedSelector: lastMatchedSelector },
      debug: { matchedSelector: lastMatchedSelector, extracted: all.length, pagesScraped },
    };
  };

  // ─── Per-page extraction (factored out so the paging loop can call it
  // each iteration) ─────────────────────────────────────────────────────────
  const CARD_SELECTORS = [
    // 2026 redesign — outer wrapper anchor IS the card. `tabindex="0"` plus a
    // /company/ href uniquely identifies one wrapper per visible result; the
    // inner title and follower anchors don't carry tabindex.
    'a[tabindex="0"][href*="/company/"]',
    // 2024 layouts — direct list children
    'div.search-results__list > div',
    'ul.search-results__list > li',
    // Legacy (pre-2024)
    'li.reusable-search__result-container',
    'div[data-view-name="search-entity-result-universal-template"]',
    'div[data-chameleon-result-urn]',
    'li.artdeco-list__item',
  ];

  function extractPageCompanies(limit) {
    let cards = [];
    let matchedSelector = null;
    for (const sel of CARD_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        cards = Array.from(found);
        matchedSelector = sel;
        break;
      }
    }
    if (cards.length === 0) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/company/"]'));
      const seenCards = new Set();
      cards = anchors
        .map((a) => a.closest(
          'a[tabindex="0"][href*="/company/"], div[data-display-contents="true"], li, article, div[data-view-name], div[data-chameleon-result-urn]',
        ) || a)
        .filter((el) => { if (seenCards.has(el)) return false; seenCards.add(el); return true; });
      if (cards.length > 0) matchedSelector = 'fallback_a_company_href';
    }

    const firstAnchorHref = cards[0]?.querySelector?.('a[href*="/company/"]')?.getAttribute('href') || '';

    const companies = [];
    for (const card of cards.slice(0, limit)) {
      const allAnchors = card.querySelectorAll('a[href*="/company/"]');
      let anchor = null;
      for (const a of allAnchors) {
        const text = (a.textContent || '').trim();
        if (text.length > 1 && a.getAttribute('aria-hidden') !== 'true') {
          anchor = a;
          break;
        }
      }
      if (!anchor) {
        anchor = allAnchors[0];
        if (!anchor) continue;
      }
      const linkedinUrl = u.absoluteUrl(anchor.getAttribute('href') || '').split('?')[0];
      const name =
        u.extractText(card, '.entity-result__title-text a span[aria-hidden="true"]') ||
        u.extractText(card, '.entity-result__title-text a') ||
        u.extractText(card, '.entity-result__title-text') ||
        u.extractText(card, 'a[href*="/company/"] span[aria-hidden="true"]') ||
        u.extractText(card, 'a[href*="/company/"]') ||
        u.extractText(anchor);
      if (!name) continue;

      const metaLines = [];
      card
        .querySelectorAll(
          '.entity-result__primary-subtitle, .entity-result__secondary-subtitle, .entity-result__summary, p, .t-14',
        )
        .forEach((el) => {
          const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
          if (txt && !metaLines.includes(txt)) metaLines.push(txt);
        });

      const metaBlob = metaLines.join(' | ');
      // Word-boundary match so industry names that share a stem are kept.
      // Without \b, "événement" matched "Événementiel" (a real LI industry),
      // dropping the industry value for French event-tech companies.
      const SKIP_META = /\b(abonné|relation|événement|follower|event|suivent|connection|jobs|emploi)s?\b/i;
      let industry = '';
      let location = '';
      for (const raw of metaLines) {
        const line = raw.trim();
        if (!line || SKIP_META.test(line)) continue;
        if (line.toLowerCase() === name.toLowerCase().trim()) continue;
        if (!industry) {
          // LinkedIn typically packs "Industry • City, Country" into one line.
          // Split on the bullet/middle-dot so industry and location land in
          // their right buckets — previously the whole line went to industry
          // and a later description sentence was misread as location, which
          // tanked the server-side geo filter.
          const parts = line.split(/[•·]/).map((s) => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            industry = parts[0];
            location = parts.slice(1).join(', ');
            break;
          }
          industry = line;
          continue;
        }
        if (!location && /[A-Z]/.test(line.charAt(0))) { location = line; break; }
      }
      const sizeMatch = metaBlob.match(/([\d,]+[\d,\-+]*)\s*(employees|followers)/i);
      const locMatch = metaBlob.match(/([A-Z][\w\s,\.-]+?)(?:\s*\·|$)/);

      const logo = card.querySelector(
        'img.ivm-image-view-model__image-view, img.evi-image, img.presence-entity__image, img.ghost-company, img',
      );
      const logoUrl = logo?.getAttribute('src') || '';

      companies.push({
        name: name.replace(/\s+/g, ' ').trim(),
        linkedinUrl,
        industry,
        size: sizeMatch ? sizeMatch[0] : '',
        location: location || (locMatch ? locMatch[1].trim() : ''),
        logoUrl,
        rawMeta: metaLines,
      });
      const pushed = companies[companies.length - 1];
      console.log('[TalentAI cs] li/search extracted', { name: pushed.name, linkedinUrl: pushed.linkedinUrl });
    }
    return { companies, matchedSelector, cardCount: cards.length, firstAnchorHref };
  }

  // ─── Pagination helpers (shared shape with fetch-company-team.js) ─────────
  // Try Next arrow → numbered Page button → URL pushState fallback. Keep
  // the running content script alive — `location.assign` would tear us
  // down. The pushState path triggers LI's SPA router via popstate.
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

  // ─── Diagnostics ───────────────────────────────────────────────────────────
  // Captured ONLY when extraction failed, so the dashboard can show the user
  // exactly why (login wall? captcha? new DOM? premium-only overlay?).
  function collectDebug(extra = {}) {
    const url = location.href;
    const title = document.title;
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const isLoginWall =
      /\/login|\/checkpoint|\/uas\/login|authwall/i.test(url) ||
      !!document.querySelector('form[action*="login"], input[name="session_key"]');
    const isCaptcha =
      /captcha|challenge/i.test(url) ||
      !!document.querySelector('[class*="captcha"], [id*="captcha"]');
    const isPremiumGate =
      !!document.querySelector('[data-test-premium-upsell], [class*="premium-upsell"]');
    // Snapshot the first 1500 chars of <main> so we can recognise new DOM shapes.
    const mainSnippet = (document.querySelector('main')?.outerHTML ?? document.body?.outerHTML ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 1500);

    return {
      url,
      title,
      h1,
      isLoginWall,
      isCaptcha,
      isPremiumGate,
      anchorCompanyCount: document.querySelectorAll('a[href*="/company/"]').length,
      mainSnippet,
      ...extra,
    };
  }
})();
