// ─── Popup UI controller ────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  statusBadge: $('status-badge'),
  // signed-out
  signinSection: $('signin-section'),
  serverUrl: $('server-url'),
  email: $('email'),
  password: $('password'),
  signinBtn: $('signin-btn'),
  signinError: $('signin-error'),
  // signed-in
  accountSection: $('account-section'),
  userLine: $('user-line'),
  signoutBtn: $('signout-btn'),
  taskSection: $('task-section'),
  agentLine: $('agent-line'),
  currentTask: $('current-task'),
  pauseBtn: $('pause-btn'),
  resumeBtn: $('resume-btn'),
  usageSection: $('usage-section'),
  usageBody: $('usage-body'),
};

const DEFAULT_SERVER = 'http://localhost:3000';

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ kind: 'popup_get_state' });
    if (!state) return;

    setBadge(state.status || 'idle');

    if (!state.signedIn) {
      // Signed-out state
      els.signinSection.hidden = false;
      els.accountSection.hidden = true;
      els.taskSection.hidden = true;
      els.usageSection.hidden = true;
      if (!els.serverUrl.value) {
        els.serverUrl.value = state.serverUrl || DEFAULT_SERVER;
      }
      return;
    }

    // Signed-in state
    els.signinSection.hidden = true;
    els.accountSection.hidden = false;
    els.taskSection.hidden = false;
    els.usageSection.hidden = false;

    const user = state.user || {};
    const tenant = state.tenant || {};
    els.userLine.innerHTML = `
      <strong>${escapeHtml(user.name || user.email || 'Signed in')}</strong>
      <span class="tenant">${escapeHtml(tenant.name || '')}</span>
    `;

    els.pauseBtn.hidden = !!state.paused;
    els.resumeBtn.hidden = !state.paused;

    if (state.masterAgentName) {
      els.agentLine.textContent = `Scraping for: ${state.masterAgentName}`;
      els.agentLine.hidden = false;
    } else {
      els.agentLine.hidden = true;
    }

    if (state.currentTask) {
      const { site, taskType, params } = state.currentTask;
      const hint = params?.role || params?.query || params?.linkedinUrl || params?.mapsUrl || '';
      els.currentTask.textContent = `${site}/${taskType}  ${hint}`.trim();
      els.currentTask.classList.remove('muted');
    } else {
      els.currentTask.textContent = 'Waiting for work…';
      els.currentTask.classList.add('muted');
    }

    renderUsage(state.usage || []);
  } catch (err) {
    console.warn('popup refresh failed', err);
  }
}

function setBadge(status) {
  els.statusBadge.textContent = status;
  els.statusBadge.className = `badge ${status}`;
}

function renderUsage(rows) {
  els.usageBody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const pct = Math.min(100, Math.round((r.used / r.cap) * 100));
    tr.innerHTML = `
      <td>${escapeHtml(r.site)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${r.used} / ${r.cap} <span class="muted">(${pct}%)</span></td>
    `;
    els.usageBody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function humanizeError(code) {
  const map = {
    missing_server_url: 'Please enter the server URL.',
    missing_credentials: 'Please enter your email and password.',
    malformed_login_response: 'Unexpected response from the server.',
    key_provision_failed: 'Signed in, but could not provision a connection key.',
    malformed_key_response: 'Signed in, but connection key was malformed.',
  };
  if (map[code]) return map[code];
  if (/login_failed:401/.test(code)) return 'Invalid email or password.';
  if (/login_failed:/.test(code)) return 'Sign-in failed. Check the server URL.';
  if (/Failed to fetch|NetworkError/i.test(code)) return 'Could not reach the server.';
  return code;
}

function showSigninError(msg) {
  els.signinError.textContent = humanizeError(msg);
  els.signinError.hidden = false;
}

function clearSigninError() {
  els.signinError.textContent = '';
  els.signinError.hidden = true;
}

// ─── Events ────────────────────────────────────────────────────────────────
els.signinBtn.addEventListener('click', async () => {
  clearSigninError();
  const serverUrl = els.serverUrl.value.trim() || DEFAULT_SERVER;
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) {
    showSigninError('missing_credentials');
    return;
  }
  els.signinBtn.disabled = true;
  els.signinBtn.textContent = 'Signing in…';
  try {
    const res = await chrome.runtime.sendMessage({
      kind: 'popup_signin',
      serverUrl, email, password,
    });
    if (!res?.ok) {
      showSigninError(res?.error || 'unknown_error');
      return;
    }
    els.password.value = '';
    setTimeout(refresh, 300);
  } catch (err) {
    showSigninError(err?.message || 'unknown_error');
  } finally {
    els.signinBtn.disabled = false;
    els.signinBtn.textContent = 'Sign in';
  }
});

els.signoutBtn.addEventListener('click', async () => {
  els.signoutBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ kind: 'popup_signout' });
  } finally {
    els.signoutBtn.disabled = false;
    setTimeout(refresh, 200);
  }
});

els.pauseBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'popup_toggle_pause' });
  setTimeout(refresh, 150);
});
els.resumeBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'popup_toggle_pause' });
  setTimeout(refresh, 150);
});

// Background broadcasts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'status' || msg?.kind === 'current_task') {
    refresh();
  }
});

// Submit on Enter in the password field
els.password.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.signinBtn.click();
});

refresh();
setInterval(refresh, 3000);
