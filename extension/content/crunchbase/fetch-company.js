// ─── Crunchbase: fetch company detail ──────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns a flat company detail object.

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    if (/captcha/i.test(document.title) || document.querySelector('[class*="captcha"], #challenge-running')) {
      return { error: 'crunchbase_auth_required' };
    }

    await Promise.race([
      u.waitForSelector('section.profile-section', { timeout: 12000 }).catch(() => null),
      u.waitForSelector('div.profile-section-container', { timeout: 12000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 12000 }),
    ]);

    const name =
      u.extractText(document, 'profile-header h1') ||
      u.extractText(document, 'span.profile-name') ||
      u.extractText(document, 'h1') ||
      '';

    const description =
      u.extractText(document, 'span.description, description-component') ||
      u.extractText(document, 'p.description');

    const website =
      document.querySelector('a[rel*="nofollow"][href^="http"]')?.getAttribute('href') ||
      document.querySelector('a[href*="website"]')?.getAttribute('href') ||
      '';

    const foundedYear = extractField(['Founded Date', 'Founded']);
    const numEmployees = extractField(['Number of Employees', 'Company Size']);
    const totalFunding = extractField(['Total Funding Amount', 'Total Funding']);
    const lastFundingRound = extractField(['Last Funding Type', 'Last Funding Round']);
    const hqLocation = extractField(['Headquarters Location', 'Headquarters']);

    const categories = Array.from(document.querySelectorAll('chips-container a, a[href*="/hub/"]'))
      .map((a) => (a.textContent || '').trim())
      .filter(Boolean);

    return {
      name,
      crunchbaseUrl: params.crunchbaseUrl || location.href.split('?')[0],
      description,
      website,
      foundedYear,
      numEmployees,
      totalFunding,
      lastFundingRound,
      hqLocation,
      categories: Array.from(new Set(categories)),
    };
  };

  function extractField(labels) {
    // Crunchbase renders label-value pairs inside <field-formatter> or <li class="fields-card_field">
    const rows = document.querySelectorAll('field-formatter, li.fields-card_field, label-with-info, div.field-type');
    for (const row of rows) {
      const labelEl = row.querySelector('label, .field-label, dt');
      const label = (labelEl?.textContent || '').trim();
      if (!label) continue;
      if (labels.some((l) => label.toLowerCase().startsWith(l.toLowerCase()))) {
        const valEl = row.querySelector('a, span, dd, .field-value');
        if (valEl) return (valEl.textContent || '').trim().replace(/\s+/g, ' ');
      }
    }
    return '';
  }
})();
