// ─── config.js ──────────────────────────────────────────────────────────────
// Single source of truth for the backend URL.
//
// Why a hand-edited constant instead of an env var? The extension has no
// build step (Chrome loads the files directly), so there's no point in time
// where we could substitute `process.env.SOMETHING`. If you're running
// against a non-production backend, change BACKEND_URL below and reload the
// unpacked extension.
//
// Production:  https://agents.api.talentailabs.com
// Local dev:   http://localhost:4000
export const BACKEND_URL = 'https://agents.api.talentailabs.com';
