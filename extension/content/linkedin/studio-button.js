// Floating "✨ Generate Message" button on LinkedIn profile pages
// (`/in/*`). Clicking calls `window.openTalentAIStudioPopup()` which is
// exposed by studio-popup.js (loaded alongside via the same content_scripts
// entry in manifest.json).
//
// Coexists with profile-sidebar.js — separate IDs, independent DOM
// additions. SPA navigation handled via a MutationObserver because
// LinkedIn re-renders sections of the page without firing navigation
// events.

(function () {
  'use strict';

  const BUTTON_ID = 'talentai-studio-button';

  function onProfilePath() {
    return /^\/in\//.test(window.location.pathname);
  }

  function ensureButton() {
    if (!onProfilePath()) {
      document.getElementById(BUTTON_ID)?.remove();
      return;
    }
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.innerHTML = '✨ Generate Message';
    button.setAttribute('aria-label', 'Generate message via TalentAI Studio');
    // Bottom-LEFT to avoid colliding with the existing CRM panel (which
    // pins to bottom-right at z-index 999999 — profile-sidebar.js:521).
    // Putting them on opposite corners lets the user use both features
    // simultaneously instead of one covering the other.
    button.style.cssText = [
      'position: fixed',
      'bottom: 24px',
      'left: 24px',
      'z-index: 9999',
      'background: #0a66c2',
      'color: white',
      'border: none',
      'border-radius: 24px',
      'padding: 12px 20px',
      'font-size: 14px',
      'font-weight: 600',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.15)',
      'cursor: pointer',
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    ].join('; ') + ';';
    button.addEventListener('click', () => {
      if (typeof window.openTalentAIStudioPopup === 'function') {
        window.openTalentAIStudioPopup();
      } else {
        console.warn('[talentai-studio-button] openTalentAIStudioPopup not loaded yet');
      }
    });
    document.body.appendChild(button);
  }

  // Initial render — wait a tick so the body is hydrated.
  setTimeout(ensureButton, 400);

  // SPA-aware re-injection. LinkedIn doesn't fire navigation events on
  // pushState transitions, so we observe body mutations and re-check.
  const observer = new MutationObserver(() => {
    ensureButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also re-check on history-state change (some routes trigger this).
  window.addEventListener('popstate', () => setTimeout(ensureButton, 200));
})();
