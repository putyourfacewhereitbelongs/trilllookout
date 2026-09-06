import { getPerf } from './perf.js';

const VISION_PATH = '/api/vision/analyze';
const listeners = new Set();
let ready = true;
let failed = false;
let localWorker = null;
let localReady = false;
let seq = 1;
const waiters = new Map();

export function onMoondream(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(status, detail) {
  for (const fn of listeners) {
    try {
      fn(status, detail);
    } catch {
      /* ignore */
    }
  }
}

export function startMoondream() {
  emit('status', 'Trill Vision at trycloudflare.com/analyze');
  emit('ready', 'trill-vision');
  ready = true;
  failed = false;
  return true;
}

export function moondreamReady() {
  return ready && !failed;
}

function buildPrompt(hints) {
  const bits = [];
  if (hints && hints.names && hints.names.length) bits.push('Known people in this house: ' + hints.names.join(', ') + '. Use those names if they match.');
  if (hints && hints.animals && hints.animals.length) bits.push('Named animals: ' + hints.animals.join(', ') + '.');
  if (hints && hints.objects && hints.objects.length) bits.push('Detector already saw: ' + hints.objects.slice(0, 12).join(', ') + '.');
  return (
    'Describe this security camera frame in detail. Identify every person (clothing, hair, estimated age or gender), every animal (kind, color, count), every vehicle (kind and color), and other objects. Say what each is doing and where they are in the frame. Do not talk about motion intensity or lighting unless that is the only thing visible.' +
    (bits.length ? ' ' + bits.join(' ') : '')
  );
}

function frameToBlob(source) {
  const vw = source.videoWidth || source.width || 0;
  const vh = source.videoHeight || source.height || 0;
  if (!vw || !vh) return null;
  const maxW = getPerf().level === 'low' ? 384 : 512;
  const scale = Math.min(1, maxW / vw);
  const w = Math.max(16, Math.round(vw * scale));
  const h = Math.max(16, Math.round(vh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  try {
    c.getContext('2d').drawImage(source, 0, 0, w, h);
  } catch {
    return null;
  }
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.72));
}

export async function describeFrame(source, hints) {
  startMoondream();
  if (!source) return '';
  const blob = await frameToBlob(source);
  if (!blob) return '';
  const prompt = buildPrompt(hints);
  try {
    const fd = new FormData();
    fd.append('image', blob, 'frame.jpg');
    fd.append('prompt', prompt);
    const res = await fetch(VISION_PATH, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    const text = String(data.response || data.caption || data.text || data.description || '').trim();
    if (text) {
      failed = false;
      return text;
    }
    if (!res.ok) emit('error', data.error || 'Vision API ' + res.status);
  } catch (err) {
    emit('error', (err && err.message) || 'Vision API failed');
  }
  return describeFrameLocal(source, hints);
}

function startLocalWorker() {
  if (getPerf().skipLocalVision) return null;
  if (localWorker || typeof Worker === 'undefined') return localWorker;
  try {
    localWorker = new Worker('/js/moondream-worker.js', { type: 'module' });
  } catch (err) {
    emit('error', err && err.message);
    return null;
  }
  localWorker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'ready') {
      localReady = true;
      emit('ready', 'local-' + (msg.device || 'wasm'));
      return;
    }
    if (msg.type === 'status') {
      emit('status', msg.message || '');
      return;
    }
    if (msg.type === 'caption' && waiters.has(msg.id)) {
      const fn = waiters.get(msg.id);
      waiters.delete(msg.id);
      fn(msg.text || '');
      return;
    }
    if (msg.type === 'error') {
      emit('error', msg.error || 'Local Moondream error');
      if (msg.id && waiters.has(msg.id)) {
        const fn = waiters.get(msg.id);
        waiters.delete(msg.id);
        fn('');
      }
    }
  };
  localWorker.onerror = (err) => emit('error', (err && err.message) || 'Local worker failed');
  localWorker.postMessage({ type: 'init' });
  return localWorker;
}

function describeFrameLocal(source, hints) {
  startLocalWorker();
  if (!localWorker) return Promise.resolve('');
  const vw = source.videoWidth || source.width || 0;
  const vh = source.videoHeight || source.height || 0;
  if (!vw || !vh) return Promise.resolve('');
  const maxW = 384;
  const scale = Math.min(1, maxW / vw);
  const w = Math.max(16, Math.round(vw * scale));
  const h = Math.max(16, Math.round(vh * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  try {
    c.getContext('2d').drawImage(source, 0, 0, w, h);
  } catch {
    return Promise.resolve('');
  }
  const img = c.getContext('2d').getImageData(0, 0, w, h);
  const id = seq++;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiters.delete(id);
      resolve('');
    }, 40000);
    waiters.set(id, (text) => {
      clearTimeout(t);
      resolve(text);
    });
    try {
      localWorker.postMessage({ type: 'caption', id, width: w, height: h, rgba: img.data, hints: hints || null }, [img.data.buffer]);
    } catch {
      clearTimeout(t);
      waiters.delete(id);
      resolve('');
    }
  });
}
