// ─── LinkedIn profile → current employer (name + company URL) ───────────────
// Self-contained, dependency-free port of the Experience-parsing logic in
// content/linkedin/profile-sidebar.js. Exposes `window.__liExperience` so the
// server-dispatched fetch_profile adapter can reverse-engineer the company a
// person currently works at — used by the google_serp discovery path.
//
// window.__liExperience = {
//   ensureLoaded(): Promise<boolean>,           // scroll to lazy-load Experience
//   scrapeCurrentEmployer(): { companyName, companyLinkedinUrl },
// }

(() => {
  if (window.__liExperience) return; // avoid re-injection

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function cleanLinkedInA11yText(text) {
    if (!text) return text || '';
    let t = String(text).trim();
    const m = t.match(/View\s+(.+?)(?:[’'‘`]s\s+(?:verifications|profile)|\s+(?:verifications|profile))/i);
    if (m && m[1]) {
      const inner = m[1].trim().replace(/[‘’'"`]+\s*$/, '').trim();
      if (inner.length >= 2 && inner.length <= 100) return inner;
    }
    t = t.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
    t = t.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
    t = t.replace(/(^|\s)Verified(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
  }

  function looksLikeJunkText(text) {
    if (!text || text.length < 3 || text.length > 400) return true;
    if (/^Status\s+is/i.test(text)) return true;
    if (/^(Home|My Network|Jobs|Messaging|Notifications|Me|Search|Connect|Message|Follow|More)$/i.test(text)) return true;
    if (/^connections?$/i.test(text)) return true;
    if (/^\d+\+?$/.test(text)) return true;
    if (/^Contact info$/i.test(text)) return true;
    if (/^·$/.test(text)) return true;
    if (/^·?\s*\d{1,2}(?:er|e|ème|eme|st|nd|rd|th)\.?\+?$/i.test(text)) return true;
    return false;
  }

  function findExperienceSection() {
    const tagged = [...document.querySelectorAll(
      '[componentkey*="ExperienceTopLevelSection"], [data-testid*="ExperienceTopLevelSection"]',
    )].filter((el) => el.querySelector('[componentkey^="entity-collection-item"], a[href*="/company/"]'));
    if (tagged.length) return tagged[0];

    const legacy = document.getElementById('experience')
      || document.querySelector('section[data-section="experience"]');
    if (legacy) return legacy;

    for (const h of document.querySelectorAll('section h2, section h3')) {
      const t = (h.textContent || '').trim();
      if (/^(exp[ée]rien|experience|berufserfahrung|erfahrung|experiencia|esperienza|ervaring|工作经历|職歴|경력)/i.test(t)) {
        const s = h.closest('section');
        if (s) return s;
      }
    }
    return null;
  }

  function isCurrentDateLine(text) {
    return /\b(present|présent|aujourd['’]hui|à ce jour|en cours|actuel|actualidad|actualmente|heute|attuale|adesso|heden|現在|至今|현재)\b/i.test(text || '');
  }
  function looksLikeDateLine(text) {
    if (!text) return false;
    if (isCurrentDateLine(text)) return true;
    return /\b(19|20)\d{2}\b/.test(text) && /[-–—]/.test(text);
  }

  // Parse every Experience entry into { title, companyName, companyUrl, current }.
  // Current entries float to the top so the topmost = the person's main role now.
  function parseExperience() {
    const sec = findExperienceSection();
    if (!sec) return [];

    const items = [...sec.querySelectorAll('[componentkey^="entity-collection-item"]')];
    const scopes = items.length ? items : [sec];
    const out = [];
    for (const item of scopes) {
      const link = item.querySelector('a[href*="/company/"]');
      const href = link && (link.getAttribute('href') || '');
      const m = href && href.match(/\/company\/([^/?#]+)/i);
      const companyUrl = m ? `https://www.linkedin.com/company/${m[1]}/` : '';

      const lines = [];
      for (const p of item.querySelectorAll('p')) {
        if (p.closest('[data-testid="expandable-text-box"]')) continue;
        const t = (p.innerText || p.textContent || '').trim().replace(/\s+/g, ' ');
        if (t) lines.push(t);
      }
      if (!lines.length && !companyUrl) continue;

      const dateIdx = lines.findIndex(looksLikeDateLine);
      const current = dateIdx >= 0 ? isCurrentDateLine(lines[dateIdx]) : false;

      let title = '';
      let companyName = '';
      if (dateIdx >= 2) {
        title = lines[0];
        companyName = lines[dateIdx - 1].split('·')[0].trim();
      } else if (dateIdx === 1) {
        companyName = lines[0].split('·')[0].trim();
      } else {
        title = lines[0] || '';
        companyName = (lines[1] || '').split('·')[0].trim();
      }

      if (!companyName && link) {
        const badge = link.querySelector('[aria-label], img[alt]');
        const alt = badge && (badge.getAttribute('aria-label') || badge.getAttribute('alt') || '');
        const am = alt && alt.match(/(?:Logo\s+(?:de|of)\s+)?(.+)$/i);
        if (am && am[1]) companyName = am[1].trim();
      }

      companyName = cleanLinkedInA11yText(companyName || '');
      if (companyName.length > 100) companyName = '';
      if (looksLikeJunkText(title) || title.length > 200) title = '';

      out.push({ title, companyName, companyUrl, current, order: out.length });
    }
    out.sort((a, b) => (Number(b.current) - Number(a.current)) || (a.order - b.order));
    return out;
  }

  // The Experience section renders LAZILY — absent on a fresh top-of-page load.
  // Scroll it into view repeatedly to trigger the render, then let the caller
  // scrape. ~4s budget, then give up.
  async function ensureLoaded() {
    if (findExperienceSection()) return true;
    const anchor = () => document.querySelector(
      '[componentkey*="experience_top_anchor"], [componentkey*="ExperienceTopLevelSection"], [data-testid*="ExperienceTopLevelSection"]',
    );
    for (let i = 0; i < 14; i++) {
      const a = anchor();
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'center' });
      else window.scrollTo(0, Math.min(document.body.scrollHeight, (i + 1) * window.innerHeight));
      await wait(300);
      if (findExperienceSection()) { await wait(300); return true; }
    }
    return !!findExperienceSection();
  }

  // Prefer the current experience entry's /company/ link, then any /company/ link.
  function extractCompanyLinkedinUrl() {
    const sec = findExperienceSection();
    const scopes = [sec, document.querySelector('main')].filter(Boolean);
    for (const scope of scopes) {
      const a = scope.querySelector('a[href*="/company/"]');
      const href = a && (a.getAttribute('href') || '');
      const m = href && href.match(/\/company\/([^/?#]+)/i);
      if (m && m[1]) return `https://www.linkedin.com/company/${m[1]}/`;
    }
    return '';
  }

  function scrapeCurrentEmployer() {
    const exp = parseExperience();
    const cur = exp.find((e) => e.current && (e.title || e.companyName)) || exp[0] || null;
    const companyName = (cur && cur.companyName) || '';
    const companyLinkedinUrl = (cur && cur.companyUrl) || extractCompanyLinkedinUrl() || '';
    return { companyName, companyLinkedinUrl };
  }

  window.__liExperience = { ensureLoaded, scrapeCurrentEmployer };
})();
