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

    await u.scrollToBottom({ steps: 5, delayMs: 900 });

    // Try every known card selector; first one with hits wins.
    const cardSelectors = [
      'li.reusable-search__result-container',
      'div[data-view-name="search-entity-result-universal-template"]',
      'div[data-chameleon-result-urn]',
      'li.artdeco-list__item',
      // Newer (2024+) LI search-results layout — links are direct children
      'div.search-results__list > div',
      'ul.search-results__list > li',
    ];
    let cards = [];
    let matchedSelector = null;
    for (const sel of cardSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        cards = Array.from(found);
        matchedSelector = sel;
        break;
      }
    }
    console.log('[TalentAI cs] li/search cards', { count: cards.length, selector: matchedSelector });

    // Last-ditch fallback: any anchor pointing at a /company/ URL.
    if (cards.length === 0) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/company/"]'));
      // Group by closest list-item ancestor so we don't double-count.
      const seen = new Set();
      cards = anchors
        .map((a) => a.closest('li, article, div[data-view-name], div[data-chameleon-result-urn]') || a)
        .filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        });
      if (cards.length > 0) matchedSelector = 'fallback_a_company_href';
      if (cards.length > 0) {
        console.log('[TalentAI cs] li/search fallback_anchors', { count: cards.length });
      }
    }

    if (cards.length === 0) {
      console.log('[TalentAI cs] li/search zero_data', { cardCount: 0, matchedSelector });
      return { companies: [], debug: collectDebug({ reason: 'no_cards_matched', triedSelectors: cardSelectors }) };
    }

    const companies = [];
    for (const card of cards.slice(0, limit)) {
      // LinkedIn renders two a[href*="/company/"] per card: the logo link
      // (aria-hidden, empty text) and the name link (has actual company name).
      // querySelector returns the first match — the logo — so we loop to find
      // the one with actual text content.
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
      // Skip meta rows that are counts/social signals rather than industry/location.
      // Covers EN + FR variants LinkedIn emits on company cards.
      const SKIP_META = /abonné|relation|événement|follower|event|suivent|connection|jobs|emploi/i;
      let industry = '';
      let location = '';
      for (const raw of metaLines) {
        const line = raw.trim();
        if (!line || SKIP_META.test(line)) continue;
        if (line.toLowerCase() === name.toLowerCase().trim()) continue; // skip the name duplicate
        if (!industry) { industry = line; continue; }
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

    if (companies.length === 0) {
      console.log('[TalentAI cs] li/search zero_data', { cardCount: cards.length, matchedSelector });
      return {
        companies: [],
        debug: collectDebug({
          reason: 'cards_matched_but_no_data',
          matchedSelector,
          cardCount: cards.length,
          firstCardHtml: (cards[0]?.outerHTML ?? '').slice(0, 1500),
        }),
      };
    }

    // ─── Client-side negative-keyword filter (PART 6B) ──────────────────────
    // Strategist-emitted params.negativeKeywords ride along on extension_tasks.params.
    // Mark — don't drop — so agentcore can audit what was filtered. The
    // server-side pre-save filter (extension-dispatcher.ts) re-applies this
    // as defense in depth.
    const negativeKeywords = Array.isArray(params?.negativeKeywords)
      ? params.negativeKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : [];
    let clientFiltered = 0;
    if (negativeKeywords.length) {
      for (const c of companies) {
        const haystack = [c.name, c.industry, (c.rawMeta || []).join(' ')]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        const hit = negativeKeywords.find((kw) => kw && haystack.includes(kw));
        if (hit) {
          c.filteredOut = true;
          c.filterReason = `matched negative keyword: ${hit}`;
          clientFiltered++;
        }
      }
    }

    console.log('[TalentAI cs] li/search done', { extracted: companies.length, clientFiltered, matchedSelector });
    return { companies, debug: { matchedSelector, cardsScanned: cards.length, extracted: companies.length, clientFiltered } };
  };

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
