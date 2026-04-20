// ─── LinkedIn: search job posts adapter ──────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns
//   { companies: [...], debug?: { url, title, ... } }
//
// Scrapes LinkedIn Jobs search results to extract companies with hiring signals.
// URL pattern: https://www.linkedin.com/jobs/search/?keywords=...&location=...&f_TPR=r604800
// f_TPR=r604800 = posted in last 7 days.
//
// Deduplicates by company LinkedIn URL — one company may post multiple jobs
// but we only need it once for the pipeline.

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const limit = Math.min(50, params.limit || 25);
    console.log('[TalentAI cs] li/jobs start', { limit, url: location.href, params });

    // ─── Early popup / rate-limit detection ──────────────────────────────
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
    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const pageText = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    const hasTermsBanner = TERMS_INDICATORS.some((t) => pageText.includes(t.toLowerCase()));
    const hasModal = POPUP_SELECTORS.some((sel) => document.querySelector(sel));
    if (hasTermsBanner || hasModal) {
      const blockedBy = hasTermsBanner ? 'terms_update' : 'modal_overlay';
      console.log('[TalentAI cs] li/jobs blocked_by_popup', { blockedBy });
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
    const isRateLimited = RATE_LIMIT_INDICATORS.some((t) => pageText.includes(t));
    if (isRateLimited) {
      console.log('[TalentAI cs] li/jobs rate_limited_429');
      return {
        companies: [],
        debug: {
          ...collectDebug({ reason: 'rate_limited_429' }),
          userAction: 'LinkedIn is rate-limiting requests. The extension will back off automatically.',
        },
      };
    }

    // Wait for the jobs list container
    const container = await Promise.race([
      u.waitForSelector('.jobs-search-results-list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('.scaffold-layout__list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('ul.jobs-search__results-list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('.jobs-search-results', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);
    console.log('[TalentAI cs] li/jobs container', {
      matched: !!container,
      url: location.href,
      title: document.title,
    });

    if (!container) {
      return { companies: [], debug: collectDebug({ reason: 'no_container_found' }) };
    }

    // Scroll to load more job cards
    await u.scrollToBottom({ steps: 6, delayMs: 900 });

    // Try known job-card selectors
    const cardSelectors = [
      'li.jobs-search-results__list-item',
      'li.scaffold-layout__list-item',
      'div[data-job-id]',
      '.job-card-container',
      '.job-card-list__entity-lockup',
      'ul.jobs-search__results-list > li',
      '.jobs-search-results-list > ul > li',
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
    console.log('[TalentAI cs] li/jobs cards', { count: cards.length, selector: matchedSelector });

    // Fallback: any element with data-job-id
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('[data-job-id]'));
      if (cards.length > 0) matchedSelector = 'fallback_data_job_id';
    }

    if (cards.length === 0) {
      console.log('[TalentAI cs] li/jobs zero_data', { cardCount: 0, matchedSelector });
      return { companies: [], debug: collectDebug({ reason: 'no_cards_matched', triedSelectors: cardSelectors }) };
    }

    // Extract company info from job cards, deduplicate by company LinkedIn URL
    const seenCompanies = new Map(); // linkedinUrl or name → company object
    for (const card of cards.slice(0, limit)) {
      // Extract company anchor — look for link to /company/ page
      const companyAnchor = card.querySelector('a[href*="/company/"]');
      let companyName = '';
      let companyLinkedinUrl = '';

      if (companyAnchor) {
        companyLinkedinUrl = u.absoluteUrl(companyAnchor.getAttribute('href') || '').split('?')[0];
        companyName = (companyAnchor.textContent || '').trim().replace(/\s+/g, ' ');
      }

      // Fallback: try subtitle selectors for company name
      if (!companyName) {
        companyName =
          u.extractText(card, '.job-card-container__primary-description') ||
          u.extractText(card, '.artdeco-entity-lockup__subtitle') ||
          u.extractText(card, '.job-card-list__entity-lockup a[data-tracking-control-name*="company"]') ||
          u.extractText(card, '.base-search-card__subtitle') ||
          '';
      }

      if (!companyName || companyName.length < 2) continue;

      // Job title
      const jobTitle =
        u.extractText(card, '.job-card-list__title--link') ||
        u.extractText(card, '.job-card-container__link') ||
        u.extractText(card, '.job-card-list__title') ||
        u.extractText(card, '.artdeco-entity-lockup__title') ||
        u.extractText(card, '.base-search-card__title') ||
        u.extractText(card, 'a[data-tracking-control-name*="job"]') ||
        '';

      // Location
      const location =
        u.extractText(card, '.job-card-container__metadata-wrapper li') ||
        u.extractText(card, '.artdeco-entity-lockup__caption') ||
        u.extractText(card, '.job-card-container__metadata-item') ||
        u.extractText(card, '.base-search-card__metadata') ||
        '';

      // Posted date
      const postedAt =
        u.extractText(card, 'time') ||
        u.extractText(card, '.job-card-container__listed-time') ||
        u.extractText(card, '.job-card-container__footer-item') ||
        '';

      // Dedup by company LinkedIn URL, or by company name if no URL
      const dedupeKey = companyLinkedinUrl || companyName.toLowerCase();
      if (seenCompanies.has(dedupeKey)) {
        console.log('[TalentAI cs] li/jobs skip_dup', { companyName, dedupeKey });
        continue;
      }

      const company = {
        companyName: companyName.replace(/\s+/g, ' ').trim(),
        linkedinUrl: companyLinkedinUrl || undefined,
        jobTitle,
        postedAt,
        location,
        hiringSignal: true,
      };
      seenCompanies.set(dedupeKey, company);
      console.log('[TalentAI cs] li/jobs extracted', {
        companyName: company.companyName,
        linkedinUrl: company.linkedinUrl,
        jobTitle: company.jobTitle,
      });
    }

    const companies = Array.from(seenCompanies.values());

    if (companies.length === 0) {
      console.log('[TalentAI cs] li/jobs zero_data', { cardCount: cards.length, matchedSelector });
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

    console.log('[TalentAI cs] li/jobs done', { extracted: companies.length, matchedSelector, totalCards: cards.length });
    return { companies, debug: { matchedSelector, cardsScanned: cards.length, extracted: companies.length } };
  };

  // ─── Diagnostics ───────────────────────────────────────────────────────────
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
      jobCardCount: document.querySelectorAll('[data-job-id]').length,
      companyAnchorCount: document.querySelectorAll('a[href*="/company/"]').length,
      mainSnippet,
      ...extra,
    };
  }
})();
