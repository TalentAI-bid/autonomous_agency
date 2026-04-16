# TalentAI Scraper Extension

Pure vanilla-JS Chrome MV3 extension. **No build step.** Chrome loads these files directly.

## Install (dev / unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this `extension/` directory.
3. Click the TalentAI icon in the toolbar to open the popup.
4. In the TalentAI dashboard, go to **Settings → Browser Extension → Generate API Key**, copy the key.
5. Back in the popup: paste the key, set your server URL (`ws://localhost:3000` in dev), click **Save & Connect**.

## What it does

Receives tasks from your TalentAI backend over a WebSocket and scrapes public data
from the sites you're already authenticated into:

- **LinkedIn**: company search + company detail
- **Google Maps**: business search + business detail
- **Crunchbase**: company search + company detail (requires you to be signed into Crunchbase)

Results are posted back over the same WebSocket and enter the normal
enrichment → scoring → outreach pipeline.

## Icons

Replace the placeholder files in `icons/` with your own 16/48/128 PNGs. Any
transparent PNG at the right size works; no other constraints.

## Rate limits (server-authoritative)

See `agentcore/src/services/extension-dispatcher.ts` → `EXTENSION_SITE_LIMITS`.
The client mirrors those caps with ±30% jitter as a defensive second layer.
