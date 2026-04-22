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

    // 429 / rate-limit page detection
    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    const isRateLimited = RATE_LIMIT_INDICATORS.some((t) => pageTextLower.includes(t));
    if (isRateLimited) {
      console.log('[TalentAI cs] li/fetch rate_limited_429');
      return {
        debug: { reason: 'rate_limited_429' },
      };
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

    // ─── People/Team extraction (best-effort) ─────────────────────────────
    // LinkedIn's "X employees" link navigates to a people search page at
    // /search/results/people/?currentCompany=[ID]. This uses the same card
    // structure as company search (div[data-chameleon-result-urn]).
    let people = [];
    try {
      const employeeLink = Array.from(document.querySelectorAll('a'))
        .find((a) => {
          const href = a.getAttribute('href') || '';
          const text = (a.textContent || '').toLowerCase();
          return (href.includes('/search/results/people/') || href.includes('currentCompany'))
            && (text.includes('employee') || text.includes('employé'));
        });

      if (employeeLink) {
        u.safeClick(employeeLink);
        await u.sleep(4000);

        // Wait for people search result cards
        await Promise.race([
          u.waitForSelector('div[data-chameleon-result-urn]', { timeout: 10000 }).catch(() => null),
          u.waitForSelector('a[href*="/in/"]', { timeout: 10000 }).catch(() => null),
        ]);

        // Scroll to load more
        for (let i = 0; i < 3; i++) {
          window.scrollBy(0, 600);
          await u.sleep(800);
        }

        const cards = document.querySelectorAll('div[data-chameleon-result-urn]');
        const seen = new Set();

        for (const card of cards) {
          // Get the name anchor — skip logo/hidden anchors
          const allAnchors = card.querySelectorAll('a[href*="/in/"]');
          let nameAnchor = null;
          for (const a of allAnchors) {
            const text = (a.textContent || '').trim();
            if (text.length > 2 && a.getAttribute('aria-hidden') !== 'true' && !text.startsWith('View')) {
              nameAnchor = a;
              break;
            }
          }
          if (!nameAnchor) continue;

          const profileUrl = (nameAnchor.href || '').split('?')[0];
          if (seen.has(profileUrl)) continue;
          seen.add(profileUrl);

          // Clean name — remove emojis
          let pName = (nameAnchor.textContent || '').trim().replace(/\s+/g, ' ');
          pName = pName.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
          if (!pName || pName.length < 2 || pName === 'LinkedIn Member') continue;

          // Extract title — skip name duplicates, connection-degree text, and
          // screen-reader-only status labels ("Status is online/offline") that
          // LinkedIn injects as <span class="visually-hidden"> next to the avatar.
          const SKIP = /degree connection|View.*profile|3rd\+|2nd|1st|\bprofile\b|status is (online|offline)|^(message|follow|connect)$/i;

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

          let title = '';
          for (const t of allText) {
            if (t.includes(pName)) continue;
            if (SKIP.test(t)) continue;
            if (t.startsWith('•')) continue;
            title = t;
            break;
          }

          people.push({ name: pName, title, linkedinUrl: profileUrl });
        }
        console.log('[TalentAI cs] li/fetch people extracted:', people.length);
      } else {
        console.log('[TalentAI cs] li/fetch no employee link found');
      }
    } catch (err) {
      console.warn('[TalentAI cs] li/fetch people extraction failed:', err);
    }

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
      people,
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
