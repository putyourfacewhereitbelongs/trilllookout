import { getPerf } from './perf.js';

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

export { ANIMALS };

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'airplane', 'boat', 'train']);

export { VEHICLES };

export function cropBox(video, box, pad = 0.08) {
  if (!video || !box) return null;
  const vw = video.videoWidth || video.width || 0;
  const vh = video.videoHeight || video.height || 0;
  if (!vw || !vh) return null;
  const bw = Number(box.width != null ? box.width : box.w) || 0;
  const bh = Number(box.height != null ? box.height : box.h) || 0;
  const bx = Number(box.x) || 0;
  const by = Number(box.y) || 0;
  if (bw < 8 || bh < 8) return null;
  const side = Math.min(vw, vh, Math.max(bw, bh) * (1 + pad * 2));
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  let w = side;
  let h = side;
  let x = cx - w / 2;
  let y = cy - h / 2;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > vw) x = Math.max(0, vw - w);
  if (y + h > vh) y = Math.max(0, vh - h);
  w = Math.min(w, vw - x);
  h = Math.min(h, vh - y);
  if (w < 16 || h < 16) return null;
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}

export class ObjectDetector {
  constructor() {
    this.ready = false;
    this.busy = false;
    this.last = [];
    this.onDetect = null;
    this.onReady = null;
    this.onError = null;
    this._id = 1;
    this.pending = new Map();
    this.worker = null;
    try {
      this.worker = new Worker('/js/detect-worker.js');
      this.worker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'ready') {
          this.ready = true;
          if (this.onReady) this.onReady(msg.backend);
        } else if (msg.type === 'dets') {
          this.last = msg.preds || [];
          const pend = this.pending.get(msg.id);
          if (pend) {
            this.pending.delete(msg.id);
            pend(this.last);
          }
          if (this.onDetect) this.onDetect(this.last);
        } else if (msg.type === 'error') {
          for (const fn of this.pending.values()) fn(this.last);
          this.pending.clear();
          if (this.onError) this.onError(msg.error);
        }
      };
      this.worker.onerror = (err) => {
        this.busy = false;
        if (this.onError) this.onError(err.message || 'Object detector worker failed');
      };
      this.worker.postMessage({ type: 'init' });
    } catch (err) {
      if (this.onError) this.onError(err.message);
    }
  }

  tick(video) {
    if (!this.worker || !this.ready || !video || !video.videoWidth) return Promise.resolve(this.last);
    if (this.busy) return Promise.resolve(this.last);
    this.busy = true;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const w = getPerf().cocoW || 400;
    const h = Math.max(16, Math.round((vh * w) / vw));
    const id = this._id++;
    return (async () => {
      try {
        const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h });
        const preds = await new Promise((resolve) => {
          const t = setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              resolve(this.last);
            }
          }, 2800);
          this.pending.set(id, (list) => {
            clearTimeout(t);
            resolve(list);
          });
          this.worker.postMessage({ type: 'detect', id, bitmap, scale: vw / w }, [bitmap]);
        });
        this.last = preds || [];
        return this.last;
      } catch (err) {
        if (this.onError) this.onError(err.message);
        return this.last;
      } finally {
        this.busy = false;
      }
    })();
  }

  stop() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }
}

export class SoundDetector {
  constructor(stream) {
    this.enabled = false;
    this.rms = 0;
    this.active = false;
    this.hits = 0;
    this.ctx = null;
    this.analyser = null;
    this.src = null;
    this.data = null;
    this.freq = null;
    this.kind = '';
    const tracks = stream && stream.getAudioTracks ? stream.getAudioTracks().filter((t) => t.enabled && t.readyState === 'live') : [];
    if (!tracks.length) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.45;
      this.src = this.ctx.createMediaStreamSource(new MediaStream([tracks[0]]));
      this.src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  sample(config) {
    if (!this.enabled) return { rms: 0, active: false, db: -Infinity, enabled: false, kind: '' };
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.analyser.getByteTimeDomainData(this.data);
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    this.rms = rms;
    const thresh = Number((config && config.soundThreshold) || 0.045);
    const raw = rms >= thresh;
    this.hits = raw ? this.hits + 1 : Math.max(0, this.hits - 2);
    const active = this.hits >= 2;
    this.active = active;
    const db = 20 * Math.log10(rms + 1e-6);
    const kind = active ? classifySound(this.freq, rms) : '';
    this.kind = kind;
    return { rms, active, db, enabled: true, kind };
  }

  stop() {
    try {
      if (this.src) this.src.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (this.ctx) this.ctx.close();
    } catch {
      /* ignore */
    }
    this.enabled = false;
  }
}

function classifySound(freq, rms) {
  if (!freq || !freq.length) return rms > 0.12 ? 'loud noise' : 'noise';
  const n = freq.length;
  let low = 0;
  let mid = 0;
  let high = 0;
  let peak = 0;
  let peakI = 0;
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const v = freq[i];
    sum += v;
    wsum += v * i;
    if (v > peak) {
      peak = v;
      peakI = i;
    }
    if (i < n * 0.06) low += v;
    else if (i < n * 0.28) mid += v;
    else high += v;
  }
  const tot = low + mid + high + 1;
  const centroid = wsum / (sum + 1);
  const peaky = peak > 140 && peak > (sum / n) * 6;
  if (peaky && peakI > n * 0.12 && peakI < n * 0.55) return 'alarm or beep';
  if (high / tot > 0.45 && rms > 0.1) return 'bang or impact';
  if (mid / tot > 0.42 && centroid > n * 0.05 && centroid < n * 0.3) return 'speech';
  if (low / tot > 0.55) return 'rumble';
  if (rms > 0.14) return 'loud noise';
  return 'noise';
}

export class SceneTracker {
  constructor() {
    this.items = [];
    this.nextId = 1;
  }

  update(objects, frameH) {
    const now = performance.now();
    const H = frameH || 720;
    const next = [];
    const used = new Set();
    for (const o of objects || []) {
      const cx = (Number(o.x) || 0) + (Number(o.w) || 0) / 2;
      const cy = (Number(o.y) || 0) + (Number(o.h) || 0) / 2;
      let best = -1;
      let bestD = 1e9;
      this.items.forEach((it, i) => {
        if (used.has(i)) return;
        if (it.class !== o.class) return;
        const d = Math.hypot(it.cx - cx, it.cy - cy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const maxD = Math.max(90, H * 0.22);
      let it;
      if (best >= 0 && bestD < maxD) {
        used.add(best);
        const prev = this.items[best];
        const dt = Math.max(16, now - (prev.updated || now));
        const x = prev.x * 0.55 + o.x * 0.45;
        const y = prev.y * 0.55 + o.y * 0.45;
        const w = prev.w * 0.55 + o.w * 0.45;
        const h = prev.h * 0.55 + o.h * 0.45;
        it = {
          id: prev.id,
          class: o.class,
          kind: o.kind,
          label: o.label || o.name || prev.label,
          name: o.name || prev.name || '',
          colorName: o.colorName || prev.colorName || '',
          color: o.color || prev.color,
          score: o.score,
          x,
          y,
          w,
          h,
          cx: x + w / 2,
          cy: y + h / 2,
          vx: (x - prev.x) / dt,
          vy: (y - prev.y) / dt,
          updated: now
        };
      } else {
        it = {
          id: this.nextId++,
          class: o.class,
          kind: o.kind,
          label: o.label || o.name || prettyNoun(o.class),
          name: o.name || '',
          colorName: o.colorName || '',
          color: o.color,
          score: o.score,
          x: o.x,
          y: o.y,
          w: o.w,
          h: o.h,
          cx,
          cy,
          vx: 0,
          vy: 0,
          updated: now
        };
      }
      it.action = actionOf(it, H);
      next.push(it);
    }
    for (let i = 0; i < this.items.length; i++) {
      if (used.has(i)) continue;
      const prev = this.items[i];
      if (now - prev.updated < 1200) next.push(prev);
    }
    this.items = next;
    return next;
  }

  follow(now) {
    const t = now || performance.now();
    return this.items.map((it) => {
      const dt = Math.min(450, Math.max(0, t - (it.updated || t)));
      const x = it.x + (it.vx || 0) * dt;
      const y = it.y + (it.vy || 0) * dt;
      return { ...it, x, y, cx: x + it.w / 2, cy: y + it.h / 2 };
    });
  }
}

function actionOf(it, H) {
  const speed = Math.hypot(it.vx || 0, it.vy || 0);
  const px = speed > 2 ? speed : speed * 16;
  const person = it.kind === 'person' || it.class === 'person';
  const walk = person ? 'walking' : 'moving';
  if (px < 5) {
    if (person && it.cy > H * 0.72 && it.w > it.h) return 'lying down';
    return 'in view';
  }
  const vertical = Math.abs(it.vy) > Math.abs(it.vx) * 1.05;
  if (vertical) return walk + (it.vy < 0 ? ' up' : ' down');
  return walk + (it.vx > 0 ? ' to the right' : ' to the left');
}

export function nameAnimals(objects, animals) {
  const list = animals || [];
  return (objects || []).map((o) => {
    if (o.kind !== 'animal' && !ANIMALS.has(String(o.class || '').toLowerCase())) return o;
    const species = String(o.class || '').toLowerCase();
    const matches = list.filter((a) => String(a.species || a.class || '').toLowerCase() === species);
    if (!matches.length) return o;
    const named = matches.length === 1 ? matches[0] : pickByColor(matches, o);
    if (!named) return o;
    return { ...o, name: named.name, label: named.name };
  });
}

function pickByColor(matches, obj) {
  if (obj && obj.color && matches.some((m) => m.color)) {
    let best = matches[0];
    let bestD = 1e9;
    for (const m of matches) {
      if (!m.color) continue;
      const d =
        Math.abs((m.color.r || 0) - obj.color.r) +
        Math.abs((m.color.g || 0) - obj.color.g) +
        Math.abs((m.color.b || 0) - obj.color.b);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }
  return matches[0];
}

export function personKind(age, gender, prob) {
  if (!gender || (prob != null && prob < 0.55)) return 'Person';
  return String(gender).toLowerCase() === 'female' ? 'Girl' : 'Boy';
}

export function describeScene({ faces, objects, motion, sound, lighting, source, durationSec, threats, tracks, narrative }) {
  const src = source === 'camera' ? 'the device camera' : source === 'screen' ? 'the host camera' : source || 'the camera';
  const faceBits = [];
  const people = [];
  const knownNames = [];
  for (const f of faces || []) {
    const lab = f.label || {};
    const kind = String(lab.kind || '').toLowerCase();
    if (lab.status === 'known' && lab.name) {
      people.push(lab.name);
      knownNames.push(lab.name);
      faceBits.push(lab.name);
    } else if (lab.status === 'uncertain' && lab.name) {
      const n = String(lab.name).replace(/\?$/, '');
      people.push(n);
      faceBits.push(n + '?');
    } else if (kind === 'girl' || kind === 'boy') {
      const noun = kind === 'girl' ? 'Girl' : 'Boy';
      people.push(noun);
      faceBits.push('an unrecognized ' + kind);
    } else if (lab.status === 'unknown' || lab.name) {
      people.push('Unknown');
      faceBits.push('an unrecognized person');
    }
  }

  const animals = [];
  const things = [];
  const vehicles = [];
  for (const o of objects || []) {
    const cls = String(o.class || o.label || '')
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (!cls || cls === 'person') continue;
    const color = o.colorName || (o.color && o.color.name) || '';
    const named = o.name || '';
    if (ANIMALS.has(cls) || o.kind === 'animal') {
      animals.push({ kind: prettyNoun(cls).toLowerCase(), name: named, color });
    } else if (VEHICLES.has(cls) || o.kind === 'vehicle') {
      vehicles.push({ kind: prettyNoun(cls).toLowerCase(), color });
    } else {
      things.push({ kind: prettyNoun(cls), color });
    }
  }
  const animalPhrase = countPhrase(animals, 'animal');
  const vehiclePhrase = countPhrase(vehicles, 'vehicle');
  const thingPhrase = countPhrase(things, 'object');
  const animalList = unique(animals.map((a) => a.name || cap(a.kind)));
  const thingList = unique(
    vehicles.map((v) => (v.color ? v.color + ' ' + v.kind : cap(v.kind))).concat(things.map((t) => (t.color ? t.color + ' ' + t.kind : t.kind)))
  );

  const motionLabel = intensity(motion && motion.score);
  const where = (motion && motion.where) || [];
  const whereText = where.length ? ' toward the ' + where.join(' and ') : '';
  const light = lighting || (motion && motion.lighting) || 'normal';
  const noisy = !!(sound && sound.active);
  const soundKind = (sound && sound.kind) || '';
  const cocoPeople = (objects || []).filter((o) => o.kind === 'person' || String(o.class || '').toLowerCase() === 'person').length;
  const hasWho = faceBits.length || cocoPeople || animalPhrase || vehiclePhrase || animalList.length || thingList.length;

  const threatBits = [];
  let fallWho = '';
  for (const th of threats || []) {
    const t = String(th.type || th);
    if (t.includes('fall')) {
      fallWho = knownNames[0] || '';
      threatBits.push(fallWho ? fallWho + ' fell' : 'a fall');
    } else if (t.includes('theft')) threatBits.push('possible theft');
    else if (t.includes('fight') || t.includes('violence') || t.includes('slap') || t.includes('strike'))
      threatBits.push('a physical threat');
    else threatBits.push(String(th.description || t).replace(/_/g, ' '));
  }

  const story = liveStory({
    tracks,
    faces,
    objects,
    animalList,
    thingList,
    animalPhrase,
    vehiclePhrase,
    thingPhrase,
    motionLabel,
    where,
    noisy,
    soundKind,
    light,
    threatBits,
    knownNames,
    cocoPeople
  });

  if (narrative && String(narrative).trim()) {
    const n = String(narrative).trim();
    story.live = n;
    story.sentence = n;
    if (!threatBits.length) {
      const head = n.split(/[.!?]/)[0].trim();
      if (head) story.title = head.slice(0, 96);
    }
  }

  const bits = [];
  if (threatBits.length) bits.push('ALERT: ' + joinNames(unique(threatBits)) + ' on ' + src + '.');
  if (story.sentence) bits.push(story.sentence);
  if (faceBits.length) bits.push('People in view: ' + joinNames(faceBits) + '.');
  else if (cocoPeople) bits.push((cocoPeople === 1 ? '1 person' : cocoPeople + ' people') + ' in view.');
  if (animalPhrase) bits.push(animalPhrase + '.');
  else if (animalList.length) bits.push('Animals: ' + joinNames(animalList) + '.');
  if (vehiclePhrase) bits.push(vehiclePhrase + ' in view.');
  if (thingPhrase) bits.push('Also visible: ' + thingPhrase.replace(/^There are \d+ objects:\s*/i, '') + '.');
  else if (thingList.length && !vehiclePhrase) bits.push('Also visible: ' + joinNames(thingList) + '.');
  if (!hasWho && !threatBits.length && !story.sentence) {
    if (noisy && soundKind) bits.push(cap(soundKind) + ' on ' + src + '.');
    else bits.push('Watching ' + src + '.');
  }
  if (light === 'very dark' || light === 'dim') bits.push('The scene is ' + light + '.');
  if (durationSec) bits.push('Clip length is ' + durationSec + ' seconds.');

  const title = story.title || fallbackTitle({ threatBits, fallWho, animalList, people, thingList, noisy, soundKind, source });

  return {
    title,
    description: bits.join(' '),
    live: story.live,
    people,
    animals: animalList,
    objects: thingList,
    motionLabel,
    lighting: light,
    where
  };
}

function liveStory({
  tracks,
  faces,
  objects,
  animalList,
  thingList,
  animalPhrase,
  vehiclePhrase,
  thingPhrase,
  motionLabel,
  where,
  noisy,
  soundKind,
  light,
  threatBits,
  knownNames,
  cocoPeople
}) {
  const parts = [];
  if (threatBits.length) parts.push(unique(threatBits).join(' · '));

  const personTrack = (tracks || []).find((t) => t.kind === 'person' || t.class === 'person');
  const who = knownNames[0] || (personTrack && personTrack.name) || '';
  if (personTrack && personTrack.action && personTrack.action !== 'in view') {
    const actor = who || 'A person';
    let line = actor + ' is ' + personTrack.action;
    if (where && where.length) line += ' at the ' + where[0].replace('-', ' ');
    parts.push(line);
  } else if (who) {
    parts.push(who + ' is in view');
  } else if ((faces || []).length) {
    parts.push(((faces || []).length === 1 ? '1 person' : (faces || []).length + ' people') + ' in view');
  } else if (cocoPeople) {
    parts.push((cocoPeople === 1 ? '1 person' : cocoPeople + ' people') + ' in view');
  }

  const animalTrack = (tracks || []).find((t) => t.kind === 'animal');
  if (animalPhrase) parts.push(animalPhrase);
  else if (animalTrack) {
    const n = animalTrack.name || animalTrack.label || prettyNoun(animalTrack.class);
    parts.push(n + (animalTrack.action && animalTrack.action !== 'in view' ? ' is ' + animalTrack.action : ' in view'));
  } else if (animalList.length) {
    parts.push(animalList[0] + ' in view');
  }

  if (vehiclePhrase) parts.push(vehiclePhrase);
  else {
    for (const o of (objects || []).slice(0, 6)) {
      const cls = String(o.class || '').toLowerCase();
      if (!cls || cls === 'person' || ANIMALS.has(cls) || o.kind === 'animal') continue;
      const color = o.colorName || (o.color && o.color.name) || '';
      parts.push((color ? color + ' ' : '') + prettyNoun(cls).toLowerCase());
    }
  }

  if (noisy && soundKind) parts.push(soundKind);
  if ((light === 'very dark' || light === 'dim') && parts.length < 3) parts.push(light);

  const live = unique(parts).slice(0, 8).join(' · ') || 'Watching the camera…';
  let title = '';
  if (threatBits.length) title = cap(threatBits[0]);
  else if (personTrack && personTrack.action && personTrack.action !== 'in view') {
    title = (who || 'Person') + ' ' + personTrack.action;
  } else if (who) title = who;
  else if (animalTrack) title = (animalTrack.name || prettyNoun(animalTrack.class)) + (animalTrack.action && animalTrack.action !== 'in view' ? ' ' + animalTrack.action : '');
  else if (animalList.length) title = animalList[0];
  else if (thingList.length) title = thingList[0];
  else if (noisy && soundKind) title = cap(soundKind);
  else title = who || animalList[0] || thingList[0] || 'Camera view';

  let sentence = '';
  if (personTrack && personTrack.action && personTrack.action !== 'in view') {
    sentence = (who || 'A person') + ' is ' + personTrack.action + ' on the camera.';
  } else if (animalTrack && animalTrack.action && animalTrack.action !== 'in view') {
    sentence = (animalTrack.name || 'An animal') + ' is ' + animalTrack.action + '.';
  }
  return { live, title, sentence };
}

function fallbackTitle({ threatBits, fallWho, animalList, people, thingList, noisy, soundKind }) {
  if (threatBits.some((t) => /fell|fall/i.test(t))) return fallWho ? fallWho + ' fell' : 'Fall';
  if (threatBits.length) return cap(String(threatBits[0]));
  if (animalList.length && !people.length) return animalList[0];
  if (people.length === 1 && people[0] !== 'Unknown' && people[0] !== 'Girl' && people[0] !== 'Boy') return people[0];
  if (people.some((p) => p === 'Unknown' || p === 'Girl' || p === 'Boy')) return 'Unrecognized person';
  if (people.length > 1) return people.length + ' people';
  if (thingList.length) return thingList[0];
  if (noisy && soundKind) return cap(soundKind);
  return 'Still scene';
}

function intensity(score) {
  const s = Number(score || 0);
  if (s < 0.01) return 'none';
  if (s < 0.03) return 'slight';
  if (s < 0.08) return 'moderate';
  if (s < 0.18) return 'strong';
  return 'heavy';
}

function countPhrase(items, noun) {
  if (!items || !items.length) return '';
  const named = unique(items.map((it) => it.name).filter(Boolean));
  const map = new Map();
  for (const it of items) {
    const kind = String(it.kind || noun).toLowerCase();
    const color = it.color ? String(it.color).toLowerCase() + ' ' : '';
    const key = color + kind;
    map.set(key, (map.get(key) || 0) + 1);
  }
  const parts = [];
  for (const [key, n] of map) {
    parts.push(n === 1 ? key : n + ' ' + pluralize(key));
  }
  const total = items.length;
  const list = joinNames(parts);
  if (noun === 'animal') {
    const counted = [];
    for (const [key, n] of map) counted.push(n + ' ' + (n === 1 ? key : pluralize(key)));
    const head = total === 1 ? '1 animal' : total + ' animals';
    const extra = named.length ? ' (' + joinNames(named) + ')' : '';
    return 'There ' + (total === 1 ? 'is ' : 'are ') + head + ': ' + joinNames(counted) + extra;
  }
  if (noun === 'vehicle') {
    return total === 1 ? cap(list) : joinNames(parts.map((p, i) => (i === 0 ? cap(p) : p)));
  }
  return list;
}

function pluralize(s) {
  const w = String(s || '');
  if (/bus$/.test(w)) return w + 'es';
  if (/s$/.test(w)) return w;
  if (/y$/.test(w) && !/[aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}

function joinNames(arr) {
  if (!arr.length) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function prettyNoun(cls) {
  return String(cls)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const k = String(v).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
