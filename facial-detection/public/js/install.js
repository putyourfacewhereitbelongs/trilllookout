import { absUrl } from './origin.js';

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true
  );
}

export function setupInstall() {
  lockPwaChrome();
  setupScrollHint();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
  if (isStandalone()) {
    showPermissionCoach(true);
    return;
  }
  if (document.getElementById('installBanner')) return;

  const bar = document.createElement('div');
  bar.id = 'installBanner';
  bar.className = 'install-banner';
  bar.innerHTML = `
    <div class="install-copy">
      <strong>Install Trill Lookout AI Cam</strong>
      <span>Adds a home-screen app with no browser bar, live alerts, and offline models.</span>
    </div>
    <div class="install-actions">
      <button type="button" class="btn primary" id="installGo">Install</button>
      <button type="button" class="btn ghost" id="installLater">Later</button>
    </div>`;
  document.body.appendChild(bar);

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    bar.classList.add('show');
  });

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && !isStandalone()) bar.classList.add('show');

  bar.querySelector('#installLater').onclick = () => bar.classList.remove('show');
  bar.querySelector('#installGo').onclick = async () => {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => ({}));
      deferred = null;
      bar.classList.remove('show');
      if (choice && choice.outcome === 'accepted') showPermissionCoach(true);
      return;
    }
    if (ios) {
      alert('On iPhone: tap Share, then Add to Home Screen. That hides the address bar and installs Lookout.');
      return;
    }
    window.open(absUrl('/'), '_blank', 'noopener');
  };
}

function lockPwaChrome() {
  if (!isStandalone()) return;
  document.documentElement.classList.add('pwa');
  document.body.classList.add('pwa');
  document.documentElement.style.touchAction = 'pan-y';
  document.body.style.touchAction = 'pan-y';
  document.documentElement.style.overflowY = 'scroll';
  document.body.style.overflowY = 'visible';
  document.body.style.height = 'auto';
}

function setupScrollHint() {
  if (document.getElementById('scrollHint')) return;
  const hint = document.createElement('button');
  hint.id = 'scrollHint';
  hint.type = 'button';
  hint.className = 'scroll-hint';
  hint.setAttribute('aria-label', 'More below. Scroll down.');
  hint.innerHTML = '<span>More below</span><span class="chev" aria-hidden="true">▼</span>';
  document.body.appendChild(hint);
  hint.onclick = () => window.scrollBy({ top: Math.round(window.innerHeight * 0.7), behavior: 'smooth' });
  const check = () => {
    const small = window.matchMedia('(max-width: 960px)').matches;
    const room = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    hint.classList.toggle('show', small && room > 96);
  };
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  setTimeout(check, 400);
  setInterval(check, 2500);
}

export async function subscribePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const res = await fetch('/api/push/key');
    const data = await res.json();
    if (!data.publicKey) return false;
    const padding = '='.repeat((4 - (data.publicKey.length % 4)) % 4);
    const base64 = (data.publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const key = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) key[i] = raw.charCodeAt(i);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
    return true;
  } catch {
    return false;
  }
}

export function notificationsOn() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestKeepAlive() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      await navigator.wakeLock.request('screen');
    }
  } catch {
    /* not allowed until gesture */
  }
  if (notificationsOn()) await subscribePush();
}

export function showPermissionCoach(force) {
  if (document.getElementById('permCoach')) return;
  if (notificationsOn()) {
    try {
      localStorage.setItem('lookout_perm_done', '1');
    } catch {
      /* ignore */
    }
    subscribePush();
    return;
  }
  try {
    if (!force && sessionStorage.getItem('lookout_coach') === '1' && !isStandalone()) return;
    sessionStorage.setItem('lookout_coach', '1');
  } catch {
    /* ignore */
  }

  const viewer =
    (document.body && document.body.classList.contains('watch-page')) ||
    /watch\.html$/i.test(location.pathname || '');
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const el = document.createElement('div');
  el.className = 'modal perm-modal';
  el.id = 'permCoach';
  el.innerHTML = `<div class="modal-card perm-card" role="dialog" aria-labelledby="permTitle">
    <p class="perm-step">Alerts are off</p>
    <h2 id="permTitle">${denied ? 'Turn notifications back on' : 'Turn on alerts'}</h2>
    <p class="perm-body" id="permBody">${
      denied
        ? 'Notifications are blocked for this site. Open your browser or phone settings for Trill Lookout AI Cam and allow notifications so you get a looping GIF when someone is detected.'
        : viewer
          ? 'Alerts are disabled. Tap Allow, then choose Allow so this Home screen can show a looping GIF when a person, animal, or threat is detected.'
          : 'Alerts are disabled. Tap Allow, then choose Allow on the next prompt. You will see a looping GIF when a person, animal, or threat is detected.'
    }</p>
    <div class="row-btns perm-actions">
      <button type="button" class="btn primary perm-big" id="coachOk">${denied ? 'I turned them on' : 'Allow notifications'}</button>
      <button type="button" class="btn perm-big" id="coachSkip">Not now</button>
    </div>
  </div>`;
  document.body.appendChild(el);

  const close = () => el.remove();
  el.querySelector('#coachSkip').onclick = close;
  el.querySelector('#coachOk').onclick = async () => {
    try {
      if (!denied && 'Notification' in window) await Notification.requestPermission();
    } catch {
      /* ignore */
    }
    if (notificationsOn()) {
      try {
        localStorage.setItem('lookout_perm_done', '1');
      } catch {
        /* ignore */
      }
      await subscribePush();
      close();
      return;
    }
    el.querySelector('#permTitle').textContent = 'Still off';
    el.querySelector('#permBody').textContent =
      'Notifications are still disabled. Enable them in your browser or phone settings for this site, then tap again.';
    el.querySelector('#coachOk').textContent = 'Check again';
  };
}
