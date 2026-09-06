/* Isolated from face-api's tfjs 1.x — this worker loads tfjs 3 + coco-ssd. */
/* eslint-disable no-undef */
importScripts('/vendor/tf.min.js');
importScripts('/vendor/coco-ssd.min.js');

const ANIMALS = new Set([
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe'
]);

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'boat', 'train']);

let model = null;
let ready = false;
let canvas = null;

function kindOf(cls) {
  if (cls === 'person') return 'person';
  if (ANIMALS.has(cls)) return 'animal';
  if (VEHICLES.has(cls)) return 'vehicle';
  return 'thing';
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await pickBackend();
      const coco = self.cocoSsd;
      if (!coco || !coco.load) throw new Error('coco-ssd failed to load');
      model = await coco.load({
        base: 'mobilenet_v2',
        modelUrl: '/models/coco-ssd/model.json'
      });
      ready = true;
      self.postMessage({ type: 'ready', backend: tf.getBackend() });
      return;
    }
    if (msg.type === 'detect') {
      if (!ready || !model) {
        self.postMessage({ type: 'dets', id: msg.id, preds: [] });
        return;
      }
      const bitmap = msg.bitmap;
      const scale = Number(msg.scale || 1);
      const input = toCanvas(bitmap);
      const raw = await model.detect(input, 30, 0.22);
      if (bitmap && bitmap.close)
        try {
          bitmap.close();
        } catch (_) {
          /* ignore */
        }
      const preds = (raw || []).map((p) => {
        const [x, y, w, h] = p.bbox || [0, 0, 0, 0];
        const cls = String(p.class || 'object');
        const color = sampleColor(input, x, y, w, h);
        return {
          x: x * scale,
          y: y * scale,
          w: w * scale,
          h: h * scale,
          class: cls,
          label: pretty(cls),
          score: p.score,
          kind: kindOf(cls),
          color,
          colorName: color ? color.name : ''
        };
      });
      self.postMessage({ type: 'dets', id: msg.id, preds });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
  }
};

function toCanvas(bitmap) {
  if (!bitmap) return bitmap;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      }
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return canvas;
    }
  } catch (_) {
    /* use bitmap */
  }
  return bitmap;
}

function sampleColor(cnv, x, y, w, h) {
  try {
    if (!cnv || !cnv.getContext) return null;
    const ctx = cnv.getContext('2d');
    const sx = Math.max(0, Math.floor(x + w * 0.28));
    const sy = Math.max(0, Math.floor(y + h * 0.28));
    const sw = Math.max(4, Math.min(Math.floor(w * 0.44), (cnv.width || 0) - sx));
    const sh = Math.max(4, Math.min(Math.floor(h * 0.44), (cnv.height || 0) - sy));
    if (sw < 4 || sh < 4) return null;
    const { data } = ctx.getImageData(sx, sy, sw, sh);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 16) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return null;
    r = Math.round(r / n);
    g = Math.round(g / n);
    b = Math.round(b / n);
    return { r, g, b, name: colorName(r, g, b) };
  } catch (_) {
    return null;
  }
}

function colorName(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d < 28) {
    if (l < 35) return 'black';
    if (l < 85) return 'dark gray';
    if (l < 155) return 'gray';
    if (l < 215) return 'silver';
    return 'white';
  }
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  if (h < 15 || h >= 345) return l < 70 ? 'dark red' : 'red';
  if (h < 40) return l > 170 ? 'tan' : 'orange';
  if (h < 70) return 'yellow';
  if (h < 155) return l < 70 ? 'dark green' : 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return l < 70 ? 'navy' : 'blue';
  if (h < 295) return 'purple';
  return 'pink';
}

async function pickBackend() {
  try {
    if (typeof OffscreenCanvas !== 'undefined' && (await tf.setBackend('webgl'))) {
      await tf.ready();
      return;
    }
  } catch (_) {
    /* fall through */
  }
  await tf.setBackend('cpu');
  await tf.ready();
}

function pretty(cls) {
  return String(cls)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
