/** Optional color night vision — never B&W. Low-latency canvas overlay. */
import { getPerf } from './perf.js';

const overlays = new WeakMap();

export function attachNightVision(video, on) {
  if (!video) return;
  let rec = overlays.get(video);
  if (!on) {
    if (rec) {
      rec.stop();
      overlays.delete(video);
    }
    return;
  }
  if (rec) {
    rec.on = true;
    return rec;
  }
  rec = start(video);
  overlays.set(video, rec);
  return rec;
}

function start(video) {
  const canvas = document.createElement('canvas');
  canvas.className = 'nv-overlay';
  canvas.setAttribute('aria-hidden', 'true');
  const parent = video.parentElement;
  if (parent) {
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(canvas);
  }
  const ctx = canvas.getContext('2d', { alpha: false });
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let running = true;
  let handle = 0;

  function layout() {
    const w = video.clientWidth || video.videoWidth || 640;
    const h = video.clientHeight || video.videoHeight || 360;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '2';
    const pw = Math.max(120, Math.min(getPerf().nvMax || 480, w));
    const ph = Math.max(90, Math.round((h * pw) / Math.max(1, w)));
    if (small.width !== pw) {
      small.width = pw;
      small.height = ph;
    }
    if (canvas.width !== pw) {
      canvas.width = pw;
      canvas.height = ph;
    }
  }

  let nvN = 0;
  function frame() {
    if (!running) return;
    handle = requestAnimationFrame(frame);
    if (!video.videoWidth) return;
    nvN += 1;
    if (nvN % (getPerf().nvSkip || 1) !== 0) return;
    layout();
    try {
      sctx.drawImage(video, 0, 0, small.width, small.height);
      const img = sctx.getImageData(0, 0, small.width, small.height);
      colorize(img.data);
      sctx.putImageData(img, 0, 0);
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
    } catch {
      /* tainted */
    }
  }

  handle = requestAnimationFrame(frame);
  return {
    on: true,
    stop() {
      running = false;
      cancelAnimationFrame(handle);
      canvas.remove();
    }
  };
}

function colorize(data) {
  let min = 255;
  let max = 0;
  let chroma = 0;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < min) min = y;
    if (y > max) max = y;
    chroma += Math.abs(r - g) + Math.abs(g - b);
  }
  const samples = data.length / 16;
  const grayish = chroma / samples < 18;
  const lo = Math.max(0, min - 4);
  const hi = Math.max(lo + 12, max);
  const gain = 255 / (hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const ys = Math.max(0, Math.min(255, (y - lo) * gain * 1.15));
    if (grayish) {
      const t = ys / 255;
      data[i] = Math.min(255, ys * 0.55 + t * t * 140);
      data[i + 1] = Math.min(255, ys * 1.05 + 20);
      data[i + 2] = Math.min(255, ys * 0.7 + 40 * (1 - t));
    } else {
      const cr = r - y;
      const cg = g - y;
      const cb = b - y;
      data[i] = clamp(ys + cr * 2.1);
      data[i + 1] = clamp(ys + cg * 2.1);
      data[i + 2] = clamp(ys + cb * 2.1);
    }
  }
}

function clamp(n) {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
