// ─── LinkedIn: search companies adapter ────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns { companies: [...] }

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const limit = Math.min(50, params.limit || 20);

    // Wait for the search results container (selector varies across LI redesigns).
    const container = await Promise.race([
      u.waitForSelector('.search-results-container', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('div[data-view-name="search-entity-result-universal-template"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('ul.reusable-search__entity-result-list', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

    if (!container) throw new Error('linkedin_search_no_results_container');

    await u.scrollToBottom({ steps: 5, delayMs: 900 });

    const cardSelectors = [
      'li.reusable-search__result-container',
      'div[data-view-name="search-entity-result-universal-template"]',
      'li.artdeco-list__item',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { cards = Array.from(found); break; }
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
        u.extractText(anchor);
      if (!name) continue;

      const metaLines = [];
      card.querySelectorAll('.entity-result__primary-subtitle, .entity-result__secondary-subtitle, .entity-result__summary').forEach((el) => {
        const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (txt) metaLines.push(txt);
      });

      const metaBlob = metaLines.join(' | ');
      const industry = metaLines[0] || '';
      const sizeMatch = metaBlob.match(/([\d,]+[\d,\-+]*)\s*(employees|followers)/i);
      const locMatch  = metaBlob.match(/([A-Z][\w\s,\.-]+?)(?:\s*\·|$)/);

      const logo = card.querySelector('img.ivm-image-view-model__image-view, img.evi-image, img.presence-entity__image, img.ghost-company');
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

    return { companies };
  };
})();
