/**
 * Threat + fall detection ported from
 * https://github.com/shahinakt/ai-cctv-threat-detection
 * (SmartFallDetector, SmartTheftDetector, IncidentDetector).
 * Runs on coco-ssd boxes already produced in the browser — no extra Python stack.
 */

const VALUABLES = ['backpack', 'handbag', 'suitcase', 'laptop', 'cell phone', 'purse', 'keyboard', 'tv'];

function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

function center(bbox) {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function toDets(objects) {
  const out = [];
  for (const o of objects || []) {
    const x1 = o.x;
    const y1 = o.y;
    const x2 = o.x + o.w;
    const y2 = o.y + o.h;
    if (!(x2 > x1 && y2 > y1)) continue;
    out.push({
      class_name: String(o.class || o.label || '')
        .toLowerCase()
        .replace(/\s+/g, ' '),
      conf: Number(o.score || 0),
      bbox: [x1, y1, x2, y2],
      box: o
    });
  }
  return out;
}

export class SmartFallDetector {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.personTracks = new Map();
    this.nextId = 1;
    this.fallCandidates = new Map();
    this.HORIZONTAL_THRESHOLD = 0.6;
    this.DROP_RATIO = 0.2;
    this.GROUND_RATIO = 0.85;
    this.CONFIRM_FRAMES = 6;
    this.MOTIONLESS_FRAMES = 8;
    this.MIN_CONF = 0.4;
  }

  analyze(detections, frameH, now) {
    const incidents = [];
    const tracked = this._updateTracks(detections, frameH);
    for (const { pid, history } of tracked) {
      if (history.length < 6) continue;
      const recent = history.slice(-6);
      const yPositions = recent.map((f) => f.center[1]);
      const last = recent[recent.length - 1];
      const w = last.bbox[2] - last.bbox[0];
      const h = last.bbox[3] - last.bbox[1];
      if (w <= 0) continue;
      const aspect = h / w;
      const horizontal = aspect < this.HORIZONTAL_THRESHOLD;
      const onGround = last.bbox[3] > frameH * this.GROUND_RATIO;
      const drop = Math.max(...yPositions) - Math.min(...yPositions);
      const suddenDrop = drop > frameH * this.DROP_RATIO;
      const vSpeed = yPositions[yPositions.length - 1] - yPositions[0];
      const collapsed = aspect < 0.75 && vSpeed > frameH * 0.08;

      if ((suddenDrop && horizontal && onGround) || (collapsed && onGround && suddenDrop)) {
        let cand = this.fallCandidates.get(pid);
        if (!cand) {
          cand = { count: 1, lastY: yPositions[yPositions.length - 1], motionless: 0 };
          this.fallCandidates.set(pid, cand);
        } else {
          cand.count += 1;
          const dy = Math.abs(yPositions[yPositions.length - 1] - cand.lastY);
          cand.motionless = dy < frameH * 0.02 ? cand.motionless + 1 : 0;
          cand.lastY = yPositions[yPositions.length - 1];
        }
        if (cand.count >= this.CONFIRM_FRAMES && cand.motionless >= this.MOTIONLESS_FRAMES) {
          incidents.push({
            type: 'fall_detected',
            severity: 'critical',
            confidence: 0.9,
            description: 'Confirmed fall: sudden drop, horizontal posture, and no movement.',
            camera_id: this.cameraId,
            timestamp: now,
            bbox: last.bbox
          });
          this.fallCandidates.delete(pid);
        } else if (cand.count >= 4 && (horizontal || onGround)) {
          incidents.push({
            type: 'fall_detected',
            severity: 'high',
            confidence: 0.72,
            description: 'Possible fall (person dropped and is near the ground).',
            camera_id: this.cameraId,
            timestamp: now,
            bbox: last.bbox
          });
        }
      } else {
        this.fallCandidates.delete(pid);
      }
    }
    return incidents;
  }

  _updateTracks(detections, frameH) {
    const used = new Set();
    const tracked = [];
    const maxDist = Math.max(120, Number(frameH || 480) * 0.55);
    for (const det of detections) {
      if (det.class_name !== 'person' || det.conf < this.MIN_CONF) continue;
      const c = center(det.bbox);
      let matched = null;
      let best = maxDist;
      for (const [pid, hist] of this.personTracks) {
        if (used.has(pid) || !hist.length) continue;
        const d = dist(c, hist[hist.length - 1].center);
        if (d <= best) {
          best = d;
          matched = pid;
        }
      }
      if (matched == null) {
        matched = this.nextId++;
        this.personTracks.set(matched, []);
      }
      used.add(matched);
      const hist = this.personTracks.get(matched);
      hist.push({ bbox: det.bbox, center: c });
      if (hist.length > 15) hist.shift();
      hist.misses = 0;
      tracked.push({ pid: matched, history: hist });
    }
    for (const [pid, hist] of [...this.personTracks]) {
      if (used.has(pid)) continue;
      hist.misses = (hist.misses || 0) + 1;
      if (hist.misses > 5) this.personTracks.delete(pid);
    }
    return tracked;
  }

  reset() {
    this.personTracks.clear();
    this.fallCandidates.clear();
  }
}

export class SmartTheftDetector {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.objectOwners = new Map();
    this.objectPositions = new Map();
    this.objectStationary = new Map();
    this.objectMissing = new Map();
    this.candidates = new Map();
    this.MIN_CONF_PERSON = 0.5;
    this.MIN_CONF_VALUABLE = 0.45;
  }

  analyze(detections, frameNumber, now) {
    const incidents = [];
    const persons = detections.filter((d) => d.class_name === 'person' && d.conf > this.MIN_CONF_PERSON);
    const valuables = detections.filter((d) => VALUABLES.includes(d.class_name) && d.conf > this.MIN_CONF_VALUABLE);
    const visible = new Set();

    for (const val of valuables) {
      const objectId = this._objectId(val);
      visible.add(objectId);
      const c = center(val.bbox);
      if (this.objectPositions.has(objectId)) {
        const movement = dist(c, this.objectPositions.get(objectId));
        this.objectStationary.set(objectId, movement < 12 ? (this.objectStationary.get(objectId) || 0) + 1 : 0);
      }
      this.objectPositions.set(objectId, c);
      this.objectMissing.set(objectId, 0);
      this._updateOwnership(objectId, val, persons);
    }

    for (const objectId of [...this.objectPositions.keys()]) {
      if (visible.has(objectId)) continue;
      this.objectMissing.set(objectId, (this.objectMissing.get(objectId) || 0) + 1);
      if ((this.objectStationary.get(objectId) || 0) > 12 && this.objectMissing.get(objectId) > 5) {
        incidents.push({
          type: 'theft_detected',
          severity: this.objectOwners.get(objectId) ? 'critical' : 'high',
          confidence: 0.88,
          description: 'Valuable object removed from the monitored area.',
          camera_id: this.cameraId,
          timestamp: now,
          object_id: objectId
        });
        this._clear(objectId);
      }
    }

    for (const val of valuables) {
      const objectId = this._objectId(val);
      for (const person of persons) {
        const distance = dist(center(person.bbox), center(val.bbox));
        if (distance >= 70) continue;
        const personId = this._personId(person);
        const isOwner = this.objectOwners.get(objectId) === personId;
        const suspicion = this._behaviorScore(distance, isOwner, this.objectStationary.get(objectId) || 0);
        const key = objectId + '_' + personId;
        const cand = this.candidates.get(key) || { frames: 0, score: 0, last: 0 };
        cand.frames += 1;
        cand.score += suspicion;
        cand.last = frameNumber;
        this.candidates.set(key, cand);
        if (cand.frames >= 10) {
          const avg = cand.score / cand.frames;
          if (avg > 0.75 && !isOwner) {
            incidents.push({
              type: 'potential_theft',
              severity: 'medium',
              confidence: avg,
              description: 'Suspicious interaction with a valuable object.',
              camera_id: this.cameraId,
              timestamp: now,
              object_id: objectId,
              bbox: val.bbox
            });
            this.candidates.delete(key);
          }
        }
      }
    }

    for (const [key, cand] of [...this.candidates]) {
      if (frameNumber - cand.last > 20) this.candidates.delete(key);
    }
    return incidents;
  }

  _updateOwnership(objectId, val, persons) {
    let closest = null;
    let min = Infinity;
    for (const p of persons) {
      const d = dist(center(p.bbox), center(val.bbox));
      if (d < min) {
        min = d;
        closest = p;
      }
    }
    if (closest && min < 70 && !this.objectOwners.has(objectId)) {
      this.objectOwners.set(objectId, this._personId(closest));
    }
  }

  _behaviorScore(distance, isOwner, stationary) {
    let score = 0;
    if (!isOwner) {
      if (distance < 30) score += 0.5;
      else if (distance < 50) score += 0.4;
      else score += 0.2;
    }
    if (stationary > 16) score += 0.3;
    return Math.min(score, 1);
  }

  _objectId(val) {
    return val.class_name + '_' + Math.floor(val.bbox[0] / 40) + '_' + Math.floor(val.bbox[1] / 40);
  }
  _personId(p) {
    return 'person_' + Math.floor(p.bbox[0] / 40) + '_' + Math.floor(p.bbox[1] / 40);
  }
  _clear(id) {
    this.objectOwners.delete(id);
    this.objectPositions.delete(id);
    this.objectStationary.delete(id);
    this.objectMissing.delete(id);
  }
  reset() {
    this.objectOwners.clear();
    this.objectPositions.clear();
    this.objectStationary.clear();
    this.objectMissing.clear();
    this.candidates.clear();
  }
}

export class ViolenceDetector {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.pairs = new Map();
    this.speeds = new Map();
  }

  analyze(detections, motion, now) {
    const incidents = [];
    const people = detections.filter((d) => d.class_name === 'person' && d.conf > 0.45);
    const motionHot = motion && motion.score > 0.06;
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const a = people[i];
        const b = people[j];
        const ca = center(a.bbox);
        const cb = center(b.bbox);
        const d = dist(ca, cb);
        const bodyH = Math.max(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
        const key = i + ':' + j;
        if (d < Math.max(140, bodyH * 1.6)) {
          this.pairs.set(key, (this.pairs.get(key) || 0) + 1);
        } else {
          this.pairs.set(key, Math.max(0, (this.pairs.get(key) || 0) - 1));
        }
        const n = this.pairs.get(key) || 0;
        if (n >= 8 && motionHot) {
          incidents.push({
            type: 'violence_detected',
            severity: 'high',
            confidence: 0.82,
            description: 'Sustained close-range aggressive motion between two people.',
            camera_id: this.cameraId,
            timestamp: now,
            bbox: a.bbox
          });
          this.pairs.set(key, 0);
        } else if (n >= 6 && motion && motion.score > 0.1) {
          incidents.push({
            type: 'fight_detected',
            severity: 'high',
            confidence: 0.8,
            description: 'Mutual aggressive motion detected.',
            camera_id: this.cameraId,
            timestamp: now,
            bbox: a.bbox
          });
          this.pairs.set(key, 0);
        }
      }
    }
    return incidents;
  }

  reset() {
    this.pairs.clear();
    this.speeds.clear();
  }
}

export class ThreatHub {
  constructor(source) {
    this.source = source;
    this.fall = new SmartFallDetector(source);
    this.theft = new SmartTheftDetector(source);
    this.violence = new ViolenceDetector(source);
    this.frame = 0;
    this.last = [];
    this.lastAlertAt = {};
    this.cooldownSec = 8;
  }

  analyze(objects, video, motion) {
    if (!video || !video.videoHeight) return [];
    this.frame += 1;
    const dets = toDets(objects);
    const now = Date.now() / 1000;
    let incidents = [
      ...this.fall.analyze(dets, video.videoHeight, now),
      ...this.theft.analyze(dets, this.frame, now),
      ...this.violence.analyze(dets, motion, now)
    ];
    const out = [];
    for (const inc of incidents) {
      const t = inc.type;
      if (!this.lastAlertAt[t] || now - this.lastAlertAt[t] > this.cooldownSec) {
        this.lastAlertAt[t] = now;
        out.push(inc);
      }
    }
    this.last = out;
    return out;
  }

  reset() {
    this.fall.reset();
    this.theft.reset();
    this.violence.reset();
    this.last = [];
    this.lastAlertAt = {};
    this.frame = 0;
  }
}

export function threatLabel(type) {
  if (type === 'fall_detected') return 'FALL';
  if (type === 'theft_detected' || type === 'potential_theft') return 'THEFT';
  if (type === 'violence_detected' || type === 'fight_detected' || type === 'slap_detected' || type === 'strike_detected')
    return 'THREAT';
  return String(type || 'ALERT').replace(/_/g, ' ').toUpperCase();
}

export function threatColor(type) {
  if (String(type).includes('fall')) return '#ff4d6d';
  if (String(type).includes('theft')) return '#ffb020';
  return '#ff6bb5';
}
