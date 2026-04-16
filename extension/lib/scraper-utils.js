// ─── DOM scraping utilities (injected into content scripts) ────────────────
// NOTE: this file is injected via chrome.scripting.executeScript alongside
// each site-specific adapter. It exposes helpers on `window.__talentaiUtils`.

(() => {
  if (window.__talentaiUtils) return; // avoid re-injection

  function waitForSelector(selector, { timeout = 15000, root = document } = {}) {
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);

      const obs = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(root === document ? document.documentElement : root, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`waitForSelector timeout: ${selector}`));
      }, timeout);
    });
  }

  async function waitForSelectorAll(selector, { min = 1, timeout = 15000, root = document } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const all = root.querySelectorAll(selector);
      if (all.length >= min) return all;
      await sleep(250);
    }
    return root.querySelectorAll(selector);
  }

  async function scrollContainer(el, { steps = 10, delayMs = 800 } = {}) {
    if (!el) return;
    for (let i = 0; i < steps; i++) {
      const prev = el.scrollTop;
      el.scrollBy(0, Math.max(400, el.clientHeight * 0.9));
      await sleep(delayMs);
      if (el.scrollTop === prev) break; // reached bottom
    }
  }

  async function scrollToBottom({ steps = 8, delayMs = 800 } = {}) {
    for (let i = 0; i < steps; i++) {
      const prev = window.scrollY;
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(delayMs);
      if (window.scrollY === prev) break;
    }
  }

  function extractText(el, selector) {
    if (!el) return '';
    const target = selector ? el.querySelector(selector) : el;
    if (!target) return '';
    return (target.textContent ?? '').trim().replace(/\s+/g, ' ');
  }

  function extractAttribute(el, selector, attr) {
    if (!el) return '';
    const target = selector ? el.querySelector(selector) : el;
    if (!target) return '';
    return target.getAttribute(attr) ?? '';
  }

  function safeClick(el) {
    if (!el) return false;
    try {
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function randomDelay(baseMs, pct = 0.3) {
    const jitter = (Math.random() * 2 - 1) * pct * baseMs;
    return sleep(Math.max(0, Math.round(baseMs + jitter)));
  }

  function absoluteUrl(href) {
    if (!href) return '';
    try { return new URL(href, location.href).toString(); } catch (_) { return href; }
  }

  window.__talentaiUtils = {
    waitForSelector,
    waitForSelectorAll,
    scrollContainer,
    scrollToBottom,
    extractText,
    extractAttribute,
    safeClick,
    sleep,
    randomDelay,
    absoluteUrl,
  };
})();
