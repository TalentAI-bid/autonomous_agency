// Boot marker — outside the IIFE so even if the IIFE throws during setup
// we still see proof the content-script tag executed. Visible in DevTools
// → Console (filter by `[talentai-copilot]`).
console.log('[talentai-copilot] script-tag executed on', window.location.host + window.location.pathname);

// LinkedIn Inbox Copilot — INLINE version.
// Replaces the old sidebar UX. Injects a small ✨ button into LinkedIn's
// compose toolbar (`.msg-form`). Clicking it opens an anchored menu with
// five modes: generate from scratch, polish, shorter, more direct, different
// angle. The chosen mode + the user's in-progress text are sent to the
// service worker, which proxies POST /api/copilot/draft-reply. The reply
// body is written straight into the LinkedIn compose box; the user clicks
// LinkedIn's own Send.
//
// Comm path: content script → chrome.runtime.sendMessage({ kind: 'copilot_draft_reply' })
//            → SW handler at service-worker.js:691 → authedFetch → backend.
// Content scripts can't import auth-client.js (ES module bound to extension
// context), so SW-passing is the only path.
//
// DOM selectors below are late-2024 LinkedIn. If they shift, the button
// silently stops appearing — clipboard fallbacks in pasteIntoComposeBox
// keep the failure mode "manual paste" rather than crash.

(function () {
  'use strict';

  const BUTTON_CLASS = 'talentai-copilot-btn';
  const MENU_ID = 'talentai-copilot-menu';
  const INDICATOR_CLASS = 'talentai-copilot-indicator';
  const LOG = '[talentai-copilot]';

  // ─── Signed-in user identity ──────────────────────────────────────
  // Strong direction signal: if a message's sender label matches the
  // signed-in user's name (case-insensitive), it's outbound. Cache once
  // per page — LinkedIn's SPA renders nav before messaging.
  function getSignedInUserName() {
    const attempts = [
      // Global nav photo alt — most reliable across locales.
      () => document.querySelector('img.global-nav__me-photo')?.getAttribute('alt'),
      () => document.querySelector('.global-nav__me-photo')?.getAttribute('alt'),
      // Text near the profile photo.
      () => document.querySelector('.global-nav__me')?.innerText?.trim(),
      () => document.querySelector('.global-nav__primary-link-me-menu-trigger')?.innerText?.trim(),
      // Page-level metadata.
      () => document.querySelector('meta[name="li:owner_name"]')?.getAttribute('content'),
      // Last resort: a "me" link anywhere on the page.
      () => {
        const meLink = document.querySelector('a[href*="/in/me/"], a[data-control-name="identity_welcome_message"]');
        return meLink?.innerText?.trim();
      },
    ];
    for (const fn of attempts) {
      try {
        const v = fn();
        if (v && typeof v === 'string') {
          const cleaned = v.replace(/\s+/g, ' ').trim();
          if (cleaned.length > 1 && cleaned.length < 100) {
            return cleaned;
          }
        }
      } catch (_) {
        // continue
      }
    }
    return null;
  }

  // ─── Direction detection (5-signal priority chain) ────────────────
  // Confirmed against real DOM evidence. Returns {direction, via} so
  // diagnostic logs show which signal fired.
  //
  // Signal 1 (sent_indicator): .msg-s-event-with-indicator__sending-indicator--sent
  //   LinkedIn renders this checkmark ONLY on outbound messages.
  //   Locale-independent and the most reliable signal.
  // Signal 2 (sent_tooltip):  title="Envoyé…"/"Sent…"/"Enviado…"/etc.
  //   Survives if --sent class is renamed; title is human-readable.
  // Signal 3 (name_match):    sender name === signed-in user (case-insensitive)
  // Signal 4 (profile_img_alt): profile picture alt === signed-in user
  // Signal 5 (you_marker):    localized "You"/"Vous"/"Tu"/etc.
  // Default → inbound.
  function detectMessageDirection(messageElement, signedInUserName) {
    // Signal 1
    if (messageElement.querySelector('.msg-s-event-with-indicator__sending-indicator--sent')) {
      return { direction: 'outbound', via: 'sent_indicator' };
    }

    // Signal 2
    const anyIndicator = messageElement.querySelector(
      '[class*="sending-indicator"], [title*="Envoyé"], [title*="Sent"], [title*="Enviado"], [title*="Gesendet"], [title*="Inviato"]',
    );
    if (anyIndicator) {
      const title = anyIndicator.getAttribute('title') || '';
      if (/(Envoyé|Sent|Enviado|Gesendet|Inviato|Verzonden|Wysłane|送信)/i.test(title)) {
        return { direction: 'outbound', via: 'sent_tooltip' };
      }
    }

    // Signal 3
    if (signedInUserName) {
      const senderEl = messageElement.querySelector(
        '.msg-s-message-group__name, .msg-s-event-listitem__name, [class*="message-group__name"]',
      );
      const senderName = senderEl?.innerText?.trim() || '';
      if (senderName) {
        const ns = senderName.toLowerCase();
        const nu = signedInUserName.toLowerCase();
        if (ns === nu || ns.includes(nu) || nu.includes(ns)) {
          return { direction: 'outbound', via: 'name_match' };
        }
      }
    }

    // Signal 4
    if (signedInUserName) {
      const profileImg = messageElement.querySelector(
        '.msg-s-event-listitem__profile-picture, [class*="profile-picture"]',
      );
      const alt = profileImg?.getAttribute('alt') || '';
      if (alt) {
        const na = alt.toLowerCase();
        const nu = signedInUserName.toLowerCase();
        if (na === nu || na.includes(nu) || nu.includes(na)) {
          return { direction: 'outbound', via: 'profile_img_alt' };
        }
      }
    }

    // Signal 5
    const senderEl5 = messageElement.querySelector(
      '.msg-s-message-group__name, .msg-s-event-listitem__name',
    );
    const senderName5 = senderEl5?.innerText?.trim() || '';
    if (/^(You|Vous|Tu|Du|Tú|Você|Sie|あなた|您|당신)$/i.test(senderName5)) {
      return { direction: 'outbound', via: 'you_marker' };
    }

    return { direction: 'inbound', via: 'default' };
  }

  // ─── Scrape validation (refuse on degenerate output) ─────────────
  // 1-message threads are now ALLOWED — they're a valid follow-up
  // scenario (user sent cold outreach, recipient hasn't replied).
  // The all-same-direction-3+ rule catches scrape failures where every
  // message ends up tagged the same way.
  function validateScrape(messages, signedInUserName) {
    if (messages.length === 0) {
      return { ok: false, reason: 'Could not read this thread. Open the conversation fully and try again.' };
    }
    if (!signedInUserName) {
      return { ok: false, reason: 'Could not detect your LinkedIn identity. Please refresh the page and try again.' };
    }
    if (messages.length >= 3) {
      const first = messages[0].direction;
      if (messages.every((m) => m.direction === first)) {
        return {
          ok: false,
          reason: `Scrape error: all ${messages.length} messages tagged as ${first}. LinkedIn DOM may have changed — please refresh and try again.`,
        };
      }
    }
    return { ok: true };
  }

  // Boot-time signal so the user can confirm the content script ran at
  // all. Visible in DevTools → Console (filter by [talentai-copilot]).
  console.log(`${LOG} loaded on ${window.location.hostname}${window.location.pathname}`);

  let lastScanAt = 0;
  let firstHitLogged = false;
  const scriptStartedAt = Date.now();
  let zeroFormsWarned = false;

  function scan() {
    const now = Date.now();
    if (now - lastScanAt < 500) return; // throttle
    lastScanAt = now;
    const stats = injectButtonsIntoAllComposeForms();

    // Diagnostic: log the first time we find an editor, OR once after 10 s
    // if we still haven't seen any. Editor-anchored stats let the user see
    // exactly where the pipeline broke (no editors? no form ancestor? dupe-guarded?).
    if (!firstHitLogged && stats.editors > 0) {
      firstHitLogged = true;
      console.log(`${LOG} scan: ${stats.editors} editors / ${stats.forms} forms / ${stats.injected} injected`);
    } else if (!firstHitLogged && !zeroFormsWarned && now - scriptStartedAt > 10_000) {
      zeroFormsWarned = true;
      console.log(`${LOG} scan: 0 editors found after 10s. If you're on a messaging page and the ✨ button isn't visible, LinkedIn's compose-toolbar selectors likely changed — paste an outerHTML snippet of the reply box and we'll update the selector.`);
    }
  }

  // Initial sweep + observer. LinkedIn re-renders frequently so we re-scan
  // on DOM changes too.
  setInterval(scan, 1000);
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  function injectButtonsIntoAllComposeForms() {
    // Anchor on the editor (we have ground truth that
    // `.msg-form__contenteditable` exists from a real DOM excerpt).
    // From each editor, find the enclosing form-like container — this
    // tolerates LinkedIn renaming the outer `.msg-form` class.
    const editors = document.querySelectorAll('.msg-form__contenteditable');
    let formsFound = 0;
    let injected = 0;
    const seenForms = new WeakSet();

    editors.forEach((editor) => {
      const form =
        editor.closest('.msg-form') ||
        editor.closest('.msg-form-component') ||
        editor.closest('form') ||
        findFormByWalk(editor);
      if (!form) return;
      if (seenForms.has(form)) return; // multiple editors inside one form
      seenForms.add(form);
      formsFound += 1;

      if (form.querySelector(':scope .' + BUTTON_CLASS)) return; // dupe guard, scoped per form

      // Injection target cascade — prefer the existing icon row, then send
      // button's sibling area, then the expand-button row (confirmed
      // present in the user's DOM via the pasted snippet), then the form.
      const target =
        form.querySelector('.msg-form__left-actions') ||
        form.querySelector('.msg-form__footer') ||
        form.querySelector('.msg-form__send-button-container')?.parentElement ||
        form.querySelector('.msg-form__expand-btn-wrapper')?.parentElement ||
        form;
      if (!target) return;

      target.appendChild(createCopilotButton(form));
      injected += 1;
    });

    return { editors: editors.length, forms: formsFound, injected };
  }

  function findFormByWalk(editor) {
    // Walk up at most 8 levels, returning the deepest ancestor that
    // contains the editor AND at least one form-toolbar landmark. This
    // gives us a stable "form" even when LinkedIn renames the outer
    // .msg-form class.
    let node = editor.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const hasToolbar = !!(
        node.querySelector(':scope .msg-form__send-button-container') ||
        node.querySelector(':scope .msg-form__left-actions') ||
        node.querySelector(':scope .msg-form__footer') ||
        node.querySelector(':scope .msg-form__expand-btn-wrapper')
      );
      if (hasToolbar) return node;
      node = node.parentElement;
    }
    return editor.parentElement; // fallback so the button still appears
  }

  function createCopilotButton(form) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = 'TalentAI Copilot — AI reply assistant';
    btn.setAttribute('aria-label', 'TalentAI Copilot');
    btn.textContent = '✨';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCopilotMenu(form, btn);
    });
    return btn;
  }

  // ─── Anchored dropdown menu ───────────────────────────────────────

  function openCopilotMenu(form, anchorBtn) {
    document.getElementById(MENU_ID)?.remove(); // close any open menu

    const composeBox = form.querySelector('.msg-form__contenteditable');
    const existingText = (composeBox?.innerText || '').trim();
    const hasText = existingText.length > 0;

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.innerHTML = hasText
      ? `
        <div class="menu-header">✨ Improve your draft</div>
        <button data-mode="improve_existing">✏️ Polish this</button>
        <button data-mode="make_shorter">📏 Make shorter</button>
        <button data-mode="make_more_direct">🎯 Make more direct</button>
        <button data-mode="different_angle">🔄 Try different angle</button>
        <div class="menu-divider"></div>
        <button data-mode="generate_from_scratch" class="secondary">↻ Replace with fresh draft</button>
      `
      : `
        <div class="menu-header">✨ AI Reply Assistant</div>
        <button data-mode="generate_from_scratch">⚡ Generate reply</button>
      `;

    // Anchor menu above the button.
    const rect = anchorBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    menu.style.left = `${rect.left}px`;

    document.body.appendChild(menu);

    menu.querySelectorAll('button[data-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.getAttribute('data-mode');
        menu.remove();
        runCopilot(form, mode, existingText).catch((err) =>
          showIndicator(form, 'error', `⚠️ ${err?.message || String(err)}`, 5000),
        );
      });
    });

    // Close on outside click. setTimeout so this listener doesn't catch
    // the same click that opened the menu.
    setTimeout(() => {
      function onDocClick(e) {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', onDocClick);
        }
      }
      document.addEventListener('click', onDocClick);
    }, 0);
  }

  // ─── Main flow ────────────────────────────────────────────────────

  async function runCopilot(form, mode, existingText) {
    const composeBox = form.querySelector('.msg-form__contenteditable');
    if (!composeBox) {
      showIndicator(form, 'error', '⚠️ Could not find LinkedIn compose box.', 5000);
      return;
    }

    showIndicator(form, 'loading', '✨ Generating…');

    const conv = scrapeConversationForForm(form);
    if (!conv || !conv.recipientName || !conv.recipientLinkedinUrl) {
      showIndicator(form, 'error', '⚠️ Could not detect conversation context.', 5000);
      return;
    }

    // Fail-loud: refuse to send to the API if validateScrape flagged a
    // degenerate scrape. The scrape function logged the full diagnostic
    // trace; we just surface the error to the user here.
    if (conv.scrapeError) {
      console.warn(`${LOG} scrape validation FAILED:`, conv.scrapeError);
      showIndicator(form, 'error', `⚠️ ${conv.scrapeError}`, 6000);
      return;
    }

    // Trim to last 10 turns. The model only needs recent context and we
    // don't want to blow the prompt budget on very long threads.
    const recent = conv.messages.slice(-10);

    const payload = {
      recipientLinkedinUrl: conv.recipientLinkedinUrl,
      recipientName: conv.recipientName,
      recipientCompany: conv.recipientCompany || undefined,
      recipientTitle: conv.recipientTitle || undefined,
      conversationHistory: recent,
      mode,
      existingDraft: existingText || undefined,
    };

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        kind: 'copilot_draft_reply',
        payload,
      });
    } catch (err) {
      showIndicator(form, 'error', `⚠️ ${err?.message || String(err)}`, 5000);
      return;
    }

    if (!response || !response.ok) {
      const msg = response?.error || 'Failed to draft reply';
      const friendly = /no_session|session_expired/.test(msg)
        ? 'Please sign in to TalentAI from the extension popup first.'
        : msg;
      showIndicator(form, 'error', `⚠️ ${friendly}`, 5000);
      return;
    }

    const draft = response.draft;
    if (!draft || typeof draft.body !== 'string') {
      showIndicator(form, 'error', '⚠️ Empty draft from server. Please retry.', 5000);
      return;
    }

    replaceComposeBoxContent(composeBox, draft.body);

    // Build the success indicator with mode + intent + model so the user
    // can visually confirm Kimi was called and the right mode ran.
    const modeLabel = draft.conversationMode === 'followup' ? 'Followup' : formatIntent(draft.intent);
    const detail = draft.conversationMode === 'followup'
      ? ` (${draft.intent})` // e.g. (first_followup)
      : (typeof draft.confidence === 'number' ? ` (${draft.confidence}%)` : '');
    const modelTag = draft.model ? ` · ${draft.model}` : '';
    showIndicator(form, 'success', `✅ ${modeLabel}${detail}${modelTag}`, 4000);
  }

  // ─── Conversation scraping ────────────────────────────────────────

  function scrapeConversationForForm(composeForm) {
    console.log(`${LOG} === SCRAPE START ===`);

    // Thread container.
    const thread =
      composeForm.closest('.msg-thread, .msg-overlay-conversation-bubble') ||
      composeForm.closest('[data-msg-overlay-bubble]') ||
      document.querySelector('.msg-thread');
    if (!thread) {
      console.warn(`${LOG} No thread container found`);
      return null;
    }
    console.log(`${LOG} Thread container:`, (thread.className || '').toString().substring(0, 80));

    // Recipient info.
    const recipientNameEl =
      thread.querySelector('.msg-thread__link-to-profile h2') ||
      thread.querySelector('.msg-entity-lockup__entity-title') ||
      thread.querySelector('[class*="thread__link-to-profile"] h2') ||
      thread.querySelector('.msg-overlay-bubble-header__title') ||
      document.querySelector('.msg-overlay-bubble-header__title');
    const recipientName = recipientNameEl?.innerText?.trim() || '';

    const recipientLinkEl =
      thread.querySelector('.msg-thread__link-to-profile') ||
      thread.querySelector('a[href*="/in/"]');
    const rawHref = recipientLinkEl?.href || '';
    const recipientLinkedinUrl = rawHref ? rawHref.split('?')[0].split('#')[0] : '';

    console.log(`${LOG} Recipient:`, recipientName, '|', recipientLinkedinUrl);

    if (!recipientName || !recipientLinkedinUrl) {
      console.warn(`${LOG} Missing recipient name or URL`);
      return null;
    }

    // Signed-in user.
    const signedInUserName = getSignedInUserName();
    console.log(`${LOG} Signed-in user:`, signedInUserName || '(NOT DETECTED)');

    // Message elements — single-selector cascade.
    let items = thread.querySelectorAll('.msg-s-event-listitem');
    if (items.length === 0) items = thread.querySelectorAll('.msg-s-message-list__event');
    if (items.length === 0) items = thread.querySelectorAll('[class*="event-listitem"]');

    console.log(`${LOG} Found ${items.length} message elements`);

    if (items.length === 0) {
      console.warn(`${LOG} No message elements — DOM structure may have changed`);
      return {
        recipientName,
        recipientLinkedinUrl,
        recipientCompany: '',
        recipientTitle: '',
        messages: [],
        signedInUserName,
        scrapeError: 'Could not find any messages in this thread. LinkedIn DOM may have changed.',
      };
    }

    const messages = [];
    const seen = new Set();

    items.forEach((item, index) => {
      const bodyEl =
        item.querySelector('.msg-s-event-listitem__body') ||
        item.querySelector('.msg-s-message-list__paragraph') ||
        item.querySelector('[class*="event-listitem__body"]') ||
        item.querySelector('p');
      if (!bodyEl) {
        console.log(`${LOG} Msg ${index}: no body element, skipping`);
        return;
      }
      const body = bodyEl.innerText?.trim() || '';
      if (!body) {
        console.log(`${LOG} Msg ${index}: empty body, skipping`);
        return;
      }

      const dedupKey = `${index}|${body.substring(0, 100)}`;
      if (seen.has(dedupKey)) {
        console.log(`${LOG} Msg ${index}: duplicate, skipping`);
        return;
      }
      seen.add(dedupKey);

      const directionResult = detectMessageDirection(item, signedInUserName);

      const timeEl = item.querySelector('time') || item.querySelector('.msg-s-message-group__timestamp');
      const dt = timeEl?.getAttribute('datetime');
      const sentAt = dt && !isNaN(Date.parse(dt))
        ? new Date(dt).toISOString()
        : new Date(Date.now() - (items.length - index) * 60000).toISOString();

      console.log(`${LOG} Msg ${index}: direction=${directionResult.direction} (via ${directionResult.via}) | body="${body.substring(0, 60)}..."`);

      messages.push({
        direction: directionResult.direction,
        body,
        sentAt,
      });
    });

    const outboundN = messages.filter((m) => m.direction === 'outbound').length;
    const inboundN = messages.filter((m) => m.direction === 'inbound').length;
    console.log(`${LOG} Scrape complete: ${messages.length} messages`);
    console.log(`${LOG} Outbound: ${outboundN}`);
    console.log(`${LOG} Inbound:  ${inboundN}`);
    console.log(`${LOG} === SCRAPE END ===`);

    const validation = validateScrape(messages, signedInUserName);
    return {
      recipientName,
      recipientLinkedinUrl,
      recipientCompany: '',
      recipientTitle: '',
      messages,
      signedInUserName,
      scrapeError: validation.ok ? undefined : validation.reason,
    };
  }

  // ─── Compose-box driver ───────────────────────────────────────────

  function replaceComposeBoxContent(composeBox, newText) {
    composeBox.focus();
    // Select all existing content, then insertText replaces it. Dispatching
    // an InputEvent afterwards is what triggers LinkedIn's reactive form to
    // pick the change up (send button enables, character counter updates).
    try {
      const range = document.createRange();
      range.selectNodeContents(composeBox);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {
      // Best-effort — fall through to insertText
    }
    document.execCommand('insertText', false, newText);
    composeBox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }

  // ─── Status indicator ─────────────────────────────────────────────

  function showIndicator(form, state, text, autoHideMs) {
    form.querySelector('.' + INDICATOR_CLASS)?.remove();
    const el = document.createElement('div');
    el.className = `${INDICATOR_CLASS} ${state}`;
    el.textContent = text;
    form.appendChild(el);
    if (autoHideMs) {
      setTimeout(() => el.remove(), autoHideMs);
    }
  }

  function formatIntent(intent) {
    const map = {
      interested_qualifying: 'Interested',
      meeting_request: 'Meeting Request',
      pricing_inquiry: 'Pricing Question',
      objection_price: 'Price Objection',
      objection_timing: 'Timing Objection',
      objection_solution: 'Has Solution',
      objection_authority: 'Not Decision-Maker',
      info_request: 'Info Request',
      polite_decline: 'Polite Decline',
      hostile: 'Hostile',
      casual_chat: 'Casual',
      competitor_intel: 'Comparison',
    };
    return map[intent] || intent || 'Drafted';
  }
})();
