// ─── Google Maps: search businesses ────────────────────────────────────────
// Thin wrapper over the self-contained maps-core module (injected first).
// Entry point: window.__talentaiRun(params) — returns { businesses: [...] }

(() => {
  window.__talentaiRun = async function run(params) {
    const core = window.__mapsCore;
    if (!core) throw new Error('gmaps_core_not_loaded');
    return core.scrapeSearch({
      limit: params.limit,
      location: params.location || '',
    });
  };
})();
