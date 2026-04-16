// ─── Crunchbase: search companies ──────────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns { companies: [...] }

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const limit = Math.min(30, params.limit || 10);

    // Detect auth/captcha wall early (common for non-paid/non-logged users).
    if (/captcha/i.test(document.title) || document.querySelector('[class*="captcha"], #challenge-running')) {
      return { companies: [], error: 'crunchbase_auth_required' };
    }

    const grid = await Promise.race([
      u.waitForSelector('grid-row', { timeout: 12000 }).catch(() => null),
      u.waitForSelector('div.grid-body', { timeout: 12000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 12000 }).catch(() => null),
    ]);

    if (!grid) throw new Error('crunchbase_grid_missing');

    await u.scrollToBottom({ steps: 4, delayMs: 800 });

    const rows = Array.from(document.querySelectorAll('grid-row, div.grid-row'));
    const companies = [];

    for (const row of rows.slice(0, limit)) {
      const nameAnchor = row.querySelector('a[href*="/organization/"]');
      if (!nameAnchor) continue;
      const crunchbaseUrl = u.absoluteUrl(nameAnchor.getAttribute('href') || '').split('?')[0];
      const name = (nameAnchor.textContent || '').trim();
      if (!name) continue;

      const description = u.extractText(row, 'span.field-formatter') || u.extractText(row, '.description');
      const categories = Array.from(row.querySelectorAll('chips-container a, span.tag a'))
        .map((a) => (a.textContent || '').trim())
        .filter(Boolean);
      const location = u.extractText(row, 'a[href*="/search/"][href*="location_identifiers"]');

      companies.push({ name, crunchbaseUrl, description, categories, location });
    }

    return { companies };
  };
})();
