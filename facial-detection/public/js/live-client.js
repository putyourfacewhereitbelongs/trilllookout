import { absUrl } from './origin.js';
import { getPerf } from './perf.js';

export function publishLoop(video, camId, name, kind, getMeta) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let timer = 0;
  let dead = false;
  const camKind = kind || 'host';

  async function tick() {
    if (dead) return;
    try {
      if (!video.videoWidth) return;
      const w = getPerf().publishW || 560;
      const h = Math.max(16, Math.round((video.videoHeight * w) / video.videoWidth));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', getPerf().publishQ || 0.52));
      if (!blob) return;
      const fd = new FormData();
      fd.append('jpeg', blob, 'frame.jpg');
      fd.append('name', name || camId);
      fd.append('width', String(video.videoWidth));
      fd.append('height', String(video.videoHeight));
      fd.append('kind', camKind);
      const extra = typeof getMeta === 'function' ? getMeta() : null;
      if (extra && extra.caption) fd.append('caption', String(extra.caption).slice(0, 500));
      if (extra && extra.faces) {
        fd.append('faces', typeof extra.faces === 'string' ? extra.faces : JSON.stringify(extra.faces));
      }
      await fetch('/api/live/' + encodeURIComponent(camId) + '/frame', { method: 'POST', body: fd });
    } catch {
      /* keep going */
    }
  }

  timer = setInterval(tick, getPerf().publishMs || 220);
  tick();
  return () => {
    dead = true;
    clearInterval(timer);
    fetch('/api/live/' + encodeURIComponent(camId) + '/dead', { method: 'POST' }).catch(() => {});
  };
}

export function mjpegSrc(camId) {
  return absUrl('/api/live/' + encodeURIComponent(camId) + '/mjpeg');
}

export function jpegSrc(camId) {
  return absUrl('/api/live/' + encodeURIComponent(camId) + '/jpeg') + '?t=' + Date.now();
}
