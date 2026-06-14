// ─── Google Maps: fetch business detail ────────────────────────────────────
// Thin wrapper over the self-contained maps-core module (injected first).
// Entry point: window.__talentaiRun(params) — returns a flat business object.

(() => {
  window.__talentaiRun = async function run(params) {
    const core = window.__mapsCore;
    if (!core) throw new Error('gmaps_core_not_loaded');
    return core.scrapePlace({ mapsUrl: params.mapsUrl || '' });
  };
})();
