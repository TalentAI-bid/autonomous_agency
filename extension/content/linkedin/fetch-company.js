// ─── LinkedIn: fetch company detail adapter ────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns a flat company detail object.

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    console.log('[TalentAI cs] li/fetch start', { href: location.href, linkedinUrl: params?.linkedinUrl });
    // Expect we're already on /company/<slug>/. Navigate to /about/ for fuller detail.
    const currentUrl = new URL(location.href);
    if (!currentUrl.pathname.includes('/about')) {
      const aboutUrl = currentUrl.origin + currentUrl.pathname.replace(/\/?$/, '/about/');
      // Soft navigate: try to click About tab first (avoids full reload)
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
    console.log('[TalentAI cs] li/fetch container_ready', { title: document.title, url: location.href });

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

    // Employee count link ("X employees on LinkedIn")
    const empLink = Array.from(document.querySelectorAll('a'))
      .find((a) => /employee/i.test((a.textContent || '')));
    const employeeCountMatch = (empLink?.textContent || '').match(/([\d,]+)\s*employee/i);
    const currentEmployees = employeeCountMatch ? parseInt(employeeCountMatch[1].replace(/,/g, ''), 10) : null;

    console.log('[TalentAI cs] li/fetch extracted', {
      name,
      website,
      industry,
      size,
      headquarters,
      hasDescription: !!description,
      currentEmployees,
    });

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
    // LinkedIn renders "<dt>Label</dt><dd>Value</dd>" or "<h3>Label</h3><p>Value</p>" etc.
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
