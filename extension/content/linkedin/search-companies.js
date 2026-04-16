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

    // Wait for the search results container (selector varies across LI redesigns).
    const container = await Promise.race([
      u.waitForSelector('.search-results-container', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('ul.reusable-search__entity-result-list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('div.search-results__list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

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
    }

    if (cards.length === 0) {
      return { companies: [], debug: collectDebug({ reason: 'no_cards_matched', triedSelectors: cardSelectors }) };
    }

    const companies = [];
    for (const card of cards.slice(0, limit)) {
      const anchor = card.querySelector('a[href*="/company/"]');
      if (!anchor) continue;
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
      const industry = metaLines[0] || '';
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
        location: locMatch ? locMatch[1].trim() : '',
        logoUrl,
        rawMeta: metaLines,
      });
    }

    if (companies.length === 0) {
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

    return { companies, debug: { matchedSelector, cardsScanned: cards.length, extracted: companies.length } };
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
