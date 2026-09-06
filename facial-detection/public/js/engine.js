import { personKind } from './vision.js';
import { getPerf, noteDetectMs } from './perf.js';

const TRACK_IOU = 0.28;
const faceapi = window.faceapi;

export class FaceEngine {
  constructor({ video, canvas, config, getPeople, onLog }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.config = config;
    this.getPeople = getPeople;
    this.onLog = onLog || (() => {});
    this.tracks = [];
    this.running = false;
    this.nextId = 1;
    this.lastTs = 0;
    this.frames = 0;
    this.fps = 0;
    this.fpsTs = performance.now();
    this.loopHandle = 0;
    this.lastDetections = [];
    this.onUnknown = null;
    this.onDetect = null;
    this.busy = false;
    this.motion = null;
    this.sound = null;
    this.objects = [];
    this.threats = [];
    this.name = video.id || 'feed';
  }

  setMotion(motion) {
    this.motion = motion;
  }

  setSound(sound) {
    this.sound = sound;
  }

  setObjects(objects) {
    this.objects = objects || [];
  }

  setThreats(threats) {
    this.threats = threats || [];
  }

  setConfig(config) {
    this.config = config;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.loopHandle) cancelAnimationFrame(this.loopHandle);
    this.tracks = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  loop = async (ts = 0) => {
    if (!this.running) return;
    this.loopHandle = requestAnimationFrame(this.loop);
    const interval = Math.max(getPerf().minDetectMs || 180, this.config.detectionIntervalMs || 180);
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this.busy || ts - this.lastTs < interval) {
      this.draw(this.lastDetections);
      return;
    }
    this.lastTs = ts;
    if (!this.video.videoWidth) return;
    this.layout();
    this.busy = true;
    try {
      const detections = await this.detect();
      this.lastDetections = this.updateTracks(detections);
      this.draw(this.lastDetections);
      this.frames += 1;
      if (ts - this.fpsTs >= 1000) {
        this.fps = this.frames;
        this.frames = 0;
        this.fpsTs = ts;
      }
      if (this.onDetect) this.onDetect(this.lastDetections, this);
    } catch (err) {
      this.onLog('e', this.name + ': ' + (err.message || err));
    } finally {
      this.busy = false;
    }
  };

  layout() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) return;
    const parent = this.video.parentElement;
    const rw = parent.clientWidth;
    const rh = parent.clientHeight;
    const scale = Math.min(rw / vw, rh / vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    for (const el of [this.video, this.canvas]) {
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }
    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw;
      this.canvas.height = vh;
    }
  }

  detectorOptions(kind) {
    const score = Math.max(0.15, Math.min(Number(this.config.minDetectionScore || 0.32), 0.38));
    const p = getPerf();
    if (kind === 'tiny') {
      return new faceapi.TinyFaceDetectorOptions({
        inputSize: p.tinyInput || 416,
        scoreThreshold: Math.min(0.2, score)
      });
    }
    return new faceapi.SsdMobilenetv1Options({
      minConfidence: score,
      maxResults: this.config.maxFaces || 16
    });
  }

  detectSource() {
    if (this._srcCache && this._srcCache.key === this.lastTs) return this._srcCache;
    const video = this.video;
    const p = getPerf();
    const vw = video.videoWidth || 0;
    const maxW = p.detectMaxWidth || 720;
    if (!vw || vw <= maxW) {
      this._srcCache = { src: video, scale: 1, key: this.lastTs };
      return this._srcCache;
    }
    if (!this._detectCanvas) this._detectCanvas = document.createElement('canvas');
    const scaleDown = maxW / vw;
    const w = Math.max(32, Math.round(vw * scaleDown));
    const h = Math.max(32, Math.round((video.videoHeight || 1) * scaleDown));
    if (this._detectCanvas.width !== w || this._detectCanvas.height !== h) {
      this._detectCanvas.width = w;
      this._detectCanvas.height = h;
    }
    this._detectCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);
    this._srcCache = { src: this._detectCanvas, scale: vw / w, key: this.lastTs };
    return this._srcCache;
  }

  scaleResults(results, scale) {
    if (scale === 1 || !results || !results.length) return results || [];
    for (const r of results) {
      const b = r.detection && r.detection.box;
      if (!b) continue;
      r.detection.box = {
        x: Number(b.x) * scale,
        y: Number(b.y) * scale,
        width: Number(b.width) * scale,
        height: Number(b.height) * scale
      };
      scaleLandmarksInPlace(r.landmarks, scale);
      r._scaled = true;
    }
    return results;
  }

  async runNet(opts) {
    const p = getPerf();
    const { src, scale } = this.detectSource();
    let chain = faceapi.detectAllFaces(src, opts).withFaceLandmarks().withFaceDescriptors();
    if (!p.skipAgeGender && faceapi.nets.ageGenderNet && faceapi.nets.ageGenderNet.params) {
      chain = chain.withAgeAndGender();
    }
    return this.scaleResults(await chain, scale);
  }

  async detect() {
    const min = Math.max(20, Math.min(Number(this.config.minFaceSize || 28), 36));
    const p = getPerf();
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let results = [];
    const ssdReady = !p.skipSsd && faceapi.nets.ssdMobilenetv1 && faceapi.nets.ssdMobilenetv1.params;
    const preferTiny = this.config.detector === 'tiny' || p.tinyFirst || !ssdReady;
    try {
      if (preferTiny) {
        results = await this.runNet(this.detectorOptions('tiny'));
        if ((!results || !results.length) && ssdReady) results = await this.runNet(this.detectorOptions('ssd'));
      } else {
        results = await this.runNet(this.detectorOptions('ssd'));
        if ((!results || !results.length) && faceapi.TinyFaceDetectorOptions) {
          results = await this.runNet(this.detectorOptions('tiny'));
        }
      }
    } catch (err) {
      this.onLog('e', this.name + ' detect: ' + (err.message || err));
    }
    if ((!results || !results.length) && this.objects && this.objects.length && !p.skipPersonCrops) {
      results = await this.detectOnPeople(this.objects);
    }
    noteDetectMs((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    return (results || []).filter((r) => {
      const box = r.detection && r.detection.box;
      if (!box) return false;
      const size = Math.min(box.width, box.height);
      return size >= min;
    });
  }

  async detectOnPeople(objects) {
    const people = (objects || [])
      .filter((o) => o.kind === 'person' || String(o.class || '').toLowerCase() === 'person')
      .slice(0, getPerf().maxPersonCrops || 2);
    const out = [];
    const vw = this.video.videoWidth || 0;
    const vh = this.video.videoHeight || 0;
    for (const o of people) {
      const region = headBiasedPerson(o, vw, vh);
      const crop = cropRegion(this.video, region);
      if (!crop) continue;
      try {
        const p = getPerf();
        let det = null;
        if (!p.skipSsd && faceapi.nets.ssdMobilenetv1 && faceapi.nets.ssdMobilenetv1.params) {
          det = await faceapi
            .detectSingleFace(crop, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.18, maxResults: 2 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
        }
        if (!det && faceapi.TinyFaceDetectorOptions) {
          det = await faceapi
            .detectSingleFace(crop, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.12 }))
            .withFaceLandmarks()
            .withFaceDescriptor();
        }
        if (!det) continue;
        const box = plainBox(det.detection && det.detection.box);
        if (!box) continue;
        const ox = Number(region.x) || 0;
        const oy = Number(region.y) || 0;
        out.push({
          detection: {
            box: {
              x: ox + box.x,
              y: oy + box.y,
              width: box.width,
              height: box.height
            },
            score: det.detection.score
          },
          descriptor: det.descriptor,
          landmarks: null,
          _fromCrop: true,
          age: det.age,
          gender: det.gender,
          genderProbability: det.genderProbability
        });
      } catch {
        /* next person */
      }
    }
    return out;
  }

  landmarksOk() {
    return true;
  }

  sharpness(box) {
    if (getPerf().skipSharpness) return 50;
    const pad = 0.12;
    const vw = this.video.videoWidth || this.canvas.width;
    const vh = this.video.videoHeight || this.canvas.height;
    const x = Math.max(0, Math.floor(box.x - box.width * pad));
    const y = Math.max(0, Math.floor(box.y - box.height * pad));
    const w = Math.min(vw - x, Math.floor(box.width * (1 + pad * 2)));
    const h = Math.min(vh - y, Math.floor(box.height * (1 + pad * 2)));
    if (w < 8 || h < 8) return 0;
    if (!this._sharpCanvas) this._sharpCanvas = document.createElement('canvas');
    const tmp = this._sharpCanvas;
    tmp.width = 48;
    tmp.height = 48;
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(this.video, x, y, w, h, 0, 0, 48, 48);
    const data = tctx.getImageData(0, 0, 48, 48).data;
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += g;
      sum2 += g * g;
      n += 1;
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }

  updateTracks(detections) {
    const now = performance.now();
    const assigned = new Set();
    const usedDet = new Set();

    for (const track of this.tracks) {
      let best = -1;
      let bestIou = TRACK_IOU;
      detections.forEach((det, i) => {
        if (usedDet.has(i)) return;
        const iou = boxIou(track.box, det.detection.box);
        if (iou > bestIou) {
          bestIou = iou;
          best = i;
        }
      });
      if (best >= 0) {
        usedDet.add(best);
        assigned.add(track.id);
        this.observe(track, detections[best], now);
      } else {
        track.misses += 1;
        track.hits = Math.max(0, track.hits - 1);
      }
    }

    detections.forEach((det, i) => {
      if (usedDet.has(i)) return;
      const box = det.detection.box;
      const track = {
        id: this.nextId++,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        descriptor: l2norm(Array.from(det.descriptor)),
        hits: 2,
        misses: 0,
        votes: [],
        label: null,
        confirmed: false,
        lastUnknown: 0,
        lastCaptureDesc: null,
        captures: 0,
        score: det.detection.score,
        sharpness: this.sharpness(box),
        age: det.age,
        gender: det.gender,
        genderProb: det.genderProbability,
        pose: poseFromLandmarks(det.landmarks),
        landmarks: det._fromCrop ? null : det.landmarks,
        rawBox: plainBox(box),
        capturing: false,
        updated: now
      };
      const match = matchDescriptor(track.descriptor, this.getPeople(), this.config);
      track.votes.push(match);
      if (match && match.status === 'known' && match.person) {
        track.confirmed = true;
        const kind = personKind(track.age, track.gender, track.genderProb);
        track.label = {
          status: 'known',
          name: match.person.name,
          kind,
          age: track.age,
          gender: track.gender,
          personId: match.person.id,
          facebookUrl: match.person.facebookUrl || '',
          distance: match.distance
        };
      } else {
        this.maybeCapture(track, now);
      }
    });

    const keepMiss = this.config.consecutiveMisses || 10;
    this.tracks = this.tracks.filter((t) => t.misses <= keepMiss);

    return this.tracks.map((t) => ({
      id: t.id,
      box: t.box,
      vx: t.vx || 0,
      vy: t.vy || 0,
      updated: t.updated,
      label: t.label,
      confirmed: t.confirmed,
      score: t.score,
      sharpness: t.sharpness,
      age: t.age,
      gender: t.gender
    }));
  }

  observe(track, det, now) {
    const box = det.detection.box;
    const nx = box.x;
    const ny = box.y;
    const nw = box.width;
    const nh = box.height;
    const dt = Math.max(16, now - (track.updated || now));
    if (track.box && track.box.width) {
      const x = track.box.x * 0.5 + nx * 0.5;
      const y = track.box.y * 0.5 + ny * 0.5;
      track.vx = (x - track.box.x) / dt;
      track.vy = (y - track.box.y) / dt;
      track.box = {
        x,
        y,
        width: track.box.width * 0.5 + nw * 0.5,
        height: track.box.height * 0.5 + nh * 0.5
      };
    } else {
      track.vx = 0;
      track.vy = 0;
      track.box = { x: nx, y: ny, width: nw, height: nh };
    }
    track.descriptor = l2norm(ema(track.descriptor, Array.from(det.descriptor), 0.35));
    track.hits += 1;
    track.misses = 0;
    track.score = det.detection.score;
    track.updated = now;
    track.sharpness = this.sharpness(box);
    track.pose = poseFromLandmarks(det.landmarks);
    track.rawBox = plainBox(box);
    if (!det._fromCrop) track.landmarks = det.landmarks;
    else track.landmarks = null;
    if (det.age != null) track.age = det.age;
    if (det.gender) {
      track.gender = det.gender;
      track.genderProb = det.genderProbability;
    }

    const match = matchDescriptor(track.descriptor, this.getPeople(), this.config);
    track.votes.push(match);
    if (track.votes.length > 9) track.votes.shift();

    const need = this.config.consecutiveHits || 5;
    const decided = majority(track.votes);
    if (track.hits >= need && decided && decided.status === 'known') {
      if (!track.confirmed || !track.label || track.label.personId !== decided.person.id) {
        this.onLog('k', 'Locked ' + decided.person.name + '  d=' + decided.distance.toFixed(3));
      }
      track.confirmed = true;
      const kind = personKind(track.age, track.gender, track.genderProb);
      track.label = {
        status: 'known',
        name: decided.person.name,
        kind,
        age: track.age,
        gender: track.gender,
        personId: decided.person.id,
        facebookUrl: decided.person.facebookUrl || '',
        distance: decided.distance
      };
    } else if (decided && decided.status === 'uncertain' && track.hits >= need) {
      const kind = personKind(track.age, track.gender, track.genderProb);
      track.label = {
        status: 'uncertain',
        name: decided.person.name + '?',
        kind,
        age: track.age,
        gender: track.gender,
        personId: decided.person.id,
        facebookUrl: decided.person.facebookUrl || '',
        distance: decided.distance
      };
      track.confirmed = false;
    } else if (decided && decided.status === 'ambiguous' && track.hits >= need) {
      track.label = {
        status: 'ambiguous',
        name: 'ambiguous',
        kind: personKind(track.age, track.gender, track.genderProb),
        personId: null,
        distance: decided.distance,
        detail: decided.person.name + ' / ' + (decided.second && decided.second.name)
      };
      track.confirmed = false;
    } else if (track.hits >= need) {
      const kind = personKind(track.age, track.gender, track.genderProb);
      track.label = {
        status: 'unknown',
        name: kind === 'Person' ? 'Unknown' : kind,
        kind,
        age: track.age,
        gender: track.gender,
        personId: null,
        distance: decided ? decided.distance : null
      };
      track.confirmed = false;
    }
    if ((!track.label || track.label.status !== 'known') && track.hits >= 2) {
      const lastVote = track.votes[track.votes.length - 1];
      if (!lastVote || lastVote.status !== 'known') this.maybeCapture(track, now);
    }
  }

  maybeCapture(track, now) {
    if (this.config.autoCaptureUnknowns === false) return;
    if (!this.onUnknown) return;
    if (track.confirmed || (track.label && track.label.status === 'known')) return;
    if (track.captures >= 36) return;
    if (track.sharpness && track.sharpness < 4) return;
    if (track.score < 0.12) return;
    const pose = track.pose || { yaw: 0 };
    if (Math.abs(pose.yaw) > 1.25) return;
    const cooldown = track.captures < 12 ? 160 : Math.max(280, this.config.unknownCaptureCooldownMs || 400);
    if (now - track.lastUnknown < cooldown) return;
    if (track.hits < 2) return;
    if (track.lastCaptureDesc && fusedDistance(track.descriptor, track.lastCaptureDesc) < 0.01 && track.captures >= 8) return;
    if (track.capturing) return;
    track.capturing = true;
    track.lastUnknown = now;
    track.lastCaptureDesc = track.descriptor.slice();
    track.captures += 1;
    const box = track.rawBox || track.box;
    const landmarks = track.landmarks;
    const send = (image, descriptor) => {
      if (!image || typeof image !== 'string' || !this.onUnknown) return false;
      this.onUnknown({
        descriptor: l2norm(descriptor || track.descriptor.slice()),
        image,
        trackId: track.id,
        source: this.name,
        quality: { sharpness: track.sharpness, score: track.score, yaw: pose.yaw }
      });
      return true;
    };
    this.snapUnknownFace(box, landmarks)
      .then((crop) => {
        track.capturing = false;
        const image = typeof crop === 'string' ? crop : crop && crop.image;
        const desc = crop && crop.descriptor ? crop.descriptor : track.descriptor.slice();
        if (send(image, desc)) return;
        if (send(cropFace(this.video, box, 0.08, landmarks), desc)) return;
        track.captures = Math.max(0, track.captures - 1);
      })
      .catch(() => {
        track.capturing = false;
        if (send(cropFace(this.video, box, 0.08, landmarks), track.descriptor.slice())) return;
        track.captures = Math.max(0, track.captures - 1);
      });
  }

  async snapUnknownFace(box, landmarks) {
    const video = this.video;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return null;
    const guess = faceRect(box, landmarks, vw, vh, 0.08);
    const probeBox = guess ? expandRect(guess, vw, vh, 0.55) : expandRect(plainBox(box), vw, vh, 0.45);
    let jpeg = null;
    let descriptor = null;
    if (probeBox) {
      const probe = cutCanvas(video, probeBox);
      if (probe) {
        const det = await detectFaceOn(probe);
        if (det) {
          if (det.descriptor) descriptor = l2norm(Array.from(det.descriptor));
          const local = faceRect(det.detection.box, det.landmarks, probe.width, probe.height, 0.16);
          if (local) {
            const abs = clampRect(
              { x: probeBox.x + local.x, y: probeBox.y + local.y, width: local.width, height: local.height },
              vw,
              vh
            );
            const face = cutCanvas(video, abs);
            if (face) jpeg = canvasToJpeg(face);
          }
        }
      }
    }
    if (!jpeg && guess && guess.width >= 24) {
      const face = cutCanvas(video, guess);
      if (face) jpeg = canvasToJpeg(face);
    }
    if (!jpeg) {
      const raw = plainBox(box);
      if (raw) {
        const tight = clampRect(
          {
            x: raw.x + raw.width * 0.06,
            y: raw.y - raw.height * 0.08,
            width: raw.width * 0.88,
            height: Math.max(raw.width * 1.12, raw.height * 0.72)
          },
          vw,
          vh
        );
        const face = cutCanvas(video, tight || raw);
        if (face) jpeg = canvasToJpeg(face);
      }
    }
    if (!jpeg) return null;
    return descriptor ? { image: jpeg, descriptor } : jpeg;
  }

  snapshotUnknowns() {
    const out = [];
    for (const track of this.tracks) {
      if (track.label && track.label.status === 'known') continue;
      const crop = cropFace(this.video, track.rawBox || track.box, 0.08, track.landmarks);
      if (!crop) continue;
      out.push({ descriptor: track.descriptor.slice(), image: crop, trackId: track.id, source: this.name });
    }
    return out;
  }

  draw(dets) {
    const nowDraw = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._lastDraw && nowDraw - this._lastDraw < getPerf().drawMs) return;
    this._lastDraw = nowDraw;
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const vw = this.video.videoWidth || width;
    const vh = this.video.videoHeight || height;
    ctx.setTransform(width / Math.max(1, vw), 0, 0, height / Math.max(1, vh), 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    if (this.motion && this.motion.active && this.motion.blobs && !getPerf().skipSharpness) {
      drawMotion(ctx, this.motion);
    }
    if (this.objects && this.objects.length) {
      for (const obj of this.objects) {
        if (obj.kind === 'person' || obj.class === 'person') {
          const hit = dets.find((d) => boxIou(d.box, { x: obj.x, y: obj.y, width: obj.w, height: obj.h }) > 0.28);
          if (hit) continue;
        }
        drawObjectBox(ctx, obj);
      }
    }
    if (this.threats && this.threats.length) {
      for (const th of this.threats) {
        if (!th.bbox || th.bbox.length !== 4) continue;
        drawObjectBox(ctx, {
          x: th.bbox[0],
          y: th.bbox[1],
          w: th.bbox[2] - th.bbox[0],
          h: th.bbox[3] - th.bbox[1],
          label: String(th.type || 'threat').replace(/_/g, ' ').toUpperCase(),
          kind: 'person',
          score: th.confidence
        });
      }
    }
    const now = performance.now();
    for (const det of dets) {
      const dt = Math.min(420, Math.max(0, now - (det.updated || now)));
      const box = det.box
        ? {
            x: det.box.x + (det.vx || 0) * dt,
            y: det.box.y + (det.vy || 0) * dt,
            width: det.box.width,
            height: det.box.height
          }
        : det.box;
      const color =
        det.label && det.label.status === 'known'
          ? '#5b8cff'
          : det.label && det.label.status === 'uncertain'
            ? '#9bb6ff'
            : det.label && det.label.status === 'ambiguous'
              ? '#ff9ec8'
              : '#ff6bb5';
      drawBracket(ctx, box, color);
      const title = det.label ? det.label.name : '…';
      const conf =
        det.label && det.label.distance != null
          ? (Math.max(0, Math.min(1, 1 - det.label.distance / 0.8)) * 100).toFixed(0) + '%'
          : '';
      const sub =
        det.label && det.label.status === 'known' && det.label.kind
          ? det.label.kind + (det.label.facebookUrl ? ' · ' + shortFb(det.label.facebookUrl) : '')
          : det.label && det.label.status === 'known' && det.label.facebookUrl
            ? shortFb(det.label.facebookUrl)
            : det.label && det.label.status === 'ambiguous'
              ? det.label.detail
              : det.label && det.label.kind && det.label.kind !== det.label.name
                ? det.label.kind
                : det.label && det.label.status === 'unknown'
                  ? 'needs name'
                  : '';
      drawPlate(ctx, box, title, sub, conf, color, det.confirmed);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

export function matchDescriptor(descriptor, people, config) {
  const matchT = config.matchThreshold ?? 0.42;
  const uncertainT = config.uncertainThreshold ?? 0.48;
  const margin = Math.max(0.06, config.ambiguousDelta ?? 0.08);
  const probe = l2norm(descriptor);
  const ranked = [];
  for (const person of people) {
    const dists = [];
    for (const photo of person.photos || []) {
      if (!photo.descriptor || photo.descriptor.length !== 128) continue;
      dists.push(fusedDistance(probe, photo.descriptor));
    }
    if (!dists.length) continue;
    dists.sort((a, b) => a - b);
    const best = dists[0];
    const k = Math.min(3, dists.length);
    let meanTop = 0;
    for (let i = 0; i < k; i++) meanTop += dists[i];
    meanTop /= k;
    const agree = dists.filter((d) => d <= matchT).length;
    ranked.push({
      person,
      distance: best,
      best,
      meanTop,
      agree,
      agreeFrac: agree / dists.length,
      n: dists.length
    });
  }
  ranked.sort((a, b) => a.meanTop - b.meanTop || a.best - b.best);
  if (!ranked.length) return { status: 'unknown', person: null, distance: null, second: null };
  const a = ranked[0];
  const b = ranked[1] || null;
  if (b && a.best < uncertainT && b.best - a.best < margin) {
    return {
      status: 'ambiguous',
      person: a.person,
      distance: a.best,
      second: { name: b.person.name, id: b.person.id, distance: b.best }
    };
  }
  const multiOk = a.n < 2 || a.agree >= 2 || a.agreeFrac >= 0.45 || a.meanTop <= matchT;
  if (a.best <= matchT && a.meanTop <= matchT + 0.035 && multiOk) {
    return { status: 'known', person: a.person, distance: a.best, second: b };
  }
  if (a.best <= uncertainT && a.meanTop <= uncertainT + 0.03) {
    return { status: 'uncertain', person: a.person, distance: a.best, second: b };
  }
  return { status: 'unknown', person: a.person, distance: a.best, second: b };
}

export function euclidean(a, b) {
  if (!a || !b) return Infinity;
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function l2norm(vec) {
  if (!vec || !vec.length) return vec;
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  s = Math.sqrt(s) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / s;
  return out;
}

function fusedDistance(a, b) {
  const na = l2norm(a);
  const nb = l2norm(b);
  const euc = euclidean(na, nb);
  let dot = 0;
  for (let i = 0; i < 128; i++) dot += na[i] * nb[i];
  return 0.65 * euc + 0.35 * (1 - dot);
}

function poseFromLandmarks(landmarks) {
  try {
    if (!landmarks) return { yaw: 0, pitch: 0, eyeDist: 0 };
    const left = centroid(landmarks.getLeftEye());
    const right = centroid(landmarks.getRightEye());
    const nose = centroid(landmarks.getNose());
    const mouth = centroid(landmarks.getMouth());
    const eyeDist = Math.hypot(right.x - left.x, right.y - left.y) || 1;
    const midX = (left.x + right.x) / 2;
    const midY = (left.y + right.y) / 2;
    return {
      yaw: (nose.x - midX) / eyeDist,
      pitch: (mouth.y - nose.y) / eyeDist,
      eyeDist,
      roll: (right.y - left.y) / eyeDist
    };
  } catch {
    return { yaw: 0, pitch: 0, eyeDist: 0 };
  }
}

export async function describeImage(src) {
  const img = src instanceof HTMLImageElement ? src : await blobToImage(src);
  const p = getPerf();
  const tinyOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.12 });
  const ssdOpts = (n) => new faceapi.SsdMobilenetv1Options({ minConfidence: n, maxResults: 6 });
  const ssdReady = !p.skipSsd && faceapi.nets.ssdMobilenetv1 && faceapi.nets.ssdMobilenetv1.params;
  let det = null;
  try {
    if (p.tinyFirst || !ssdReady) {
      det = await faceapi.detectSingleFace(img, tinyOpts()).withFaceLandmarks().withFaceDescriptor();
      if (!det && ssdReady) det = await faceapi.detectSingleFace(img, ssdOpts(0.2)).withFaceLandmarks().withFaceDescriptor();
    } else {
      det = await faceapi.detectSingleFace(img, ssdOpts(0.2)).withFaceLandmarks().withFaceDescriptor();
      if (!det) det = await faceapi.detectSingleFace(img, tinyOpts()).withFaceLandmarks().withFaceDescriptor();
    }
  } catch {
    det = null;
  }
  if (!det) {
    let all = [];
    try {
      if (ssdReady) {
        all = await faceapi.detectAllFaces(img, ssdOpts(0.18)).withFaceLandmarks().withFaceDescriptors();
      }
      if (!all.length) {
        all = await faceapi.detectAllFaces(img, tinyOpts()).withFaceLandmarks().withFaceDescriptors();
      }
    } catch {
      all = [];
    }
    if (!all.length) return null;
    all.sort((a, b) => b.detection.box.width * b.detection.box.height - a.detection.box.width * a.detection.box.height);
    return { descriptor: l2norm(Array.from(all[0].descriptor)), score: all[0].detection.score };
  }
  return { descriptor: l2norm(Array.from(det.descriptor)), score: det.detection.score };
}

export function cropFace(video, box, pad = 0.08, landmarks = null) {
  if (!video || !box) return null;
  const vw = video.videoWidth || video.width || 0;
  const vh = video.videoHeight || video.height || 0;
  if (!vw || !vh) return null;
  const rect = faceRect(box, landmarks, vw, vh, pad);
  if (!rect) return null;
  const c = cutCanvas(video, rect);
  return canvasToJpeg(c);
}

export function cropRegion(video, o) {
  if (!video || !o) return null;
  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  const x = Math.max(0, Number(o.x) || 0);
  const y = Math.max(0, Number(o.y) || 0);
  const w = Math.min(vw - x, Number(o.w != null ? o.w : o.width) || 0);
  const h = Math.min(vh - y, Number(o.h != null ? o.h : o.height) || 0);
  if (w < 24 || h < 24) return null;
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

function plainBox(box) {
  if (!box) return null;
  const x = Number(box.x != null ? box.x : box.left) || 0;
  const y = Number(box.y != null ? box.y : box.top) || 0;
  const width = Number(box.width != null ? box.width : box.w) || 0;
  const height = Number(box.height != null ? box.height : box.h) || 0;
  if (width < 4 || height < 4) return null;
  return { x, y, width, height };
}

function landmarkPoints(landmarks) {
  if (!landmarks) return [];
  const pts = landmarks.positions || landmarks._positions;
  if (pts && pts.length) return pts;
  const out = [];
  try {
    const grab = ['getJawOutline', 'getLeftEyeBrow', 'getRightEyeBrow', 'getLeftEye', 'getRightEye', 'getNose', 'getMouth'];
    for (const name of grab) {
      if (typeof landmarks[name] !== 'function') continue;
      const part = landmarks[name]() || [];
      for (const p of part) out.push(p);
    }
  } catch {
    return out;
  }
  return out;
}

function boxFromLandmarks(landmarks) {
  const pts = landmarkPoints(landmarks);
  if (!pts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 8 || h < 8) return null;
  return { x: minX, y: minY - h * 0.42, width: w, height: h * 1.5 };
}

function faceRect(box, landmarks, vw, vh, pad = 0.08) {
  let r = boxFromLandmarks(landmarks) || plainBox(box);
  if (!r) return null;
  if (r.height > r.width * 1.55) {
    const h = Math.max(r.width * 1.28, r.height * 0.28);
    r = { x: r.x + r.width * 0.06, y: r.y, width: r.width * 0.88, height: h };
  }
  const px = r.width * Math.max(0.14, pad);
  const pyTop = r.height * Math.max(0.28, pad * 2);
  const pyBot = r.height * Math.max(0.14, pad);
  return clampRect(
    { x: r.x - px, y: r.y - pyTop, width: r.width + px * 2, height: r.height + pyTop + pyBot },
    vw,
    vh
  );
}

function clampRect(r, vw, vh) {
  let w = Math.min(Math.max(1, Number(r.width != null ? r.width : r.w) || 0), vw);
  let h = Math.min(Math.max(1, Number(r.height != null ? r.height : r.h) || 0), vh);
  let x = Number(r.x) || 0;
  let y = Number(r.y) || 0;
  if (x + w > vw) x = vw - w;
  if (y + h > vh) y = vh - h;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (w < 16 || h < 16) return null;
  return { x, y, width: w, height: h };
}

function expandRect(r, vw, vh, amount) {
  const a = Number(amount) || 0;
  return clampRect(
    {
      x: r.x - r.width * a,
      y: r.y - r.height * a,
      width: r.width * (1 + a * 2),
      height: r.height * (1 + a * 2)
    },
    vw,
    vh
  );
}

function headBiasedPerson(o, vw, vh) {
  const x = Number(o.x) || 0;
  const y = Number(o.y) || 0;
  const w = Number(o.w != null ? o.w : o.width) || 0;
  const h = Number(o.h != null ? o.h : o.height) || 0;
  const up = h * 0.18;
  const headH = Math.min(vh, Math.max(h * 0.55, w * 1.35) + up);
  return {
    x: Math.max(0, x - w * 0.12),
    y: Math.max(0, y - up),
    w: Math.min(vw, w * 1.24),
    h: headH
  };
}

function cutCanvas(src, r) {
  if (!src || !r) return null;
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.round(r.width != null ? r.width : r.w));
  const h = Math.max(1, Math.round(r.height != null ? r.height : r.h));
  if (w < 16 || h < 16) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

function canvasToJpeg(c, q = 0.92) {
  if (!c) return null;
  return c.toDataURL('image/jpeg', q);
}

function scaleLandmarksInPlace(landmarks, scale) {
  if (!landmarks || scale === 1) return;
  try {
    const pts = landmarks.positions || landmarks._positions || [];
    for (const p of pts) {
      if (!p) continue;
      p.x = Number(p.x) * scale;
      p.y = Number(p.y) * scale;
    }
  } catch {
    /* ignore */
  }
}

async function detectFaceOn(canvas) {
  if (!canvas || !faceapi) return null;
  const p = getPerf();
  const tiny = async () => {
    try {
      const size = canvas.width < 260 ? 160 : canvas.width < 420 ? 224 : 320;
      let chain = faceapi.detectSingleFace(
        canvas,
        new faceapi.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: 0.08 })
      );
      chain = chain.withFaceLandmarks();
      if (faceapi.nets.faceRecognitionNet && faceapi.nets.faceRecognitionNet.params) {
        chain = chain.withFaceDescriptor();
      }
      return (await chain) || null;
    } catch {
      return null;
    }
  };
  const ssd = async () => {
    try {
      if (!faceapi.nets.ssdMobilenetv1 || !faceapi.nets.ssdMobilenetv1.params) return null;
      let chain = faceapi.detectSingleFace(
        canvas,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.12, maxResults: 4 })
      );
      chain = chain.withFaceLandmarks();
      if (faceapi.nets.faceRecognitionNet && faceapi.nets.faceRecognitionNet.params) {
        chain = chain.withFaceDescriptor();
      }
      return (await chain) || null;
    } catch {
      return null;
    }
  };
  let det = p.skipSsd || p.tinyFirst ? await tiny() : await ssd();
  if (!det) det = p.skipSsd || p.tinyFirst ? await ssd() : await tiny();
  return det || null;
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    if (blob instanceof HTMLImageElement) return resolve(blob);
    const url = blob instanceof Blob ? URL.createObjectURL(blob) : blob;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (blob instanceof Blob) URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = url;
  });
}

function ema(prev, next, a) {
  if (!prev || prev.length !== next.length) return next;
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) out[i] = prev[i] * (1 - a) + next[i] * a;
  return out;
}

function boxIou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function majority(votes) {
  if (!votes.length) return null;
  const recent = votes.slice(-6);
  const known = recent.filter((v) => v.status === 'known' && v.person);
  const counts = new Map();
  for (const v of known) {
    const id = v.person.id;
    const cur = counts.get(id) || { n: 0, person: v.person, distance: 0 };
    cur.n += 1;
    cur.distance += v.distance;
    counts.set(id, cur);
  }
  let top = null;
  for (const v of counts.values()) if (!top || v.n > top.n) top = v;
  if (top && top.n >= 2 && top.n >= Math.ceil(recent.length * 0.34)) {
    return { status: 'known', person: top.person, distance: top.distance / top.n };
  }
  const last = recent[recent.length - 1];
  const amb = recent.filter((v) => v.status === 'ambiguous');
  if (amb.length >= 3) return amb[amb.length - 1];
  const unc = recent.filter((v) => v.status === 'uncertain');
  if (unc.length >= 3 && known.length < 2) return unc[unc.length - 1];
  return last;
}

function centroid(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function drawMotion(ctx, motion) {
  ctx.save();
  for (const b of motion.blobs) {
    ctx.fillStyle = 'rgba(240, 113, 120, 0.14)';
    ctx.strokeStyle = 'rgba(240, 113, 120, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.restore();
}

function drawObjectBox(ctx, obj) {
  const box = { x: obj.x, y: obj.y, width: obj.w, height: obj.h };
  const stroke = obj.kind === 'animal' ? '#5b8cff' : obj.kind === 'person' ? '#ff6bb5' : '#9aa8ff';
  const tint = obj.colorName || (obj.color && obj.color.name) || '';
  const title = (tint ? tint + ' ' : '') + (obj.name || obj.label || prettyObj(obj.class) || 'Object');
  const conf = obj.score != null ? Math.round(obj.score * 100) + '%' : '';
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.setLineDash([]);
  ctx.font = '600 12px Instrument Sans, sans-serif';
  const label = title + (obj.kind === 'animal' ? '' : '');
  const tw = ctx.measureText(label).width + (conf ? 36 : 10);
  const y = Math.max(0, box.y - 20);
  ctx.fillStyle = 'rgba(10, 12, 28, 0.82)';
  ctx.fillRect(box.x, y, tw, 20);
  ctx.fillStyle = stroke;
  ctx.fillRect(box.x, y, 3, 20);
  ctx.fillStyle = '#eef2ff';
  ctx.fillText(label, box.x + 8, y + 14);
  if (conf) {
    ctx.font = '10px IBM Plex Mono, monospace';
    ctx.fillStyle = stroke;
    ctx.fillText(conf, box.x + tw - 32, y + 14);
  }
  ctx.restore();
}

function prettyObj(cls) {
  return String(cls || 'Object')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function drawBracket(ctx, box, color) {
  const { x, y, width: w, height: h } = box;
  const tick = Math.max(10, Math.min(28, Math.min(w, h) * 0.2));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.min(w, h) / 70);
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(x, y + tick); ctx.lineTo(x, y); ctx.lineTo(x + tick, y);
  ctx.moveTo(x + w - tick, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + tick);
  ctx.moveTo(x, y + h - tick); ctx.lineTo(x, y + h); ctx.lineTo(x + tick, y + h);
  ctx.moveTo(x + w - tick, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - tick);
  ctx.stroke();
  ctx.restore();
}

function drawPlate(ctx, box, title, sub, conf, color, confirmed) {
  const pad = 6;
  const x = box.x;
  const y = Math.max(0, box.y - (sub ? 36 : 24));
  ctx.save();
  ctx.font = '600 13px Instrument Sans, sans-serif';
  const tw = ctx.measureText(title).width;
  ctx.font = '11px IBM Plex Mono, monospace';
  const cw = conf ? ctx.measureText(conf).width + 10 : 0;
  const width = Math.max(box.width, tw + cw + pad * 2 + 8);
  const height = sub ? 34 : 22;
  ctx.fillStyle = confirmed ? 'rgba(6, 20, 18, 0.82)' : 'rgba(12, 10, 6, 0.82)';
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 3, height);
  ctx.font = '600 13px Instrument Sans, sans-serif';
  ctx.fillStyle = '#e7edf6';
  ctx.fillText(title, x + pad + 4, y + 15);
  if (conf) {
    ctx.font = '11px IBM Plex Mono, monospace';
    ctx.fillStyle = color;
    ctx.fillText(conf, x + width - cw, y + 15);
  }
  if (sub) {
    ctx.font = '10px IBM Plex Mono, monospace';
    ctx.fillStyle = '#8b95a8';
    ctx.fillText(sub, x + pad + 4, y + 28);
  }
  ctx.restore();
}

function shortFb(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace('www.', '') + u.pathname).replace(/\/$/, '').slice(0, 42);
  } catch {
    return String(url).slice(0, 42);
  }
}
