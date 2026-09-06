import { mountNav } from './nav.js';
import { appOrigin, absUrl } from './origin.js';
import { replayTutorial } from './tutorial.js';
import { setupInstall } from './install.js';
import { bindIpCameras } from './ip-cameras.js';

mountNav(location.hash === '#cameras' ? 'cameras' : 'settings');
setupInstall();
document.getElementById('originLabel').textContent = appOrigin();
document.getElementById('googleRedirect').textContent = absUrl('/api/google/callback');

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fillForm(form, values) {
  if (!form || !values) return;
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = values[el.name];
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
  }
}

function payload(form) {
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
  }
  return body;
}

function updateRangeLabels() {
  document.querySelectorAll('[data-for]').forEach((span) => {
    const input = document.querySelector('[name="' + span.dataset.for + '"]');
    if (input) span.textContent = input.value;
  });
}

async function loadEmail() {
  const email = await api('/api/nvr/email');
  fillForm(document.getElementById('emailForm'), email);
  const st = document.getElementById('googleStatus');
  if (email.googleConnected && email.googleEmail) st.textContent = 'Sending as ' + email.googleEmail + ' via Google.';
  else if (email.googleConfigured) st.textContent = 'Client saved. Connect Google to pick the sending Gmail.';
  else st.textContent = 'Connect Google so this host can send alert GIFs from your Gmail.';
}

async function loadConfig() {
  const cfg = await api('/api/config');
  const nvrVals = { ...cfg, alertCooldownSec: Math.round(Number(cfg.alertCooldownMs || 120000) / 1000) };
  fillForm(document.getElementById('nvrForm'), nvrVals);
  fillForm(document.getElementById('settingsForm'), cfg);
  updateRangeLabels();
}

async function loadCams() {
  const list = await api('/api/cameras');
  const el = document.getElementById('savedCams');
  if (!list.length) {
    el.innerHTML = '<p class="muted small">No saved IP cameras yet.</p>';
    return;
  }
  el.innerHTML = list
    .map(
      (c) => `<article class="person-card" data-id="${c.id}">
      <div class="meta"><h3>${c.name}</h3><span class="muted small">${c.brand || c.type} · ${c.url}</span></div>
      <div class="tools"><button class="icon-btn" data-del="${c.id}">✕</button></div>
    </article>`
    )
    .join('');
}

document.getElementById('btnGoogle').onclick = async () => {
  try {
    const st = await api('/api/google/status');
    if (!st.configured) {
      toast('Paste Client ID and secret, Save client, then Connect Google', 'err');
      document.getElementById('googleClientId').focus();
      return;
    }
  } catch {
    /* continue */
  }
  window.location.href = '/api/google/start';
};
if (document.getElementById('btnCopyRedirect')) {
  document.getElementById('btnCopyRedirect').onclick = async () => {
    try {
      await navigator.clipboard.writeText(absUrl('/api/google/callback'));
      toast('Redirect URI copied — paste it in Google Cloud');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}
document.getElementById('btnGoogleDisconnect').onclick = async () => {
  try {
    await api('/api/google/disconnect', { method: 'POST' });
    await loadEmail();
    toast('Google disconnected');
  } catch (err) {
    toast(err.message, 'err');
  }
};
document.getElementById('btnSaveGoogleClient').onclick = async () => {
  try {
    const data = await api('/api/google/client', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: document.getElementById('googleClientId').value,
        clientSecret: document.getElementById('googleClientSecret').value
      })
    });
    toast(data.configured ? 'Client saved — Connect Google' : 'Need both client ID and secret', data.configured ? '' : 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
};
document.getElementById('btnTestEmail').onclick = async () => {
  try {
    const r = await api('/api/nvr/email/test', { method: 'POST' });
    toast('Test email sent' + (r.to ? ' to ' + r.to : ''));
  } catch (err) {
    toast(err.message, 'err');
  }
};
document.getElementById('emailForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/nvr/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(e.target))
    });
    toast('Email settings saved');
    await loadEmail();
  } catch (err) {
    toast(err.message, 'err');
  }
};

document.getElementById('nvrForm').addEventListener('input', updateRangeLabels);
document.getElementById('nvrForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = payload(e.target);
  if (body.alertCooldownSec != null) {
    body.alertCooldownMs = Number(body.alertCooldownSec) * 1000;
    delete body.alertCooldownSec;
  }
  try {
    await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Recording settings saved');
  } catch (err) {
    toast(err.message, 'err');
  }
};
document.getElementById('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(e.target)) });
    toast('Accuracy saved');
  } catch (err) {
    toast(err.message, 'err');
  }
};

document.getElementById('btnReplay').onclick = () => replayTutorial();

bindIpCameras({ toast, api });

const qs = new URLSearchParams(location.search);
if (qs.get('google') === '1') {
  toast('Google connected');
  history.replaceState({}, '', location.pathname + location.hash);
} else if (qs.get('google') === 'need') {
  const need = document.getElementById('googleNeed');
  const redirect = qs.get('redirect') || absUrl('/api/google/callback');
  if (need) need.textContent = 'Google needs a client ID first. Add this redirect URI in Google Cloud, save both fields, then Connect Google: ' + redirect;
  toast('Set a Google OAuth client ID first — paste it below', 'err');
} else if (qs.get('google') === 'error') {
  toast(qs.get('msg') || 'Google login failed', 'err');
  const need = document.getElementById('googleNeed');
  if (need) need.textContent = qs.get('msg') || 'Google login failed';
}

loadEmail().catch((e) => toast(e.message, 'err'));
loadConfig().catch((e) => toast(e.message, 'err'));
