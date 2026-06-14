// Studio popup — opens when the user clicks the floating button injected
// by studio-button.js. Auto-scrapes the current LinkedIn profile, lets the
// user pick channel / message type / track + add free-form context, then
// asks the service worker to generate a message via /api/studio/generate.
//
// Communication with the backend is via chrome.runtime.sendMessage to the
// service worker (which owns the auth session). Content scripts can't
// import auth-client directly.
//
// DOM selectors below are the same family used by profile-sidebar.js —
// keep them in sync if LinkedIn redesigns. Every paste/scrape path has a
// clipboard fallback + alert so the failure mode is "manual paste"
// rather than silent crash.

(function () {
  'use strict';

  const POPUP_ID = 'talentai-studio-popup';

  window.openTalentAIStudioPopup = function openTalentAIStudioPopup() {
    if (document.getElementById(POPUP_ID)) return; // already open
    const profileData = scrapeProfilePage();
    renderStudioPopup(profileData);
  };

  // ─── Profile scraping ──────────────────────────────────────────────
  // Reuses the proven multi-selector cascade from profile-sidebar.js.
  // When LinkedIn ships a redesign, fix profile-sidebar.js first and
  // mirror the changes here.

  function scrapeProfilePage() {
    return {
      name: extractName(),
      title: extractHeadline(),
      company: extractCurrentCompany(),
      location: extractLocation(),
      linkedinUrl: window.location.href.split('?')[0].split('#')[0],
    };
  }

  function extractName() {
    // Try standard 2024 selector first, then a series of fallbacks. If
    // nothing matches, fall back to the URL slug (`/in/john-doe/` → "John Doe").
    const candidates = [
      'h1.text-heading-xlarge',
      'main h1',
      '.pv-text-details__left-panel h1',
      'h1',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 1 && text.length < 100) return text;
    }
    // URL slug fallback
    const slug = window.location.pathname.replace(/^\/in\//, '').replace(/\/$/, '');
    if (slug) {
      return slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    }
    return '';
  }

  function extractHeadline() {
    const candidates = [
      '.pv-text-details__left-panel .text-body-medium',
      '.ph5 .text-body-medium.break-words',
      '.pv-top-card .text-body-medium',
      '.text-body-medium.break-words',
      'main .text-body-medium',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 1 && text.length < 400) return text;
    }
    return '';
  }

  function extractCurrentCompany() {
    // Try the experience section's first role.
    const expSection = document.querySelector('#experience')?.parentElement;
    const firstRole = expSection?.querySelector('.pvs-list__item--line-separated');
    const fromExp = firstRole?.querySelector('.t-14.t-normal')?.innerText?.trim();
    if (fromExp) return fromExp.split('·')[0].trim();
    // Headline "Title at Company" parse fallback.
    const headline = extractHeadline();
    const match = headline.match(/^.+?\s+(?:at|@|chez|bei|en)\s+(.+)$/i);
    if (match) return match[1].trim();
    return '';
  }

  function extractLocation() {
    const candidates = [
      '.text-body-small.inline.t-black--light.break-words',
      '.pv-text-details__left-panel .text-body-small',
      '.pv-top-card .pv-top-card--list-bullet li',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 1 && text.length < 120) return text;
    }
    return '';
  }

  // ─── Popup UI ──────────────────────────────────────────────────────

  function renderStudioPopup(profileData) {
    const popup = document.createElement('div');
    popup.id = POPUP_ID;
    popup.innerHTML = `
      <div class="popup-overlay"></div>
      <div class="popup-content">
        <header>
          <h3>✨ Generate Message</h3>
          <button id="close-popup" aria-label="Close">×</button>
        </header>

        <div class="profile-preview">
          <strong>${escapeHtml(profileData.name || '(unknown name)')}</strong>
          <div>${escapeHtml(profileData.title || '')}</div>
          <div>${escapeHtml([profileData.company, profileData.location].filter(Boolean).join(' · '))}</div>
        </div>

        <div class="form">
          <label>Channel
            <select id="channel">
              <option value="linkedin_dm">💼 LinkedIn DM</option>
              <option value="linkedin_connection_request">🤝 Connection Note</option>
              <option value="email_cold">📧 Cold Email</option>
              <option value="twitter_dm">🐦 Twitter / X DM</option>
              <option value="whatsapp">💬 WhatsApp</option>
              <option value="telegram">🚀 Telegram</option>
            </select>
          </label>

          <label>Message Type
            <select id="messageType">
              <option value="first_message">📩 First Message</option>
              <option value="first_followup">🔄 First Follow-up</option>
              <option value="second_followup">🔁 Second Follow-up</option>
              <option value="reactivation">♻️ Reactivation</option>
              <option value="post_meeting">🤝 Post-Meeting</option>
              <option value="post_no_show">📅 Post-No-Show</option>
              <option value="breakup">👋 Breakup</option>
            </select>
          </label>

          <label>Track
            <select id="track">
              <option value="sales">💰 Sales</option>
              <option value="partnership">🤝 Partnership</option>
              <option value="collaboration">🌐 Collaboration</option>
            </select>
          </label>

          <label>Context (optional)
            <textarea id="customContext" rows="2" placeholder="Specific angle, shared context, what was discussed, etc."></textarea>
          </label>

          <button id="generate-btn">✨ Generate</button>
        </div>

        <div id="output" class="output hidden"></div>
      </div>
    `;
    document.body.appendChild(popup);

    popup.querySelector('#close-popup').addEventListener('click', closePopup);
    popup.querySelector('.popup-overlay').addEventListener('click', closePopup);
    popup.querySelector('#generate-btn').addEventListener('click', () => generateAndDisplay(profileData));
  }

  function closePopup() {
    document.getElementById(POPUP_ID)?.remove();
  }

  async function generateAndDisplay(profileData) {
    const channel = document.getElementById('channel').value;
    const messageType = document.getElementById('messageType').value;
    const track = document.getElementById('track').value;
    const customContext = document.getElementById('customContext').value.trim();

    const outputEl = document.getElementById('output');
    outputEl.classList.remove('hidden');
    outputEl.innerHTML = '<div class="loading">Generating…</div>';

    try {
      const response = await chrome.runtime.sendMessage({
        kind: 'studio_generate',
        payload: {
          channel,
          messageType,
          track,
          recipient: profileData,
          customContext: customContext || undefined,
        },
      });

      if (!response || !response.ok) {
        const msg = response?.error || 'Generation failed';
        throw new Error(msg);
      }

      // Defensive: even when the SW reports ok, the composition payload
      // may be missing (server-side hiccup, schema drift). Don't deref
      // null fields — surface a retry-able error instead.
      const composition = response.composition;
      if (!composition || typeof composition.body !== 'string') {
        throw new Error('Empty response from server. Please retry.');
      }
      const subject = composition.subject ? `<div class="subject"><strong>Subject:</strong> ${escapeHtml(composition.subject)}</div>` : '';
      const body = escapeHtml(composition.body).replace(/\n/g, '<br>');
      const dmBtn = channel === 'linkedin_dm'
        ? `<button class="btn-paste-dm">📩 Paste into DM</button>`
        : '';
      const connectBtn = channel === 'linkedin_connection_request'
        ? `<button class="btn-paste-connect">🤝 Paste into Connect</button>`
        : '';

      outputEl.innerHTML = `
        <div class="message-card">
          ${subject}
          <div class="body">${body}</div>
          <div class="meta">${composition.characterCount ?? composition.body.length} chars</div>
          <div class="actions">
            <button class="btn-copy">📋 Copy</button>
            ${dmBtn}
            ${connectBtn}
            <button class="btn-regenerate">🔄 Regenerate</button>
          </div>
        </div>
      `;

      // Use closures to avoid relying on data-text attributes (which need
      // escaping anyway). The composition body is captured here.
      outputEl.querySelector('.btn-copy')?.addEventListener('click', () => copyToClipboard(composition.body));
      outputEl.querySelector('.btn-paste-dm')?.addEventListener('click', () => pasteIntoLinkedInDM(composition.body, profileData));
      outputEl.querySelector('.btn-paste-connect')?.addEventListener('click', () => pasteIntoConnectionRequest(composition.body, profileData));
      outputEl.querySelector('.btn-regenerate')?.addEventListener('click', () => generateAndDisplay(profileData));
    } catch (err) {
      outputEl.innerHTML = `<div class="error">Error: ${escapeHtml(err?.message ?? String(err))}</div>`;
    }
  }

  // ─── LinkedIn compose-box drivers ─────────────────────────────────

  async function pasteIntoLinkedInDM(text, profileData) {
    const messageBtn =
      document.querySelector('button[aria-label*="Message"]:not([disabled])') ||
      document.querySelector('a[aria-label*="Message"]');
    if (!messageBtn) {
      await copyToClipboard(text);
      alert('Could not find a Message button on this profile. Text copied to clipboard — paste it manually after opening the LinkedIn DM.');
      return;
    }
    messageBtn.click();
    try {
      const box = await waitForElement('.msg-form__contenteditable', 3500);
      box.focus();
      // The compose box is contenteditable — insertText respects current selection.
      document.execCommand('insertText', false, text);
      // Auto-detect the actual Send so we can record the outreach. The send
      // button lives in the same .msg-form as the compose box.
      const sendBtn =
        document.querySelector('.msg-form__send-button') ||
        document.querySelector('button.msg-form__send-btn') ||
        document.querySelector('.msg-form button[type="submit"]');
      attachSendListener(sendBtn, 'linkedin_dm', text, profileData);
      closePopup();
    } catch {
      await copyToClipboard(text);
      alert('LinkedIn DM compose box did not appear in time. Text copied to clipboard — paste manually.');
    }
  }

  async function pasteIntoConnectionRequest(text, profileData) {
    const connectBtn =
      document.querySelector('button[aria-label*="Invite"]:not([disabled])') ||
      document.querySelector('button[aria-label*="Connect"]:not([disabled])');
    if (!connectBtn) {
      await copyToClipboard(text);
      alert('Could not find a Connect button on this profile. Text copied to clipboard — open Connect manually and paste into the note field.');
      return;
    }
    connectBtn.click();
    try {
      const addNoteBtn = await waitForElement('button[aria-label*="Add a note"], button[aria-label*="note"]', 2500);
      addNoteBtn.click();
      const noteBox = await waitForElement('#custom-message, textarea[name="message"]', 2500);
      noteBox.value = text;
      noteBox.dispatchEvent(new Event('input', { bubbles: true }));
      // Auto-detect the "Send" / "Send invitation" click in the connect modal.
      const modal = noteBox.closest('.artdeco-modal') || document;
      const sendBtn =
        modal.querySelector('button[aria-label*="Send"]:not([disabled])') ||
        modal.querySelector('.artdeco-modal__actionbar button.artdeco-button--primary') ||
        modal.querySelector('button.artdeco-button--primary');
      attachSendListener(sendBtn, 'linkedin_connection_request', text, profileData);
      closePopup();
    } catch {
      await copyToClipboard(text);
      alert('LinkedIn Connect modal flow timed out. Text copied to clipboard — paste manually into the "Add a note" field.');
    }
  }

  // ─── Send detection + recording ────────────────────────────────────
  // Best-effort: attach a one-time click listener to LinkedIn's Send button.
  // When the user actually sends, report it so the backend records a CRM
  // activity. If the button isn't found or LinkedIn changes its DOM, we just
  // don't record — never block or crash the send itself.
  function attachSendListener(sendBtn, channel, body, profileData) {
    if (!sendBtn || !profileData?.linkedinUrl) return;
    const onSend = () => {
      try {
        chrome.runtime.sendMessage({
          kind: 'studio_record_action',
          payload: { channel, recipient: profileData, body },
        });
      } catch { /* extension context gone — ignore */ }
    };
    sendBtn.addEventListener('click', onSend, { once: true, capture: true });
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  function copyToClipboard(text) {
    return navigator.clipboard?.writeText(text).catch(() => {
      // Older browsers fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    });
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const start = Date.now();
      const interval = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(interval);
          resolve(el);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error('element_not_found'));
        }
      }, 100);
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }
})();
