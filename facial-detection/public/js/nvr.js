import { GIFEncoder, quantize, applyPalette } from './gifenc.js';
import { describeScene, ObjectDetector, SoundDetector, SceneTracker, nameAnimals, ANIMALS, cropBox } from './vision.js';
import { ThreatHub, threatLabel } from './threat.js';
import { startMoondream, describeFrame, onMoondream } from './moondream.js';
import { getPerf } from './perf.js';

const GIF_W = 320;
const GIF_FPS = 5;
const GIF_SECONDS = 10;
const PRE_ROLL = 2.5;

export class MotionDetector {
  constructor(video) {
    this.video = video;
    const p = getPerf();
    this.w = p.motionW || 160;
    this.h = p.motionH || 90;
    this.grid = p.motionGrid || 32;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.noise = 10;
    this.hits = 0;
    this.ready = 0;
  }

  sample(config) {
    if (!this.video.videoWidth) return idleMotion();
    this.ctx.drawImage(this.video, 0, 0, this.w, this.h);
    const { data } = this.ctx.getImageData(0, 0, this.w, this.h);
    const gray = new Uint8Array(this.w * this.h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    this.ready += 1;
    if (!this.prev || this.ready < 8) {
      this.prev = gray;
      return idleMotion();
    }
    const thresh = Math.max(Number(config.motionThreshold || 18), this.noise * 2.8 + 5);
    const gw = this.grid || 32;
    const gh = Math.max(8, Math.round(gw * (this.h / this.w)));
    const cellW = this.w / gw;
    const cellH = this.h / gh;
    const occ = new Uint16Array(gw * gh);
    let changed = 0;
    let sumDiff = 0;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const d = Math.abs(gray[i] - this.prev[i]);
        sumDiff += d;
        if (d >= thresh) {
          changed += 1;
          const cx = Math.min(gw - 1, (x / cellW) | 0);
          const cy = Math.min(gh - 1, (y / cellH) | 0);
          occ[cy * gw + cx] += 1;
        }
      }
    }
    const mean = sumDiff / gray.length;
    this.noise = this.noise * 0.94 + mean * 0.06;
    this.prev = gray;
    const minCell = 4;
    const blobs = connected(occ, gw, gh, minCell, this.video.videoWidth, this.video.videoHeight);
    const score = changed / gray.length;
    const minArea = Number(config.motionMinArea || 0.012);
    const rawActive = score >= minArea && blobs.length > 0;
    this.hits = rawActive ? this.hits + 1 : Math.max(0, this.hits - 1);
    const active = this.hits >= 3;
    const where = locate(blobs, this.video.videoWidth, this.video.videoHeight);
    return {
      score,
      active,
      blobs,
      where,
      lighting: lightingFrom(gray),
      meanDiff: mean
    };
  }
}

function idleMotion() {
  return { score: 0, active: false, blobs: [], where: [], lighting: 'unknown', meanDiff: 0 };
}

function lightingFrom(gray) {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += gray[i];
  const avg = s / gray.length;
  if (avg < 38) return 'very dark';
  if (avg < 80) return 'dim';
  if (avg < 170) return 'normal';
  if (avg < 220) return 'bright';
  return 'washed out';
}

function connected(occ, gw, gh, minCell, vw, vh) {
  const seen = new Uint8Array(gw * gh);
  const blobs = [];
  const sx = vw / gw;
  const sy = vh / gh;
  for (let i = 0; i < occ.length; i++) {
    if (occ[i] < minCell || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let minX = i % gw;
    let maxX = minX;
    let minY = (i / gw) | 0;
    let maxY = minY;
    let area = 0;
    while (stack.length) {
      const n = stack.pop();
      area += 1;
      const x = n % gw;
      const y = (n / gw) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neigh = [];
      if (x > 0) neigh.push(n - 1);
      if (x < gw - 1) neigh.push(n + 1);
      if (y > 0) neigh.push(n - gw);
      if (y < gh - 1) neigh.push(n + gw);
      for (const q of neigh) {
        if (seen[q] || occ[q] < minCell) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (area < 3) continue;
    blobs.push({
      x: minX * sx,
      y: minY * sy,
      w: (maxX - minX + 1) * sx,
      h: (maxY - minY + 1) * sy,
      area
    });
  }
  blobs.sort((a, b) => b.area - a.area);
  return blobs.slice(0, 6);
}

function locate(blobs, vw, vh) {
  if (!blobs.length) return [];
  const names = new Set();
  for (const b of blobs) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const col = cx < vw * 0.33 ? 'left' : cx > vw * 0.66 ? 'right' : 'center';
    const row = cy < vh * 0.33 ? 'top' : cy > vh * 0.66 ? 'bottom' : 'middle';
    if (row === 'middle' && col === 'center') names.add('center');
    else names.add(row + '-' + col);
  }
  return [...names];
}

export class SegmentRecorder {
  constructor(stream, source, onSegment) {
    this.stream = stream;
    this.source = source;
    this.onSegment = onSegment;
    this.rec = null;
    this.timer = 0;
    this.startedAt = null;
    this.running = false;
  }

  start(seconds) {
    if (this.running) return;
    this.running = true;
    this.seconds = seconds || 30;
    this.cycle();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.rec && this.rec.state !== 'inactive') {
      try {
        this.rec.stop();
      } catch {
        /* ignore */
      }
    }
    this.rec = null;
  }

  cycle = () => {
    if (!this.running) return;
    const mime = pickMime();
    let rec;
    try {
      rec = mime
        ? new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: getPerf().recBps || 1200000 })
        : new MediaRecorder(this.stream);
    } catch {
      rec = new MediaRecorder(this.stream);
    }
    this.rec = rec;
    const chunks = [];
    this.startedAt = new Date().toISOString();
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      if (chunks.length && this.onSegment) {
        const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
        this.onSegment({
          blob,
          source: this.source,
          startedAt: this.startedAt,
          endedAt: new Date().toISOString(),
          mime: blob.type
        });
      }
      if (this.running) this.cycle();
    };
    rec.start();
    this.timer = setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, this.seconds * 1000);
  };
}

function pickMime() {
  const opts = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const m of opts) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function captureFrame(video, maxW) {
  if (!video.videoWidth) return null;
  const scale = Math.min(1, maxW / video.videoWidth);
  const w = Math.max(16, Math.round(video.videoWidth * scale));
  const h = Math.max(16, Math.round(video.videoHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return c;
}

export async function encodeGif(frames, delay) {
  if (!frames.length) throw new Error('No frames to encode');
  const w = frames[0].width;
  const h = frames[0].height;
  const gif = GIFEncoder();
  let palette = null;
  for (let i = 0; i < frames.length; i++) {
    const rgba = frames[i].data;
    if (!palette || i % 5 === 0) palette = quantize(rgba, 128);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, w, h, { palette, delay, repeat: i === 0 ? 0 : undefined });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export function analyzeStill(opts) {
  return describeScene(opts || {});
}

function intensity(score) {
  const s = Number(score || 0);
  if (s < 0.01) return 'none';
  if (s < 0.03) return 'slight';
  if (s < 0.08) return 'moderate';
  if (s < 0.18) return 'strong';
  return 'heavy';
}

function joinNames(arr) {
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export class NvrController {
  constructor({ getConfig, log, onEvent, onMotion, onStats, onCaption, onDead, getAnimals, onUnknownAnimal }) {
    this.getConfig = getConfig;
    this.log = log || (() => {});
    this.onEvent = onEvent;
    this.onMotion = onMotion;
    this.onStats = onStats;
    this.onCaption = onCaption;
    this.onDead = onDead;
    this.getAnimals = getAnimals || (() => []);
    this.onUnknownAnimal = onUnknownAnimal || null;
    this.feeds = new Map();
    this.timer = 0;
    this.busyAlert = new Set();
    this.odTick = 0;
    this.objects = new ObjectDetector();
    this.objects.onError = (m) => this.log('e', 'Scene AI: ' + m);
    this.objects.onReady = (b) => this.log('k', 'Scene AI ready (' + b + ')');
    startMoondream();
    onMoondream((status, detail) => {
      if (status === 'ready') this.log('k', 'Scene description ready (' + detail + ')');
      else if (status === 'status') this.log('', 'Vision: ' + detail);
      else if (status === 'error') this.log('e', 'Vision: ' + detail);
    });
  }

  attach(video, stream, source, engine) {
    this.detach(source);
    const motion = new MotionDetector(video);
    const feed = {
      video,
      stream,
      source,
      engine,
      motion,
      sound: new SoundDetector(stream),
      objects: [],
      threats: [],
      threatHub: new ThreatHub(source),
      tracker: new SceneTracker(),
      lastSound: { active: false, enabled: false },
      recorder: null,
      ring: [],
      lastMotion: 0,
      lastLife: 0,
      lastVideoTime: 0,
      stallHits: 0,
      lastAlert: 0,
      alerting: false,
      session: null,
      manualRec: false
    };
    const cfg = this.getConfig() || {};
    if (cfg.nvrContinuous === true && stream && window.MediaRecorder) {
      this.ensureRecorder(feed);
      this.log('k', 'DVR always-on ' + source);
    }
    this.feeds.set(source, feed);
    if (!this.timer) this.timer = setInterval(() => this.tick(), getPerf().nvrMs || 160);
  }

  ensureRecorder(feed) {
    if (feed.recorder && feed.recorder.running) return;
    if (!feed.stream || !window.MediaRecorder) return;
    const cfg = this.getConfig() || {};
    feed.recorder = new SegmentRecorder(feed.stream, feed.source, (seg) => this.uploadSegment(seg));
    feed.recorder.start(Number(cfg.nvrSegmentSeconds || 30));
    this.log('k', 'DVR recording ' + feed.source);
  }

  stopRecorder(feed) {
    if (feed.manualRec) return;
    if (feed.recorder) {
      feed.recorder.stop();
      feed.recorder = null;
    }
  }

  startManualRecord(source) {
    const feed = source ? this.feeds.get(source) : [...this.feeds.values()][0];
    if (!feed) throw new Error('No live camera');
    feed.manualRec = true;
    this.ensureRecorder(feed);
    return feed.source;
  }

  stopManualRecord(source) {
    const feed = source ? this.feeds.get(source) : [...this.feeds.values()][0];
    if (!feed) return;
    feed.manualRec = false;
    this.stopRecorder(feed);
  }

  async snapshotNow(source) {
    const feed = source ? this.feeds.get(source) : [...this.feeds.values()][0];
    if (!feed) throw new Error('No live camera');
    const canvas = captureFrame(feed.video, 1280);
    if (!canvas) throw new Error('No frame yet');
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    const fd = new FormData();
    fd.append('image', blob, 'snap.jpg');
    fd.append('source', feed.source);
    const res = await fetch('/api/nvr/snaps', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Snapshot failed');
    this.log('k', 'Snapshot saved');
    return data;
  }

  detach(source) {
    if (source) {
      const f = this.feeds.get(source);
      if (f && f.recorder) f.recorder.stop();
      if (f && f.sound) f.sound.stop();
      if (f && f.threatHub) f.threatHub.reset();
      this.feeds.delete(source);
    } else {
      for (const f of this.feeds.values()) {
        if (f.recorder) f.recorder.stop();
        if (f.sound) f.sound.stop();
        if (f.threatHub) f.threatHub.reset();
      }
      this.feeds.clear();
    }
    if (!this.feeds.size && this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }

  maybeMoondream(feed, faces) {
    if (!feed || !feed.video) return;
    const now = performance.now();
    if (feed.moonBusy) return;
    if (now - (feed.lastMoon || 0) < (getPerf().moonMs || 4000)) return;
    feed.moonBusy = true;
    feed.lastMoon = now;
    const names = (faces || [])
      .map((f) => f.label && f.label.name)
      .filter(Boolean);
    const animals = (this.getAnimals() || []).map((a) => a.name).filter(Boolean);
    const objects = (feed.objects || []).map((o) => {
      const tint = o.colorName || (o.color && o.color.name) || '';
      return (tint ? tint + ' ' : '') + (o.name || o.label || o.class || 'object');
    });
    describeFrame(feed.video, { names, animals, objects })
      .then((text) => {
        feed.moonBusy = false;
        if (!text) return;
        feed.moonCaption = text;
        if (this.onCaption) {
          this.onCaption(
            feed.source,
            describeScene({
              faces: (feed.engine && feed.engine.lastDetections) || faces || [],
              objects: feed.objects || [],
              motion: { score: 0, where: [], lighting: 'normal' },
              sound: feed.lastSound,
              lighting: 'normal',
              source: feed.source,
              threats: feed.threats,
              tracks: feed.tracks,
              narrative: text
            })
          );
        }
      })
      .catch(() => {
        feed.moonBusy = false;
      });
  }

  captureUnknownAnimals(feed) {
    if (!this.onUnknownAnimal || !feed || !feed.video) return;
    const now = performance.now();
    feed.animalCapAt = feed.animalCapAt || {};
    for (const o of feed.objects || []) {
      const cls = String(o.class || '').toLowerCase();
      if (o.kind !== 'animal' && !ANIMALS.has(cls)) continue;
      if (o.name) continue;
      const species = cls || 'animal';
      if (now - (feed.animalCapAt[species] || 0) < 1600) continue;
      const image = cropBox(feed.video, o, 0.08);
      if (!image) continue;
      feed.animalCapAt[species] = now;
      try {
        this.onUnknownAnimal({
          species,
          color: o.colorName || (o.color && o.color.name) || '',
          image,
          source: feed.source
        });
      } catch {
        /* ignore */
      }
    }
  }

  tick() {
    const cfg = this.getConfig() || {};
    this.odTick += 1;
    for (const feed of this.feeds.values()) {
      if (!feed.video.videoWidth) continue;
      const result = cfg.motionEnabled === false ? idleMotion() : feed.motion.sample(cfg);
      const sound =
        cfg.soundEnabled === false || !feed.sound ? { rms: 0, active: false, enabled: false } : feed.sound.sample(cfg);
      feed.lastSound = sound;
      if (feed.engine && feed.engine.setMotion) feed.engine.setMotion(result);
      if (feed.engine && feed.engine.setSound) feed.engine.setSound(sound);

      const needCoco =
        cfg.objectDetection !== false ||
        cfg.threatDetection !== false ||
        cfg.recordOnPerson !== false ||
        cfg.recordOnAnimal !== false ||
        cfg.alertOnPerson !== false ||
        cfg.alertOnAnimal !== false;
      const paintCaption = () => {
        if (!this.onCaption) return;
        const faces = (feed.engine && feed.engine.lastDetections) || [];
        let objects = feed.objects || [];
        if (!objects.length && faces.length) {
          objects = faces.map((d) => ({
            class: 'person',
            kind: 'person',
            label: (d.label && (d.label.name || d.label.kind)) || 'Person',
            name: (d.label && d.label.name) || '',
            x: d.x,
            y: d.y,
            w: d.w,
            h: d.h
          }));
        }
        this.onCaption(
          feed.source,
          describeScene({
            faces,
            objects,
            motion: result,
            sound,
            lighting: result.lighting,
            source: feed.source,
            threats: feed.threats,
            tracks: feed.tracks,
            narrative: feed.moonCaption || ''
          })
        );
      };

      if (needCoco && this.objects && this.odTick % (getPerf().cocoEvery || 1) === 0) {
        this.objects.tick(feed.video).then((preds) => {
          const named = nameAnimals(preds || [], this.getAnimals());
          if (named && named.length) {
            feed.objects = named;
            feed.objectsAt = performance.now();
          } else if (performance.now() - (feed.objectsAt || 0) > 2500) {
            feed.objects = named || [];
          }
          feed.tracks = feed.tracker ? feed.tracker.update(feed.objects || [], feed.video.videoHeight) : [];
          const followed = feed.tracker && feed.tracker.follow ? feed.tracker.follow() : feed.objects;
          if (feed.engine && feed.engine.setObjects) feed.engine.setObjects(followed && followed.length ? followed : feed.objects);
          this.captureUnknownAnimals(feed);
          this.maybeMoondream(feed, (feed.engine && feed.engine.lastDetections) || []);
          if (cfg.threatDetection !== false && feed.threatHub) {
            feed.threats = feed.threatHub.analyze(feed.objects, feed.video, result) || [];
            if (feed.engine && feed.engine.setThreats) feed.engine.setThreats(feed.threats);
          }
          paintCaption();
        }).catch((err) => this.log('e', 'Scene AI: ' + (err.message || err)));
      }

      if (feed.tracker && feed.tracker.follow && feed.engine && feed.engine.setObjects) {
        const live = feed.tracker.follow();
        if (live && live.length) feed.engine.setObjects(live);
      }
      if (this.onMotion) this.onMotion(feed.source, result, sound, feed.objects, feed.threats);
      paintCaption();

      const p = getPerf();
      feed._ringN = (feed._ringN || 0) + 1;
      if (feed.alerting || feed._ringN % (p.ringEvery || 1) === 0) {
        if (!this._gifCanvas) this._gifCanvas = document.createElement('canvas');
        const small = captureFrame(feed.video, p.gifW || GIF_W, this._gifCanvas);
        if (small) {
          const ctx = small.getContext('2d', { willReadFrequently: true });
          feed.ring.push({
            t: performance.now(),
            data: ctx.getImageData(0, 0, small.width, small.height),
            score: result.score,
            faces: (feed.engine && feed.engine.lastDetections) || []
          });
          const keep = (PRE_ROLL + GIF_SECONDS) * 1000 + 500;
          const cutoff = performance.now() - keep;
          while (feed.ring.length && feed.ring[0].t < cutoff) feed.ring.shift();
        }
      }

      if (result.active) feed.lastMotion = performance.now();

      const faces = (feed.engine && (feed.engine.lastDetections || feed.engine.tracks)) || [];
      const life = sceneLife(feed.objects, feed.threats, faces);
      if (life.any) feed.lastLife = performance.now();
      const shouldRecord =
        cfg.nvrContinuous === true ||
        feed.manualRec ||
        (cfg.recordOnPerson !== false && life.person) ||
        (cfg.recordOnAnimal !== false && life.animal) ||
        (cfg.recordOnThreat !== false && life.threat);
      if (shouldRecord) this.ensureRecorder(feed);
      else if (feed.recorder && performance.now() - (feed.lastLife || 0) > 8000) this.stopRecorder(feed);

      const v = feed.video;
      if (v) {
        const t = v.currentTime || 0;
        if (v.readyState < 2 || t === feed.lastVideoTime) feed.stallHits += 1;
        else feed.stallHits = 0;
        feed.lastVideoTime = t;
        if (feed.stallHits === 40) {
          this.log('e', 'Camera "' + feed.source + '" looks frozen or disconnected');
          if (this.onDead) this.onDead(feed.source);
        }
      }

      const threatHit = cfg.alertOnThreat !== false && life.threat;
      const wantAlert =
        (cfg.alertOnPerson !== false && life.person) ||
        (cfg.alertOnAnimal !== false && life.animal) ||
        (cfg.alertOnSound === true && sound.active) ||
        (cfg.alertOnMotion === true && result.active) ||
        threatHit;
      const cooldown = threatHit ? Math.min(30000, Number(cfg.alertCooldownMs || 120000)) : Number(cfg.alertCooldownMs || 120000);
      if (wantAlert && !feed.alerting && performance.now() - feed.lastAlert > cooldown) {
        this.startAlert(feed, result, sound, feed.threats);
      }
      if (feed.alerting && feed.session) {
        feed.session.peak = Math.max(feed.session.peak, result.score);
        feed.session.bestObjects = feed.objects || feed.session.bestObjects;
        feed.session.bestThreats = feed.threats && feed.threats.length ? feed.threats : feed.session.bestThreats;
        feed.session.bestSound = sound.active ? sound : feed.session.bestSound;
        if (result.score >= feed.session.peak) {
          feed.session.bestFaces = (feed.engine && feed.engine.lastDetections) || feed.session.bestFaces;
          feed.session.bestLighting = result.lighting;
          feed.session.bestWhere = result.where;
          const still = captureFrame(feed.video, getPerf().level === 'low' ? 480 : 720);
          if (still) feed.session.stillCanvas = still;
        }
      }
    }
  }

  startAlert(feed, motion, sound, threats) {
    feed.alerting = true;
    feed.lastAlert = performance.now();
    const start = performance.now();
    feed.session = {
      start,
      peak: motion.score || 0,
      bestFaces: (feed.engine && feed.engine.lastDetections) || [],
      bestObjects: feed.objects || [],
      bestThreats: threats || feed.threats || [],
      bestSound: sound || feed.lastSound,
      bestLighting: motion.lighting,
      bestWhere: motion.where,
      stillCanvas: captureFrame(feed.video, 720),
      clipChunks: [],
      clipRec: null
    };
    const top = (threats && threats[0]) || (feed.threats && feed.threats[0]);
    const life = sceneLife(
      feed.objects,
      threats || feed.threats,
      (feed.engine && (feed.engine.lastDetections || feed.engine.tracks)) || []
    );
    const why = top
      ? threatLabel(top.type)
      : life.person
        ? 'Person'
        : life.animal
          ? 'Animal'
          : motion && motion.active
            ? 'Motion'
            : 'Sound';
    this.log('u', why + ' on ' + feed.source + ' — capturing 10s GIF');
    try {
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(feed.stream, { mimeType: mime }) : new MediaRecorder(feed.stream);
      feed.session.clipRec = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) feed.session.clipChunks.push(e.data);
      };
      rec.start();
    } catch {
      /* clip is optional */
    }
    setTimeout(() => this.finishAlert(feed), GIF_SECONDS * 1000);
  }

  async finishAlert(feed) {
    const session = feed.session;
    feed.alerting = false;
    feed.session = null;
    if (!session) return;
    if (session.clipRec && session.clipRec.state !== 'inactive') {
      await new Promise((resolve) => {
        session.clipRec.onstop = resolve;
        try {
          session.clipRec.stop();
        } catch {
          resolve();
        }
        setTimeout(resolve, 1500);
      });
    }
    const t0 = session.start - PRE_ROLL * 1000;
    const t1 = session.start + GIF_SECONDS * 1000;
    const picked = feed.ring.filter((f) => f.t >= t0 && f.t <= t1);
    const gifFps = getPerf().gifFps || GIF_FPS;
    const step = Math.max(1, Math.round(picked.length / (gifFps * GIF_SECONDS)));
    const frames = [];
    for (let i = 0; i < picked.length; i += step) frames.push(picked[i].data);
    if (!frames.length && feed.ring.length) frames.push(feed.ring[feed.ring.length - 1].data);

    let gifBlob = null;
    try {
      gifBlob = await encodeGif(frames, Math.round(1000 / gifFps));
    } catch (err) {
      this.log('e', 'GIF encode failed: ' + err.message);
    }

    const stillBlob = await canvasToBlob(session.stillCanvas, 'image/jpeg', 0.86);
    let moon = feed.moonCaption || '';
    try {
      const asked = await describeFrame(session.stillCanvas || feed.video, {
        names: (session.bestFaces || []).map((f) => f.label && f.label.name).filter(Boolean),
        objects: (session.bestObjects || feed.objects || []).map((o) => o.name || o.label || o.class)
      });
      if (asked) moon = asked;
    } catch {
      /* coco copy still used */
    }
    const analysis = describeScene({
      faces: session.bestFaces,
      objects: session.bestObjects || feed.objects || [],
      motion: { score: session.peak, where: session.bestWhere, lighting: session.bestLighting },
      sound: session.bestSound,
      source: feed.source,
      lighting: session.bestLighting,
      durationSec: GIF_SECONDS,
      threats: session.bestThreats || feed.threats || [],
      narrative: moon
    });

    const fd = new FormData();
    fd.append('meta', JSON.stringify({
      source: feed.source,
      watchUrl: (typeof location !== 'undefined' ? location.origin : '') + '/watch.html?cam=' + encodeURIComponent(feed.source),
      title: analysis.title,
      description: analysis.description,
      people: analysis.people,
      animals: analysis.animals,
      objects: analysis.objects,
      threats: session.bestThreats || [],
      caption: analysis.live,
      motionScore: session.peak,
      motionLabel: analysis.motionLabel,
      lighting: analysis.lighting,
      where: analysis.where,
      sound: session.bestSound && session.bestSound.active
    }));
    if (gifBlob) fd.append('gif', gifBlob, 'clip.gif');
    if (stillBlob) fd.append('still', stillBlob, 'still.jpg');
    if (session.clipChunks.length) {
      fd.append('clip', new Blob(session.clipChunks, { type: 'video/webm' }), 'clip.webm');
    }
    try {
      const res = await fetch('/api/nvr/events', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Alert save failed');
      this.log('k', 'Alert saved' + (data.emailStatus === 'sent' ? ' · emailed' : data.emailStatus === 'error' ? ' · email failed' : ''));
      if (this.onEvent) this.onEvent(data);
    } catch (err) {
      this.log('e', err.message);
    }
  }

  async uploadSegment(seg) {
    try {
      const fd = new FormData();
      const name = (seg.source || 'feed') + (seg.mime && /mp4/.test(seg.mime) ? '.mp4' : '.webm');
      fd.append('video', seg.blob, name);
      fd.append('source', seg.source);
      fd.append('startedAt', seg.startedAt);
      fd.append('endedAt', seg.endedAt);
      const res = await fetch('/api/nvr/segments', { method: 'POST', body: fd });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Segment upload failed');
      }
      if (this.onStats) this.onStats();
    } catch (err) {
      this.log('e', 'DVR: ' + err.message);
    }
  }
}

function canvasToBlob(canvas, type, q) {
  if (!canvas) return Promise.resolve(null);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q));
}

export function sceneLife(objects, threats, faces) {
  const objs = objects || [];
  let person = false;
  let animal = false;
  for (const o of objs) {
    const k = String(o.kind || '').toLowerCase();
    const c = String(o.class || o.class_name || o.label || '').toLowerCase();
    if (k === 'person' || c === 'person' || k === 'girl' || k === 'boy' || /\b(girl|boy|man|woman|person)\b/.test(c)) {
      person = true;
    }
    if (
      k === 'animal' ||
      /^(cat|dog|bird|horse|sheep|cow|elephant|bear|zebra|giraffe|mouse|teddy bear)$/.test(c) ||
      /\b(cat|dog|bird|horse|sheep|cow|elephant|bear|zebra|giraffe)\b/.test(c)
    ) {
      animal = true;
    }
  }
  if (Array.isArray(faces) && faces.length) person = true;
  const threat = Array.isArray(threats) && threats.length > 0;
  return { person, animal, threat, any: person || animal || threat };
}
