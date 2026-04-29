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

        // Scroll deep so LinkedIn lazy-loads more team cards before we
        // extract. We rank-and-cap server-side, so giving the ranker more
        // raw candidates yields better top-N decision-makers.
        for (let i = 0; i < 6; i++) {
          window.scrollBy(0, 900);
          await u.sleep(800);
        }

        const cards = document.querySelectorAll('div[data-chameleon-result-urn]');
        const seen = new Set();

        for (const card of cards) {
          const profileAnchor = findProfileAnchor(card);
          if (!profileAnchor) continue;

          const profileUrl = (profileAnchor.href || '').split('?')[0];
          if (!profileUrl || seen.has(profileUrl)) continue;
          seen.add(profileUrl);

          let pName = extractPersonName(card);
          if (!pName) {
            console.log('[TalentAI cs] li/fetch skipped person — no valid name extracted', { profileUrl });
            continue;
          }
          // Strip emojis from final name
          pName = pName.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
          if (!pName) continue;

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

  // ─── Name extraction helpers ──────────────────────────────────────────────
  // LinkedIn renders people cards with the visible text often showing only a
  // first name (e.g. "Laura"), while the full name lives in the anchor's
  // aria-label ("View Laura Dijokiene's profile") or a visually-hidden span.
  // Fall back to the URL slug, properly URL-decoded, for non-Latin characters.

  function isValidName(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 150) return false;
    if (/^Status\s+is/i.test(t)) return false;
    if (t === 'LinkedIn Member') return false;
    if (/^View\s+.*profile/i.test(t)) return false;
    // Reject anything still containing the screen-reader "View ... profile"
    // suffix anywhere in the string (catches concatenated "NameView Name's profile").
    // Accepts straight + curly apostrophes — LinkedIn renders U+2019.
    if (/View\s+.+?(?:[’'‘`]s\s+profile|\s+profile)/i.test(t)) return false;
    // Reject any residual "View" — `\b` after View matches both standalone
    // " View …" and concatenated "SeveroView" (boundary at end of word).
    if (/View\b/i.test(t)) return false;
    if (/\bprofile\b/i.test(t)) return false;
    if (/%[0-9A-Fa-f]{2}/.test(t)) return false; // URL-encoded residue
    return true;
  }

  // LinkedIn renders <a> with both visible name + a screen-reader span like
  // "View Saurabh Kaushik's profile". textContent concatenates the two with no
  // whitespace, yielding strings like "Saurabh KaushikView Saurabh Kaushik's profile".
  // This helper extracts the full NAME from inside that pattern, or strips the
  // suffix when only a prefix is the real name.
  function cleanLinkedInA11yText(text) {
    if (!text) return text;
    let t = text.trim();
    // Pattern A: "View NAME('s) profile" embedded → return NAME (it's the full name).
    // Accept straight, curly, and backtick apostrophes — LinkedIn renders U+2019.
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    // Pattern B: trailing "...View NAME profile" with no clean inner match → strip.
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    // Pattern C: bare concatenation residue (e.g. "SeveroView") with no
    // trailing " profile" — strip "View" onwards when it follows a letter.
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    return t;
  }

  function decodeSlugToName(slug) {
    // Strip trailing LinkedIn hash suffix (e.g. '-94b897255', '-1a64053b9')
    let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch (e) {
      // leave as-is if decode fails
    }
    const name = cleaned
      .split('-')
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return name || null;
  }

  function findProfileAnchor(card) {
    const anchors = card.querySelectorAll('a[href*="/in/"]');
    for (const a of anchors) {
      const text = (a.textContent || '').trim();
      if (/^Status\s+is/i.test(text)) continue;
      if (a.getAttribute('aria-hidden') === 'true') continue;
      return a;
    }
    return anchors[0] || null;
  }

  function extractPersonName(card) {
    // Priority 1: full name from visually-hidden a11y span. Prefer the
    // aria-label attribute when the matched element exposes one, since
    // textContent of these spans is often the verbose "View NAME's profile".
    const hiddenSpan = card.querySelector(
      '.visually-hidden, .a11y-text, [class*="sr-only"], span[aria-label]',
    );
    if (hiddenSpan) {
      const ariaLabel = hiddenSpan.getAttribute && hiddenSpan.getAttribute('aria-label');
      if (ariaLabel) {
        const cleaned = cleanLinkedInA11yText(ariaLabel.trim());
        if (isValidName(cleaned)) return cleaned;
      }
      const text = (hiddenSpan.textContent || '').trim();
      const cleanedText = cleanLinkedInA11yText(text);
      if (isValidName(cleanedText)) return cleanedText;
    }

    const profileAnchor = findProfileAnchor(card);

    // Priority 2: anchor aria-label ("View NAME's profile")
    if (profileAnchor) {
      const ariaLabel = profileAnchor.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/View\s+(.+?)(?:'s\s+profile|\s+profile)/i);
      if (match && isValidName(match[1])) {
        return match[1].trim();
      }
    }

    // Priority 3: anchor textContent, cleaned of presence badges / degree
    // and the embedded "View NAME's profile" screen-reader-only string.
    if (profileAnchor) {
      let text = (profileAnchor.textContent || '').trim().replace(/\s+/g, ' ');
      text = text.replace(/\s*•\s*(?:1st|2nd|3rd)(?:\+)?\s*/g, ' ').trim();
      text = text.replace(/Status is (online|offline|away)/gi, '').trim();
      text = cleanLinkedInA11yText(text);
      if (isValidName(text)) return text;
    }

    // Priority 4: URL slug, URL-decoded and title-cased
    if (profileAnchor) {
      const href = profileAnchor.getAttribute('href') || '';
      const slugMatch = href.match(/\/in\/([^\/?#]+)/);
      if (slugMatch) {
        const decoded = decodeSlugToName(slugMatch[1]);
        if (isValidName(decoded)) return decoded;
      }
    }

    return null;
  }

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
