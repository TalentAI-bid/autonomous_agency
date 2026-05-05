// ─── LinkedIn: fetch company INFO adapter ──────────────────────────────────
// Entry point: window.__talentaiRun(params)
// Loads /company/<slug>/about and extracts the about-page fields ONLY:
//   { name, website, industry, size, headquarters, founded, companyType,
//     description, specialties[], logoUrl, currentEmployees }
// Does NOT navigate to /people/ — that's the team adapter's job.
//
// Time budget: ~5s. Sibling adapter fetch-company-team.js handles the team
// scrape in parallel; one failure does not block the other.

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    console.log('[TalentAI cs] li/fetch-info start', { href: location.href, linkedinUrl: params?.linkedinUrl });
    const currentUrl = new URL(location.href);
    if (!currentUrl.pathname.includes('/about')) {
      const aboutUrl = currentUrl.origin + currentUrl.pathname.replace(/\/?$/, '/about/');
      const aboutLink = Array.from(document.querySelectorAll('a'))
        .find((a) => (a.getAttribute('href') || '').includes('/about'));
      if (aboutLink) {
        u.safeClick(aboutLink);
      } else {
        location.href = aboutUrl;
      }
      await u.sleep(3000);
    }

    await Promise.race([
      u.waitForSelector('.org-grid__content-height-enforcer', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('.org-about-company-module__company-details', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

    // Pre-extraction settle. About-page descriptions are clipped and
    // expanded by lazy "Show more" controls. Round 11 dial-back: 2 scrolls
    // is enough to reach the company-details DT/DD list and trigger the
    // expander.
    await u.sleep(u.jitter(1500));
    await u.scrollAndLoad({ scrolls: 2, scrollDelay: 1000, settleDelay: 1000 });

    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    if (RATE_LIMIT_INDICATORS.some((t) => pageTextLower.includes(t))) {
      console.log('[TalentAI cs] li/fetch-info rate_limited_429');
      return { debug: { reason: 'rate_limited_429' } };
    }

    const name =
      u.extractText(document, 'h1.org-top-card-summary__title') ||
      u.extractText(document, 'h1') ||
      '';
    const website = findDetail(['Website', 'Site Web']);
    const industry = findDetail(['Industry', 'Secteur']);
    const size = findDetail(['Company size', 'Taille']);
    const headquarters = findDetail(['Headquarters', 'Siège']);
    const founded = findDetail(['Founded', 'Fondée']);
    const type = findDetail(['Company type', 'Type']);
    const specialtiesStr = findDetail(['Specialties', 'Spécialités']);
    const description =
      u.extractText(document, '.org-about-us-organization-description__text') ||
      u.extractText(document, '.org-about-company-module__description') ||
      u.extractText(document, 'p.break-words');

    const logo = document.querySelector('img.org-top-card-primary-content__logo, img.ivm-view-attr__img--centered');
    const logoUrl = logo?.getAttribute('src') || '';

    const empLink = Array.from(document.querySelectorAll('a'))
      .find((a) => /employee/i.test((a.textContent || '')));
    const employeeCountMatch = (empLink?.textContent || '').match(/([\d,]+)\s*employee/i);
    const currentEmployees = employeeCountMatch ? parseInt(employeeCountMatch[1].replace(/,/g, ''), 10) : null;

    console.log('[TalentAI cs] li/fetch-info extracted', { name, website, industry, size, headquarters, hasDescription: !!description, currentEmployees });

    return {
      name,
      linkedinUrl: params.linkedinUrl || location.href.split('?')[0],
      website,
      industry,
      size,
      headquarters,
      description,
      specialties: specialtiesStr ? specialtiesStr.split(/,\s*/).filter(Boolean) : [],
      founded,
      companyType: type,
      logoUrl,
      currentEmployees,
    };
  };

  function findDetail(labels) {
    const dts = document.querySelectorAll('dt');
    for (const dt of dts) {
      const label = (dt.textContent || '').trim();
      if (labels.some((l) => label.toLowerCase().startsWith(l.toLowerCase()))) {
        const dd = dt.nextElementSibling;
        if (dd) return (dd.textContent || '').trim().replace(/\s+/g, ' ');
      }
    }
    const h3s = document.querySelectorAll('h3, h4');
    for (const h of h3s) {
      const label = (h.textContent || '').trim();
      if (labels.some((l) => label.toLowerCase().startsWith(l.toLowerCase()))) {
        const sib = h.nextElementSibling;
        if (sib) return (sib.textContent || '').trim().replace(/\s+/g, ' ');
      }
    }
    return '';
  }
})();
