// ─── Google Maps: fetch business detail ────────────────────────────────────
// Entry point: window.__talentaiRun(params) — returns a flat business object.

(() => {
  const u = window.__talentaiUtils;

  window.__talentaiRun = async function run(params) {
    await Promise.race([
      u.waitForSelector('h1.DUwDvf', { timeout: 15000 }).catch(() => null),
      u.waitForSelector('div[role="main"]', { timeout: 15000 }).catch(() => null),
    ]);

    const name = u.extractText(document, 'h1.DUwDvf') || u.extractText(document, 'h1');

    const ratingTxt = u.extractText(document, 'div.F7nice span[aria-hidden="true"]') || u.extractText(document, 'span.ceNzKf');
    const reviewsTxt = u.extractText(document, 'div.F7nice button[aria-label*="reviews"]') || u.extractText(document, 'button[jsaction*="reviewChart"]');
    const rating = ratingTxt ? parseFloat(ratingTxt.trim()) : null;
    const reviewsCount = reviewsTxt ? parseInt(reviewsTxt.replace(/[^\d]/g, ''), 10) || null : null;

    const category = u.extractText(document, 'button[jsaction*="category"]');
    const address = findByDataItemId('address');
    const phone = findByDataItemId('phone:tel:');
    const website = findByDataItemId('authority'); // Google tags website rows as "authority"
    const hours = findByDataItemId('oh');

    return {
      name,
      mapsUrl: params.mapsUrl || location.href.split('?')[0],
      rating,
      reviewsCount,
      category,
      address,
      phone,
      website,
      hours,
    };
  };

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
})();
