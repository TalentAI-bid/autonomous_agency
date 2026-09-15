// ─── Google web-search (SERP) scraping core ─────────────────────────────────
// Self-contained module: waits for the results, harvests organic result links
// (title + url + snippet), unwraps Google redirect links, and detects the
// CAPTCHA / "unusual traffic" interstitial. Exposes `window.__googleCore`.
// Deliberately dependency-free (like maps-core.js) so it can be cloned into a
// standalone project.
//
// Result = { url: string, title: string, snippet: string, position: number }
// Return shape: { results: Result[] }  — or { results: [], debug: { reason } }.

(() => {
  if (window.__googleCore) return; // avoid re-injection (static + dynamic paths)

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function jitter(ms, fraction = 0.3) {
    return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * fraction * ms));
  }

  function waitForSelector(selector, { timeout = 12000, root = document } = {}) {
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`waitForSelector timeout: ${selector}`));
      }, timeout);
    });
  }

  function extractText(el, selector) {
    if (!el) return '';
    const target = selector ? el.querySelector(selector) : el;
    if (!target) return '';
    return (target.textContent ?? '').trim().replace(/\s+/g, ' ');
  }

  // ── Page predicates / guards ───────────────────────────────────────────────

  function guardHost() {
    return /(^|\.)google\.[a-z.]+$/i.test(location.hostname || '');
  }

  // Google serves a CAPTCHA / "unusual traffic" interstitial (usually on the
  // /sorry/ path) when it detects automation. Signal it so the dispatcher
  // re-pends the task and the user solves it — same contract as LinkedIn 429s.
  function looksBlocked() {
    if (/\/sorry\/?/i.test(location.pathname)) return true;
    if (document.querySelector('form#captcha-form, div.g-recaptcha, iframe[src*="recaptcha"]')) return true;
    const bodyTxt = (document.body?.innerText || '').toLowerCase();
    return bodyTxt.includes('unusual traffic') || bodyTxt.includes("we're sorry") || bodyTxt.includes('not a robot');
  }

  // Google sometimes wraps result links as /url?q=<real>&sa=… — unwrap to the
  // real destination. Same idea as agentcore's unwrapGoogleRedirect.
  function unwrapGoogleRedirect(href) {
    try {
      const u = new URL(href, location.href);
      if (u.pathname === '/url') {
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) return q;
      }
      return u.toString();
    } catch (_) {
      return href;
    }
  }

  // Drop Google's own chrome (search/preferences/maps/cache/accounts links).
  function isJunkUrl(u) {
    if (!u || u.startsWith('#') || u.startsWith('javascript:')) return true;
    if (/google\.[a-z.]+\/(search|preferences|advanced_search|imgres|maps|intl|setprefs)/i.test(u)) return true;
    if (/(webcache\.googleusercontent|translate\.google|accounts\.google|policies\.google|support\.google|google\.com\/imgres)/i.test(u)) return true;
    return false;
  }

  // ── Scrape ───────────────────────────────────────────────────────────────

  async function scrapeSerp({ limit = 30 } = {}) {
    if (!guardHost()) {
      return { results: [], debug: { reason: 'non_google_host', host: location.hostname, href: location.href } };
    }
    if (looksBlocked()) return { results: [], debug: { reason: 'blocked_by_popup' } };

    // Wait for the results column. #search/#rso are the organic container;
    // #botstuff exists even on empty result pages so we don't hang forever.
    try {
      await waitForSelector('#search, #rso, #botstuff', { timeout: 12000 });
    } catch (_) {
      // fall through — extract whatever is present
    }
    if (looksBlocked()) return { results: [], debug: { reason: 'blocked_by_popup' } };

    // Light scroll to trigger any lazy-rendered results.
    for (let i = 0; i < 2; i++) {
      window.scrollBy(0, document.body.scrollHeight);
      await sleep(jitter(600));
    }

    const seen = new Set();
    const results = [];
    // Each organic result is an <a> that wraps an <h3> title. Class names churn
    // constantly, so anchor-wraps-h3 is the stable structural selector.
    const heads = document.querySelectorAll('#search a h3, #rso a h3');
    for (const h3 of heads) {
      if (results.length >= limit) break;
      const anchor = h3.closest('a[href]');
      if (!anchor) continue;
      const url = unwrapGoogleRedirect(anchor.getAttribute('href') || '');
      if (isJunkUrl(url) || seen.has(url)) continue;
      seen.add(url);
      const container = anchor.closest('div.g') || anchor.closest('div[data-hveid]') || anchor.parentElement;
      const snippet = container ? extractText(container, 'div[data-sncf], .VwiC3b, .yXK7lf, span.aCOpRe') : '';
      results.push({
        url,
        title: (h3.textContent || '').trim().replace(/\s+/g, ' '),
        snippet,
        position: results.length + 1,
      });
    }

    return { results };
  }

  window.__googleCore = { scrapeSerp, guardHost, looksBlocked };
})();
