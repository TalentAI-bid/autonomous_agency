// ─── LinkedIn: review-then-send outreach adapter ───────────────────────────
// Entry point: window.__talentaiRun(params) → { status: 'staged' | 'failed' }
//
// Claude (via the MCP server) triggers this through a dispatched extension task.
// We open the person's profile (the SW already navigated here), then TYPE the
// message/note into LinkedIn's compose box — and STOP. We never click Send; the
// user reviews and clicks Send themselves (protects the account from LinkedIn's
// automation detection). When they do click Send, attachSendListener reports it
// to the backend (studio_record_action) so the CRM logs the outreach.
//
// The paste + send-detection logic is ported verbatim from studio-popup.js
// (the manual Studio widget) — content scripts can't share globals, so the
// helpers are inlined. Keep in sync with studio-popup.js.
//
// params: { channel: 'linkedin_dm' | 'linkedin_connection_request',
//           message?: string, note?: string,
//           profileData: { name?, company?, title?, location?, linkedinUrl } }

(() => {
  const u = window.__talentaiUtils;
  const LOG = '[TalentAI cs] li/paste-outreach';

  function copyToClipboard(text) {
    return navigator.clipboard?.writeText(text).catch(() => {
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
        if (el) { clearInterval(interval); resolve(el); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(interval); reject(new Error('element_not_found')); }
      }, 100);
    });
  }

  // Best-effort: attach a one-time listener to LinkedIn's Send button. When the
  // user actually sends, report it so the backend records a CRM activity. Never
  // blocks or crashes the send itself.
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

  async function pasteIntoLinkedInDM(text, profileData) {
    const messageBtn =
      document.querySelector('button[aria-label*="Message"]:not([disabled])') ||
      document.querySelector('a[aria-label*="Message"]');
    if (!messageBtn) {
      await copyToClipboard(text);
      alert('TalentAI: could not find a Message button on this profile. The message was copied to your clipboard — open the DM and paste it.');
      return { status: 'failed', reason: 'message_button_not_found' };
    }
    messageBtn.click();
    try {
      const box = await waitForElement('.msg-form__contenteditable', 4000);
      box.focus();
      document.execCommand('insertText', false, text);
      const sendBtn =
        document.querySelector('.msg-form__send-button') ||
        document.querySelector('button.msg-form__send-btn') ||
        document.querySelector('.msg-form button[type="submit"]');
      attachSendListener(sendBtn, 'linkedin_dm', text, profileData);
      console.log(LOG, 'DM staged — waiting for user to click Send');
      return { status: 'staged' };
    } catch {
      await copyToClipboard(text);
      alert('TalentAI: the LinkedIn DM box did not open in time. The message was copied to your clipboard — paste it manually.');
      return { status: 'failed', reason: 'compose_box_timeout' };
    }
  }

  async function pasteIntoConnectionRequest(text, profileData) {
    const connectBtn =
      document.querySelector('button[aria-label*="Invite"]:not([disabled])') ||
      document.querySelector('button[aria-label*="Connect"]:not([disabled])');
    if (!connectBtn) {
      await copyToClipboard(text);
      alert('TalentAI: could not find a Connect button on this profile (you may already be connected). The note was copied to your clipboard.');
      return { status: 'failed', reason: 'connect_button_not_found' };
    }
    connectBtn.click();
    try {
      const addNoteBtn = await waitForElement('button[aria-label*="Add a note"], button[aria-label*="note"]', 3000);
      addNoteBtn.click();
      const noteBox = await waitForElement('#custom-message, textarea[name="message"]', 3000);
      noteBox.value = text;
      noteBox.dispatchEvent(new Event('input', { bubbles: true }));
      const modal = noteBox.closest('.artdeco-modal') || document;
      const sendBtn =
        modal.querySelector('button[aria-label*="Send"]:not([disabled])') ||
        modal.querySelector('.artdeco-modal__actionbar button.artdeco-button--primary') ||
        modal.querySelector('button.artdeco-button--primary');
      attachSendListener(sendBtn, 'linkedin_connection_request', text, profileData);
      console.log(LOG, 'connection note staged — waiting for user to click Send');
      return { status: 'staged' };
    } catch {
      await copyToClipboard(text);
      alert('TalentAI: the LinkedIn Connect modal did not open in time. The note was copied to your clipboard — paste it into the "Add a note" field.');
      return { status: 'failed', reason: 'connect_modal_timeout' };
    }
  }

  window.__talentaiRun = async function run(params) {
    console.log(LOG, 'start', { href: location.href, channel: params?.channel });

    const host = location.hostname || '';
    if (!/(^|\.)linkedin\.com$/i.test(host)) {
      console.log(LOG, 'aborted_non_linkedin_host', { host });
      return { status: 'failed', reason: 'non_linkedin_host' };
    }

    const channel = params?.channel;
    const text = (channel === 'linkedin_connection_request' ? params?.note : params?.message);
    if (typeof text !== 'string' || !text.trim()) {
      return { status: 'failed', reason: 'no_text' };
    }
    const profileData = params?.profileData || { linkedinUrl: location.href.split('?')[0] };

    // The SW navigated us to the profile; wait for the top card to hydrate.
    await Promise.race([
      u.waitForSelector('main', { timeout: 10000 }),
      u.waitForSelector('button[aria-label*="Message"], button[aria-label*="Connect"], button[aria-label*="Invite"]', { timeout: 10000 }).catch(() => null),
    ]);
    await u.sleep(u.jitter(1200));

    if (channel === 'linkedin_dm') {
      return pasteIntoLinkedInDM(text.trim(), profileData);
    }
    if (channel === 'linkedin_connection_request') {
      return pasteIntoConnectionRequest(text.trim(), profileData);
    }
    return { status: 'failed', reason: `unknown_channel:${channel}` };
  };
})();
