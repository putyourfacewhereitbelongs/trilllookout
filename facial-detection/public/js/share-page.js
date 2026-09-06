import { mountNav } from './nav.js';
import { setupInstall } from './install.js';
import { rememberHostOrigin } from './persist.js';
import { shareQuery, qrPngSrc, appOrigin } from './origin.js';

mountNav('share');
setupInstall();
rememberHostOrigin();

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function load() {
  const cam = new URLSearchParams(location.search).get('cam') || '';
  const res = await fetch(shareQuery({ cam }));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Share failed');
  const img = document.getElementById('shareQrBig');
  const primary = data.primary || appOrigin() + '/';
  img.src = data.qrPng || qrPngSrc(primary, { cam });
  img.onerror = () => {
    if (data.qr) img.src = data.qr;
  };
  document.getElementById('sharePrimary').textContent = primary;
  document.getElementById('shareUrls').innerHTML = (data.urls || [])
    .map((u) => '<li><a href="' + u.replace(/"/g, '') + '">' + u.replace(/</g, '') + '</a></li>')
    .join('');
  return { ...data, primary };
}

let share = null;
load()
  .then((d) => {
    share = d;
  })
  .catch((e) => toast(e.message, 'err'));

document.getElementById('btnCopyShare').onclick = async () => {
  try {
    await navigator.clipboard.writeText((share && share.primary) || location.origin + '/watch.html');
    toast('Link copied');
  } catch (err) {
    toast(err.message, 'err');
  }
};

document.getElementById('btnNativeShare').onclick = async () => {
  try {
    const url = (share && share.primary) || location.origin + '/';
    if (navigator.share) await navigator.share({ title: 'Trill Lookout AI Cam', url, text: 'Live cameras' });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') toast(err.message, 'err');
  }
};

document.getElementById('btnShareQr').onclick = async () => {
  const img = document.getElementById('shareQrBig');
  img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    if (navigator.share && share && share.primary) {
      await navigator.share({ title: 'Scan to open Lookout cameras', url: share.primary, text: share.primary });
    } else {
      toast('Show this QR — scanning opens the live cameras on this host');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('Show this QR to the other phone');
  }
};
