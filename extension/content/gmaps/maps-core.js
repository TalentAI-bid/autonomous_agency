// ─── Google Maps scraping core ──────────────────────────────────────────────
// Self-contained module: extraction + feed pagination + normalized records.
// Exposes `window.__mapsCore`. Deliberately has ZERO dependencies on the rest
// of the extension (no __talentaiUtils, no service-worker conventions) so it
// can be copied verbatim into a standalone Google-Maps-only project.
//
// BusinessRecord = {
//   name: string,            // required
//   category: string,        // '' if missing
//   address: string,         // '' if missing
//   phone: string|null,      // place-detail pages only
//   website: string|null,
//   rating: number|null,
//   reviewCount: number|null,
//   mapsUrl: string,         // canonical place URL — stable dedup key
//   location: string,        // search location context (caller-supplied)
// }

(() => {
  if (window.__mapsCore) return; // avoid re-injection (static + dynamic paths)

  // ── Minimal DOM helpers (intentionally duplicated from the host app) ──────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function jitter(ms, fraction = 0.3) {
    return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * fraction * ms));
  }

  function waitForSelector(selector, { timeout = 15000, root = document } = {}) {
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

  async function scrollContainer(el, { steps = 3, delayMs = 900 } = {}) {
    if (!el) return;
    for (let i = 0; i < steps; i++) {
      const prev = el.scrollTop;
      el.scrollBy(0, Math.max(400, el.clientHeight * 0.9));
      await sleep(jitter(delayMs));
      if (el.scrollTop === prev) break; // reached bottom
    }
  }

  function extractText(el, selector) {
    if (!el) return '';
    const target = selector ? el.querySelector(selector) : el;
    if (!target) return '';
    return (target.textContent ?? '').trim().replace(/\s+/g, ' ');
  }

  function absoluteUrl(href) {
    if (!href) return '';
    try { return new URL(href, location.href).toString(); } catch (_) { return href; }
  }

  // Locale-robust rating parse: Maps renders the decimal as a comma in many
  // locales (FR "4,5"), which parseFloat truncates to 4. Normalize first.
  function parseRating(txt) {
    if (!txt) return null;
    const r = parseFloat(String(txt).trim().replace(',', '.'));
    return Number.isFinite(r) ? r : null;
  }

  // ── Page predicates / guards ───────────────────────────────────────────────

  function guardHost() {
    return /(^|\.)google\.[a-z.]+$/i.test(location.hostname || '');
  }

  function isMapsSearchPage() {
    if (!guardHost()) return false;
    return location.pathname.startsWith('/maps/search') || !!getFeedEl();
  }

  function isMapsPlacePage() {
    if (!guardHost()) return false;
    return location.pathname.startsWith('/maps/place');
  }

  function getFeedEl() {
    return (
      document.querySelector('div[role="feed"]') ||
      document.querySelector('div[aria-label*="Results"]')
    );
  }

  // ── Extraction ─────────────────────────────────────────────────────────────

  function extractCard(anchor, { location: locationCtx = '' } = {}) {
    const mapsUrl = absoluteUrl(anchor.getAttribute('href') || '').split('?')[0];
    if (!mapsUrl) return null;

    // Walk up to the row/card container
    const card = anchor.closest('[role="article"]') || anchor.closest('div[jsaction]') || anchor.parentElement;
    if (!card) return null;

    const name = extractText(anchor, '[role="heading"]') || extractText(anchor) || (() => {
      // Last-ditch: derive from URL
      const m = mapsUrl.match(/\/place\/([^/]+)\//);
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    })();
    if (!name) return null;

    const ratingNode = card.querySelector('span.MW4etd, span[aria-label*="stars"]');
    const reviewsNode = card.querySelector('span.UY7F9, span[aria-label*="reviews"]');
    const ratingNodeTxt = ratingNode ? (ratingNode.textContent || '').trim() : '';
    const rating = parseRating(ratingNodeTxt);
    const reviewsTxt = reviewsNode ? (reviewsNode.textContent || '').replace(/[^\d]/g, '') : '';
    const reviewCount = reviewsTxt ? parseInt(reviewsTxt, 10) : null;

    // Category + address live in comma/middot-separated rows. The first
    // .W4Efsd row is usually the rating/price line ("4,5(17 235) · + de 200 SAR")
    // — locale-independent: skip any block that opens with a rating pattern or
    // duplicates the rating node text, then read category/address from the first
    // remaining block that has a "·" separator. Fail-empty, never fabricate.
    const infoBlocks = Array.from(card.querySelectorAll('.W4Efsd'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t && !/^\d[.,]\d/.test(t) && (!ratingNodeTxt || !t.startsWith(ratingNodeTxt)));
    const infoRow = infoBlocks.find((t) => t.includes('·')) || '';
    let category = '';
    let address = '';
    if (infoRow) {
      const segs = infoRow.split('·').map((s) => s.trim()).filter(Boolean);
      category = segs[0] || '';
      // Drop the price segment ("+ de 200 SAR", "$$", "€€") so it isn't mistaken
      // for the address — then prefer a digit-bearing (street-number) segment.
      const isPrice = (s) => /[$€£¥₹]|\b(?:SAR|USD|EUR|AED|GBP|QAR|AUD)\b|\bde\s+\d/i.test(s) || /^[$€]+$/.test(s);
      const rest = segs.slice(1);
      const addrCandidates = rest.filter((s) => !isPrice(s));
      address = addrCandidates.find((s) => /\d/.test(s))
        || addrCandidates.sort((a, b) => b.length - a.length)[0]
        || rest.find((s) => /\d/.test(s))
        || '';
    } else if (infoBlocks.length) {
      category = infoBlocks[0].split('·')[0].trim();
    }

    const websiteAnchor = card.querySelector('a[data-value="Website"], a[aria-label*="Website"]');
    const website = websiteAnchor?.getAttribute('href') || null;

    return {
      name,
      category,
      address,
      phone: null, // not rendered on search cards; place pages only
      website,
      rating,
      reviewCount,
      mapsUrl,
      location: locationCtx,
    };
  }

  // Extract all currently-rendered search cards. No scrolling.
  function extractLoaded({ location: locationCtx = '' } = {}) {
    if (!guardHost()) return [];
    const feed = getFeedEl();
    if (!feed) return [];

    const seen = new Set();
    const businesses = [];
    for (const a of feed.querySelectorAll('a[href*="/maps/place/"]')) {
      const record = extractCard(a, { location: locationCtx });
      if (!record || seen.has(record.mapsUrl)) continue;
      seen.add(record.mapsUrl);
      businesses.push(record);
    }
    return businesses;
  }

  // Scroll the results feed one increment to lazy-load more cards.
  // Returns { count, atEnd } — atEnd when the card count stopped growing.
  async function loadMore(feedEl, { steps = 3, delayMs = 900 } = {}) {
    if (!guardHost()) return { count: 0, atEnd: true };
    const feed = feedEl || getFeedEl();
    if (!feed) return { count: 0, atEnd: true };

    const before = feed.querySelectorAll('a[href*="/maps/place/"]').length;
    await scrollContainer(feed, { steps, delayMs });
    await sleep(jitter(600));
    const count = feed.querySelectorAll('a[href*="/maps/place/"]').length;
    return { count, atEnd: count === before };
  }

  // Full search run: wait for feed, scroll until limit/end, extract.
  async function scrapeSearch({ limit = 20, location: locationCtx = '' } = {}) {
    if (!guardHost()) {
      return { businesses: [], debug: { reason: 'non_gmaps_host', host: location.hostname, href: location.href } };
    }
    const max = Math.min(100, limit || 20);

    const feed = await waitForSelector('div[role="feed"], div[aria-label*="Results"]', { timeout: 15000 })
      .catch(() => null);
    if (!feed) throw new Error('gmaps_no_results_feed');

    // Scroll until we've loaded >= max results or the feed stops growing.
    let stableIterations = 0;
    for (let i = 0; i < 20; i++) {
      const { count, atEnd } = await loadMore(feed);
      if (count >= max) break;
      if (atEnd) {
        stableIterations++;
        if (stableIterations >= 3) break; // reached the end
      } else {
        stableIterations = 0;
      }
    }

    const businesses = extractLoaded({ location: locationCtx }).slice(0, max);
    return { businesses };
  }

  // Place-detail run: extract a single record from a /maps/place/ page.
  async function scrapePlace({ mapsUrl = '' } = {}) {
    if (!guardHost()) {
      return { debug: { reason: 'non_gmaps_host', host: location.hostname, href: location.href } };
    }

    await Promise.race([
      waitForSelector('h1.DUwDvf', { timeout: 15000 }).catch(() => null),
      waitForSelector('div[role="main"]', { timeout: 15000 }).catch(() => null),
    ]);

    // The info rows (address/phone/website via data-item-id, the hours table,
    // the price/reviews/about regions) hydrate a beat AFTER the title node, so a
    // synchronous read here returns empty. Wait (bounded) for ANY data-item-id
    // node — a locale-independent anchor for the info section — then settle so
    // sibling rows in the same render batch land. Fail-safe: never hang.
    await waitForSelector('button[data-item-id], a[data-item-id]', { timeout: 6000 }).catch(() => null);
    await sleep(jitter(600));

    const name = extractText(document, 'h1.DUwDvf') || extractText(document, 'h1');

    const ratingTxt = extractText(document, 'div.F7nice span[aria-hidden="true"]') || extractText(document, 'span.ceNzKf');
    const reviewsTxt = extractText(document, 'div.F7nice button[aria-label*="reviews"]') || extractText(document, 'button[jsaction*="reviewChart"]');
    const rating = parseRating(ratingTxt);
    const reviewCount = reviewsTxt ? parseInt(reviewsTxt.replace(/[^\d]/g, ''), 10) || null : null;

    const category = extractText(document, 'button[jsaction*="category"]')
      || extractText(document, '.DkEaL')
      || '';
    const address = findByDataItemId('address');
    const phone = findByDataItemId('phone:tel:') || null;
    const website = findByDataItemId('authority') || null; // Google tags website rows as "authority"
    const hours = await extractHours();
    const plusCode = findByDataItemId('oloc') || '';
    const coordinates = parseCoordinates(mapsUrl);
    const reviews = await extractReviewsHtml();
    const aboutHtml = await extractAboutHtml();

    return {
      name,
      category,
      address,
      phone,
      website,
      rating,
      reviewCount,
      mapsUrl: mapsUrl || location.href.split('?')[0],
      location: '',
      // ── Full place-detail enrichment (best-effort, fail-empty) ──
      hours,
      priceLevel: extractPriceLevel(),
      pricePerPerson: extractPricePerPerson(),
      directionsUrl: extractDirectionsUrl(coordinates),
      description: extractDescription(),
      serviceOptions: extractServiceOptions(),
      plusCode,
      coordinates,
      menuLink: extractMenuLink(),
      photoUrls: extractPhotos(),
      // ── Locale-bearing prose captured as raw HTML (client browser language) ──
      reviewsHtml: reviews.reviewsHtml,
      ratingDistribution: reviews.ratingDistribution,
      aboutHtml,
    };
  }

  // Weekly opening hours. Prefer the day→times table (returns a {day: hours}
  // map); fall back to the hours toggle's aria-label (a single string that, in
  // most locales, already lists the whole week). Fail-empty, never fabricate.
  async function extractHours() {
    try {
      // The weekly table lazy-loads on some places — expand the hours dropdown
      // (locale-independent jsaction hook) if the table isn't already in the DOM.
      if (!document.querySelector('table.eK4R0e')) {
        const toggle = document.querySelector('[jsaction*="openhours"]');
        if (toggle) {
          try { toggle.click(); } catch (_) { /* ignore */ }
          await waitForSelector('table.eK4R0e', { timeout: 2500 }).catch(() => null);
        }
      }
      const table = document.querySelector('table.eK4R0e, div[aria-label*="hours" i] table, div[aria-label*="Hours" i] table');
      if (table) {
        const map = {};
        for (const row of table.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td, th');
          if (cells.length < 2) continue;
          const day = (cells[0].textContent || '').trim();
          const times = (cells[1].getAttribute('aria-label') || cells[1].textContent || '')
            .trim().replace(/\s+/g, ' ');
          if (day && times) map[day] = times;
        }
        if (Object.keys(map).length) return map;
      }
    } catch (_) { /* fall through to string form */ }
    // data-item-id="oh" is an unreliable fallback (can grab "…Voir plus d'horaires").
    // Only keep it if it actually looks like hours (contains a digit).
    const oh = findByDataItemId('oh');
    return /\d/.test(oh) ? oh : '';
  }

  // "$$", "€€", "$10–20" — currency-symbol/range chip. Locale-independent: the
  // aria-label "Price"/"Prix" matching is dropped (the client's browser may be
  // in Arabic). The worded "+ de 200 SAR / + من ٢٠٠ ريال" form is read
  // structurally by extractPricePerPerson instead.
  function extractPriceLevel() {
    for (const s of document.querySelectorAll('span, .mgr77e')) {
      const t = (s.textContent || '').trim();
      if (/^[$€£¥₩]{1,4}$/.test(t)) return t;
      if (t.length <= 14 && /^[$€£¥]\s?\d[\d.,]*\s*[–-]\s*[$€£¥]?\d/.test(t)) return t;
    }
    return '';
  }

  // "+ de 200 SAR par personne" (price-per-person). Structural only: the chip
  // lives in div[jsname="tJHJj"]; its first text node is the price line, the
  // child div.BfVpR is the "reported by N people" note (excluded). Header
  // span.mgr77e is the fallback. Locale-bearing text is kept raw on purpose.
  function extractPricePerPerson() {
    const block = document.querySelector('div[jsname="tJHJj"]');
    if (block) {
      const t = (block.childNodes[0]?.textContent || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 60) return t;
    }
    const chip = document.querySelector('span.mgr77e');
    // The header chip is preceded by a "·" separator in the DOM — strip any
    // leading separators/whitespace so we don't store "·+ de 200 SAR".
    const c = (chip?.textContent || '').trim().replace(/^[\s·•|]+/, '').replace(/\s+/g, ' ').trim();
    return c && c.length <= 60 ? c : '';
  }

  // Stable Google Maps directions URL, derived from coordinates (no DOM read,
  // no locale). The "Itinéraires" button itself carries no usable href.
  function extractDirectionsUrl(coords) {
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
      return `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`;
    }
    return '';
  }

  // ── Raw-HTML capture (locale-bearing prose: reviews + about/attributes) ────
  // The client's Chrome renders these in its own language (Arabic). We store
  // bounded, sanitized raw HTML so the original language is preserved and the
  // backend can translate/re-render later — never parse to a locale string.

  function capTotal(s, maxLen) {
    if (typeof s !== 'string') return '';
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function sanitizeAndCap(node, maxLen) {
    if (!node) return '';
    try {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, iframe, link, meta').forEach((n) => n.remove());
      for (const el of clone.querySelectorAll('*')) {
        for (const attr of Array.from(el.attributes)) {
          const an = attr.name.toLowerCase();
          if (an.startsWith('on')) el.removeAttribute(attr.name);
          if ((an === 'href' || an === 'src') && /^\s*javascript:/i.test(attr.value)) {
            el.removeAttribute(attr.name);
          }
        }
      }
      return capTotal(clone.outerHTML || '', maxLen);
    } catch (_) {
      return '';
    }
  }

  // Reviews as raw HTML (+ the rating-distribution rows). Reviews are div.jftiEf
  // (~3 render by default); scroll the in-place container to load ~12 — scroll
  // only, never click the reviews tab (that changes the URL/panel and steals
  // focus). Fail-empty throughout.
  async function extractReviewsHtml() {
    const out = { reviewsHtml: '', ratingDistribution: [] };
    try {
      for (const row of document.querySelectorAll('.BHOKXe')) {
        const label = (row.getAttribute('aria-label') || row.textContent || '').trim().replace(/\s+/g, ' ');
        if (label) out.ratingDistribution.push({ label });
        if (out.ratingDistribution.length >= 6) break;
      }

      let nodes = document.querySelectorAll('div.jftiEf');
      if (nodes.length) {
        const scroller = nodes[0].closest('div[tabindex="-1"], div.m6QErb, div[role="main"]');
        for (let i = 0; i < 4 && nodes.length < 12; i++) {
          if (!scroller) break;
          const prev = nodes.length;
          scroller.scrollBy(0, scroller.clientHeight * 0.9);
          await sleep(jitter(700));
          nodes = document.querySelectorAll('div.jftiEf');
          if (nodes.length === prev) break; // no more loaded
        }
      }

      const picked = Array.from(nodes).slice(0, 12)
        .map((n) => sanitizeAndCap(n, 4000))
        .filter(Boolean);
      out.reviewsHtml = capTotal(picked.join('\n'), 40000);
    } catch (_) { /* fail-empty */ }
    return out;
  }

  // About / attributes section as raw HTML. Use the in-page expander
  // (jsaction is locale-independent); do NOT click the "À propos" tab
  // (data-tab-index="3") — its label is localized and clicking it races the
  // rest of the read. Bounded wait, fail-empty.
  async function extractAboutHtml() {
    try {
      let region = document.querySelector('.y0K5Df');
      if (!region) {
        const expander = document.querySelector('button[jsaction*="pane.attributes.expand"]');
        if (expander) {
          try { expander.click(); } catch (_) { /* ignore */ }
          region = await waitForSelector('.y0K5Df', { timeout: 3000 }).catch(() => null);
        }
      }
      return sanitizeAndCap(region, 20000);
    } catch (_) {
      return '';
    }
  }

  // Editorial / "About" summary blurb, when Google provides one.
  function extractDescription() {
    return extractText(document, '.PYvSYb')
      || extractText(document, 'div.WeS02d')
      || '';
  }

  // Service-option chips: dine-in / takeaway / delivery / curbside / etc.
  function extractServiceOptions() {
    const KEYS = [/dine-?in/i, /take ?away|take-?out/i, /delivery/i, /curbside/i, /drive-?thr(ough|u)/i, /outdoor seating/i, /in-?store (shopping|pick)/i, /no-?contact/i];
    const opts = new Set();
    for (const n of document.querySelectorAll('.LTs0Rc, [aria-label]')) {
      const t = (n.getAttribute('aria-label') || n.textContent || '').trim();
      if (!t || t.length > 40) continue;
      if (KEYS.some((re) => re.test(t))) opts.add(t.replace(/\s*[·•].*$/, '').trim());
      if (opts.size >= 8) break;
    }
    return Array.from(opts).slice(0, 8);
  }

  // A handful of Google-hosted photo URLs (hero + gallery) for menu vision.
  function extractPhotos() {
    const urls = new Set();
    const isG = (u) => /googleusercontent\.com|ggpht\.com/.test(u || '');
    for (const img of document.querySelectorAll('button[jsaction*="heroHeaderImage"] img, button[aria-label*="Photo" i] img, .RZ66Rb img, img[src*="googleusercontent.com"]')) {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (isG(src)) urls.add(src);
      if (urls.size >= 6) break;
    }
    for (const el of document.querySelectorAll('[style*="background-image"]')) {
      const m = (el.getAttribute('style') || '').match(/url\(["']?(https:\/\/[^"')]+)["']?\)/);
      if (m && isG(m[1])) urls.add(m[1]);
      if (urls.size >= 6) break;
    }
    return Array.from(urls).slice(0, 4);
  }

  // External menu / ordering link, when the place exposes one.
  function extractMenuLink() {
    const a = document.querySelector('a[data-item-id="menu"], a[aria-label^="Menu" i]');
    const href = a?.getAttribute('href') || '';
    if (/^https?:/.test(href)) return href;
    const byId = findByDataItemId('menu');
    return /^https?:/.test(byId) ? byId : '';
  }

  // lat/lng from the place URL (/@lat,lng or !3d..!4d.. data block).
  function parseCoordinates(url) {
    const src = url || location.href;
    const m = src.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || src.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
  }

  function findByDataItemId(prefix) {
    const nodes = document.querySelectorAll('button[data-item-id], a[data-item-id]');
    for (const n of nodes) {
      const v = n.getAttribute('data-item-id') || '';
      if (v.startsWith(prefix)) {
        if (n.tagName === 'A' && (n.getAttribute('href') || '').startsWith('http')) {
          return n.getAttribute('href');
        }
        const label = n.getAttribute('aria-label') || n.textContent || '';
        return label.replace(/^[^:]+:\s*/, '').trim();
      }
    }
    return '';
  }

  window.__mapsCore = {
    guardHost,
    isMapsSearchPage,
    isMapsPlacePage,
    getFeedEl,
    extractLoaded,
    loadMore,
    scrapeSearch,
    scrapePlace,
  };
})();
