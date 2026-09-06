/** Links always follow the origin the page was opened on (localhost, LAN IP, or domain). */
export function appOrigin() {
  return window.location.origin;
}

export function absUrl(path) {
  const p = path || '/';
  if (/^https?:\/\//i.test(p)) return p;
  return new URL(p, window.location.origin).href;
}

export function shareQuery(extra) {
  const u = new URL('/api/share', appOrigin());
  u.searchParams.set('origin', appOrigin());
  if (extra && extra.cam) u.searchParams.set('cam', extra.cam);
  return u.pathname + u.search;
}

export function qrPngSrc(target, extra) {
  const u = new URL('/api/share/qr.png', appOrigin());
  u.searchParams.set('origin', appOrigin());
  if (target) u.searchParams.set('u', target);
  if (extra && extra.cam) u.searchParams.set('cam', extra.cam);
  return u.pathname + u.search;
}

export function navLinks() {
  const o = appOrigin();
  return [
    { id: 'live', href: o + '/', path: '/', label: 'Home', hint: 'Live cameras' },
    { id: 'host', href: o + '/host.html', path: '/host.html', label: 'Host', hint: 'This computer' },
    { id: 'alerts', href: o + '/#alerts', path: '/', label: 'Alerts', hint: 'GIF detections' },
    { id: 'videos', href: o + '/videos.html', path: '/videos.html', label: 'Videos', hint: 'DVR library' },
    { id: 'enroll', href: o + '/enroll.html', path: '/enroll.html', label: 'Enroll face', hint: 'Name a person' },
    { id: 'cameras', href: o + '/settings.html#cameras', path: '/settings.html', label: 'Cameras', hint: 'IP / Wyze' },
    { id: 'settings', href: o + '/settings.html', path: '/settings.html', label: 'Settings', hint: 'Email, tutorial' },
    { id: 'share', href: o + '/share.html', path: '/share.html', label: 'Share by QR', hint: 'Scan to join' }
  ];
}

export function currentNavId() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const hash = location.hash;
  if (hash === '#alerts') return 'alerts';
  if (path.endsWith('host.html')) return 'host';
  if (path === '/' || path === '/index.html' || path.endsWith('watch.html')) return 'live';
  if (path.endsWith('videos.html')) return 'videos';
  if (path.endsWith('enroll.html')) return 'enroll';
  if (path.endsWith('settings.html')) return hash === '#cameras' ? 'cameras' : 'settings';
  if (path.endsWith('share.html')) return 'share';
  if (path.endsWith('camera.html')) return 'live';
  return '';
}

export function cameraShareUrl(camId) {
  return absUrl('/?cam=' + encodeURIComponent(camId || 'host'));
}
