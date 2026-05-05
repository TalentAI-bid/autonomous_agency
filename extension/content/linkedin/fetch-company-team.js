// ─── LinkedIn: fetch company TEAM adapter ──────────────────────────────────
// Entry point: window.__talentaiRun(params)
// Loads the company's "X employees" people search page and extracts the
// people array ONLY:  { people: [{ name, title, linkedinUrl }] }
// Does NOT scrape the about page — that's the info adapter's job.
//
// Time budget: ~8s (deeper scroll than info; LinkedIn lazy-loads cards).

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    console.log('[TalentAI cs] li/fetch-team start', { href: location.href, linkedinUrl: params?.linkedinUrl });

    // We expect to land on /company/<slug>/. Navigate to the people search.
    const currentUrl = new URL(location.href);
    if (!currentUrl.pathname.includes('/search/results/people')) {
      // Try clicking the "X employees" link first to keep the in-app nav.
      const employeeLink = Array.from(document.querySelectorAll('a'))
        .find((a) => {
          const href = a.getAttribute('href') || '';
          const text = (a.textContent || '').toLowerCase();
          return (href.includes('/search/results/people/') || href.includes('currentCompany'))
            && (text.includes('employee') || text.includes('employé'));
        });
      if (employeeLink) {
        u.safeClick(employeeLink);
      } else {
        // Fallback: derive ?currentCompany URL from /people/ navigation if no
        // anchor was found. Best-effort — LinkedIn often blocks deep links.
        const peopleUrl = currentUrl.origin + currentUrl.pathname.replace(/\/?$/, '/people/');
        location.href = peopleUrl;
      }
      await u.sleep(4000);
    }

    await Promise.race([
      u.waitForSelector('div[data-chameleon-result-urn]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('a[href*="/in/"]', { timeout: 10000 }).catch(() => null),
      u.waitForSelector('main', { timeout: 10000 }),
    ]);

    const RATE_LIMIT_INDICATORS = [
      "you've reached the",
      'you have reached the',
      'rate limit',
      'too many requests',
    ];
    const pageTextLower = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
    if (RATE_LIMIT_INDICATORS.some((t) => pageTextLower.includes(t))) {
      console.log('[TalentAI cs] li/fetch-team rate_limited_429');
      return { debug: { reason: 'rate_limited_429' } };
    }

    // Pre-extraction settle + deep scroll so LinkedIn lazy-loads ALL team
    // cards before we read the DOM. The previous 6×scrollBy(0,900) loop
    // only advanced 5400px — many people pages are 8000px+ tall and we'd
    // miss the bottom half of the listing.
    await u.sleep(u.jitter(2500));
    await u.scrollAndLoad({ scrolls: 8, scrollDelay: 2000, settleDelay: 3000 });

    const cards = document.querySelectorAll('div[data-chameleon-result-urn]');
    const seen = new Set();
    const people = [];

    for (const card of cards) {
      const profileAnchor = findProfileAnchor(card);
      if (!profileAnchor) continue;

      const profileUrl = (profileAnchor.href || '').split('?')[0];
      if (!profileUrl || seen.has(profileUrl)) continue;
      seen.add(profileUrl);

      let pName = extractPersonName(card);
      if (!pName) continue;
      pName = pName.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
      if (!pName) continue;

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
    console.log('[TalentAI cs] li/fetch-team people extracted:', people.length);

    return {
      linkedinUrl: params.linkedinUrl || location.href.split('?')[0],
      people,
    };
  };

  // ─── Helpers (copied from fetch-company.js so each adapter is standalone) ─

  function isValidName(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 150) return false;
    if (/^Status\s+is/i.test(t)) return false;
    if (t === 'LinkedIn Member') return false;
    if (/^View\s+.*profile/i.test(t)) return false;
    if (/View\s+.+?(?:[’'‘`]s\s+profile|\s+profile)/i.test(t)) return false;
    if (/View\b/i.test(t)) return false;
    if (/\bprofile\b/i.test(t)) return false;
    if (/%[0-9A-Fa-f]{2}/.test(t)) return false;
    return true;
  }

  function cleanLinkedInA11yText(text) {
    if (!text) return text;
    let t = text.trim();
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    return t;
  }

  function decodeSlugToName(slug) {
    let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
    try { cleaned = decodeURIComponent(cleaned); } catch (e) { /* ignore */ }
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
    if (profileAnchor) {
      const ariaLabel = profileAnchor.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/View\s+(.+?)(?:'s\s+profile|\s+profile)/i);
      if (match && isValidName(match[1])) return match[1].trim();
    }
    if (profileAnchor) {
      let text = (profileAnchor.textContent || '').trim().replace(/\s+/g, ' ');
      text = text.replace(/\s*•\s*(?:1st|2nd|3rd)(?:\+)?\s*/g, ' ').trim();
      text = text.replace(/Status is (online|offline|away)/gi, '').trim();
      text = cleanLinkedInA11yText(text);
      if (isValidName(text)) return text;
    }
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
})();
