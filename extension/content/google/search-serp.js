// ─── Google web-search (SERP): scrape result links ─────────────────────────
// Thin wrapper over the self-contained google-core module (injected first).
// Entry point: window.__talentaiRun(params) — returns { results: [...] }.
// params: { dork: string (already in the URL), limit?: number }

(() => {
  window.__talentaiRun = async function run(params) {
    const core = window.__googleCore;
    if (!core) throw new Error('google_core_not_loaded');
    return core.scrapeSerp({ limit: params.limit || 30 });
  };
})();
