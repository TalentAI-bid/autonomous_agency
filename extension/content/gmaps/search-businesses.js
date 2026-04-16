// ─── Google Maps: search businesses ────────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns { businesses: [...] }

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    const limit = Math.min(100, params.limit || 20);

    // The results feed container
    const feed = await Promise.race([
      u.waitForSelector('div[role="feed"]', { timeout: 15000 }).catch(() => null),
      u.waitForSelector('div[aria-label*="Results"]', { timeout: 15000 }).catch(() => null),
    ]);

    if (!feed) throw new Error('gmaps_no_results_feed');

    // Scroll the feed until we've loaded >= limit results (or reached the end).
    let prevCount = 0, stableIterations = 0;
    for (let i = 0; i < 20; i++) {
      await u.scrollContainer(feed, { steps: 3, delayMs: 900 });
      const count = feed.querySelectorAll('a[href*="/maps/place/"]').length;
      if (count >= limit) break;
      if (count === prevCount) {
        stableIterations++;
        if (stableIterations >= 3) break; // reached the end
      } else {
        stableIterations = 0;
      }
      prevCount = count;
    }

    const cards = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]')).slice(0, limit);
    const seen = new Set();
    const businesses = [];

    for (const a of cards) {
      const mapsUrl = u.absoluteUrl(a.getAttribute('href') || '').split('?')[0];
      if (!mapsUrl || seen.has(mapsUrl)) continue;
      seen.add(mapsUrl);

      // Walk up to the row/card container
      const card = a.closest('[role="article"]') || a.closest('div[jsaction]') || a.parentElement;
      if (!card) continue;

      const name = u.extractText(a, '[role="heading"]') || u.extractText(a) || (() => {
        // Last-ditch: derive from URL
        const m = mapsUrl.match(/\/place\/([^/]+)\//);
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      })();

      const ratingNode = card.querySelector('span.MW4etd, span[aria-label*="stars"]');
      const reviewsNode = card.querySelector('span.UY7F9, span[aria-label*="reviews"]');
      const rating = ratingNode ? parseFloat((ratingNode.textContent || '').trim()) : null;
      const reviewsTxt = reviewsNode ? (reviewsNode.textContent || '').replace(/[^\d]/g, '') : '';
      const reviewsCount = reviewsTxt ? parseInt(reviewsTxt, 10) : null;

      // Address + category are typically in comma-separated rows within the card
      const infoBlocks = Array.from(card.querySelectorAll('.W4Efsd')).map((el) => (el.textContent || '').trim());
      const address = infoBlocks.find((t) => /\d/.test(t) && t.length > 6) || '';
      const category = infoBlocks[0] && !/\d/.test(infoBlocks[0]) ? infoBlocks[0].split('·')[0].trim() : '';

      const websiteAnchor = card.querySelector('a[data-value="Website"], a[aria-label*="Website"]');
      const website = websiteAnchor?.getAttribute('href') || '';

      businesses.push({ name, mapsUrl, rating, reviewsCount, address, category, website });
    }

    return { businesses };
  };
})();
