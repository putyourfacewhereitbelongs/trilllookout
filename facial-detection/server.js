'use strict';

// Trill Lookout AI Cam — local DVR, scene AI, and facial recognition
//   cd facial-detection && npm install && node server.js
// Open https://localhost:3443  (camera + screen share need HTTPS or localhost)


const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const { execFileSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createNvr } = require('./nvr-store');
const { createPush } = require('./push');
const { createGoogleOAuth } = require('./google-oauth');
const { createLiveHub } = require('./live-hub');
const { createCamerasStore } = require('./cameras-store');
const camScan = require('./cam-scan');
const ptz = require('./ptz');
const QRCode = require('qrcode');
const deep = require('./deep-match');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PEOPLE_MEDIA = path.join(MEDIA_DIR, 'people');
const ANIMALS_MEDIA = path.join(MEDIA_DIR, 'animals');
const UNKNOWN_MEDIA = path.join(MEDIA_DIR, 'unknowns');
const UNKNOWN_ANIMALS_MEDIA = path.join(MEDIA_DIR, 'unknown-animals');
const CERT_DIR = path.join(ROOT, 'certs');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

const DEFAULT_CONFIG = {
  matchThreshold: 0.42,
  uncertainThreshold: 0.48,
  ambiguousDelta: 0.08,
  minFaceSize: 28,
  minDetectionScore: 0.32,
  minSharpness: 40,
  consecutiveHits: 2,
  consecutiveMisses: 10,
  unknownCaptureCooldownMs: 400,
  unknownMaxPhotos: 36,
  detectionIntervalMs: 180,
  detector: 'ssd',
  autoCaptureUnknowns: true,
  autoMergeUnknowns: true,
  autoMergeThreshold: 0.4,
  maxFaces: 16,
  nvrContinuous: false,
  nvrSegmentSeconds: 30,
  nvrRetentionDays: 7,
  motionEnabled: true,
  motionThreshold: 18,
  motionMinArea: 0.012,
  alertOnMotion: false,
  alertOnSound: false,
  alertOnPerson: true,
  alertOnAnimal: true,
  soundEnabled: true,
  soundThreshold: 0.045,
  objectDetection: true,
  threatDetection: true,
  nightVision: false,
  alertOnThreat: true,
  recordOnPerson: true,
  recordOnAnimal: true,
  recordOnThreat: true,
  alertCooldownMs: 120000
};

ensureDirs();
const db = loadDb();
const pushHub = createPush(ROOT);
const googleAuth = createGoogleOAuth(ROOT);
const liveHub = createLiveHub();
const cameraBook = createCamerasStore(ROOT, uid, now);
const nvr = createNvr({
  root: ROOT,
  uid,
  now,
  getConfig: () => db.config,
  onAlert: (ev) => pushHub.notify(ev),
  google: googleAuth
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), autoplay=(self), picture-in-picture=(self), screen-wake-lock=(self), geolocation=(), notifications=(self)'
  );
  next();
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.get('/videos', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'videos.html'));
});
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (String(req.query.host || '') === '1') {
    return res.sendFile(path.join(PUBLIC_DIR, 'host.html'));
  }
  res.sendFile(path.join(PUBLIC_DIR, 'watch.html'));
});
app.get('/watch', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'watch.html'));
});
app.get('/host', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'host.html'));
});
app.get('/enroll', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'enroll.html'));
});
app.get('/settings', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
});
app.get('/share', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'share.html'));
});
app.get('/go', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'go.html'));
});

app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h', fallthrough: true }));
app.use('/nvr', express.static(nvr.NVR_DIR, { maxAge: '5m', fallthrough: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
  }
});

const nvrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 6 }
});

const VISION_BASE = String(process.env.TRILL_VISION_URL || 'https://discipline-tracking-sympathy-tommy.trycloudflare.com').replace(/\/$/, '');
const DEFAULT_VISION_PROMPT =
  'Describe this security camera frame in detail. Identify every person (clothing, hair, estimated age or gender), every animal (kind, color, count), every vehicle (kind and color), and other objects. Say what each is doing and where they are in the frame. Do not talk about motion intensity or lighting unless that is the only thing visible.';

async function callTrillVision(buffer, mime, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  const bodyPrompt = String(prompt || DEFAULT_VISION_PROMPT).slice(0, 2000);
  const type = mime || 'image/jpeg';
  try {
    const fd = new FormData();
    fd.append('image', new Blob([buffer], { type }), 'frame.jpg');
    fd.append('prompt', bodyPrompt);
    let res = await fetch(VISION_BASE + '/analyze', { method: 'POST', body: fd, signal: ctrl.signal });
    let text = await res.text();
    if (!res.ok || !text) {
      res = await fetch(VISION_BASE + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          prompt: bodyPrompt,
          image: 'data:' + type + ';base64,' + Buffer.from(buffer).toString('base64')
        }),
        signal: ctrl.signal
      });
      text = await res.text();
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { response: text };
    }
    const caption = String(data.response || data.caption || data.text || data.description || data.output || '').trim();
    if (!res.ok && !caption) throw new Error(data.error || 'Vision API ' + res.status);
    return { ok: true, response: caption, raw: data };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'Trill Lookout AI Cam',
    people: db.people.length,
    unknowns: db.unknowns.length,
    nvr: nvr.stats(),
    vision: VISION_BASE + '/analyze',
    time: new Date().toISOString()
  });
});

app.get('/api/vision/status', async (_req, res) => {
  try {
    const r = await fetch(VISION_BASE + '/', { signal: AbortSignal.timeout(8000) });
    res.json({ ok: r.ok, url: VISION_BASE + '/analyze', status: r.status });
  } catch (err) {
    res.json({ ok: false, url: VISION_BASE + '/analyze', error: err.message || 'unreachable' });
  }
});

app.post('/api/vision/analyze', nvrUpload.single('image'), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'image required' });
  try {
    const out = await callTrillVision(req.file.buffer, req.file.mimetype, req.body && req.body.prompt);
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Vision API failed', url: VISION_BASE + '/analyze' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json(db.config);
});

app.put('/api/config', (req, res) => {
  const next = { ...db.config };
  const allowed = Object.keys(DEFAULT_CONFIG);
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    const value = req.body[key];
    if (typeof DEFAULT_CONFIG[key] === 'boolean') next[key] = Boolean(value);
    else if (typeof DEFAULT_CONFIG[key] === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      next[key] = n;
    } else if (typeof DEFAULT_CONFIG[key] === 'string') {
      next[key] = String(value);
    }
  }
  if (!['ssd', 'tiny'].includes(next.detector)) next.detector = 'ssd';
  next.matchThreshold = clamp(next.matchThreshold, 0.28, 0.7);
  next.uncertainThreshold = clamp(next.uncertainThreshold, next.matchThreshold, 0.8);
  next.minFaceSize = clamp(next.minFaceSize, 24, 400);
  next.consecutiveHits = Math.round(clamp(next.consecutiveHits, 1, 20));
  next.consecutiveMisses = Math.round(clamp(next.consecutiveMisses, 1, 40));
  next.maxFaces = Math.round(clamp(next.maxFaces, 1, 40));
  next.nvrSegmentSeconds = Math.round(clamp(next.nvrSegmentSeconds, 10, 120));
  next.nvrRetentionDays = Math.round(clamp(next.nvrRetentionDays, 1, 60));
  next.motionThreshold = clamp(next.motionThreshold, 6, 60);
  next.motionMinArea = clamp(next.motionMinArea, 0.002, 0.2);
  if (next.soundThreshold != null) next.soundThreshold = clamp(next.soundThreshold, 0.01, 0.3);
  if (req.body.alertCooldownSec != null) {
    const sec = Number(req.body.alertCooldownSec);
    if (Number.isFinite(sec)) next.alertCooldownMs = Math.round(sec * 1000);
  }
  next.alertCooldownMs = Math.round(clamp(next.alertCooldownMs, 15000, 30 * 60 * 1000));
  if (next.unknownMaxPhotos != null) next.unknownMaxPhotos = Math.round(clamp(next.unknownMaxPhotos, 4, 80));
  db.config = next;
  saveDb();
  res.json(db.config);
});

app.get('/api/people', (_req, res) => {
  res.json(db.people.map(publicPerson));
});

app.get('/api/people/:id', (req, res) => {
  const person = findPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  res.json(publicPerson(person));
});

app.post('/api/people', (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const facebookUrl = cleanFacebook(req.body && req.body.facebookUrl);
  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : '';
  const relationship = typeof req.body.relationship === 'string' ? req.body.relationship.slice(0, 80) : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone.slice(0, 40) : '';
  const person = {
    id: uid(),
    name,
    facebookUrl,
    notes,
    relationship,
    phone,
    photos: [],
    createdAt: now(),
    updatedAt: now()
  };
  db.people.push(person);
  fs.mkdirSync(path.join(PEOPLE_MEDIA, person.id), { recursive: true });
  saveDb();
  res.status(201).json(publicPerson(person));
});

app.put('/api/people/:id', (req, res) => {
  const person = findPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    person.name = name;
  }
  if (req.body.facebookUrl !== undefined) {
    person.facebookUrl = cleanFacebook(req.body.facebookUrl);
  }
  if (req.body.notes !== undefined) {
    person.notes = String(req.body.notes).slice(0, 500);
  }
  if (req.body.relationship !== undefined) {
    person.relationship = String(req.body.relationship).slice(0, 80);
  }
  if (req.body.phone !== undefined) {
    person.phone = String(req.body.phone).slice(0, 40);
  }
  person.updatedAt = now();
  saveDb();
  res.json(publicPerson(person));
});

app.delete('/api/people/:id', (req, res) => {
  const idx = db.people.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Person not found' });
  const person = db.people[idx];
  db.people.splice(idx, 1);
  rmrf(path.join(PEOPLE_MEDIA, person.id));
  saveDb();
  res.json({ ok: true });
});

app.get('/api/animals', (_req, res) => {
  res.json((db.animals || []).map(publicAnimal));
});

app.post('/api/animals', (req, res, next) => {
  if (/multipart/i.test(String(req.headers['content-type'] || ''))) return upload.array('photos', 8)(req, res, next);
  next();
}, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const species = String((req.body && req.body.species) || 'cat')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 24) || 'cat';
  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : '';
  const animal = {
    id: uid(),
    name,
    species,
    notes,
    photos: [],
    createdAt: now(),
    updatedAt: now()
  };
  db.animals = db.animals || [];
  db.animals.push(animal);
  fs.mkdirSync(path.join(ANIMALS_MEDIA, animal.id), { recursive: true });
  const files = req.files || [];
  files.forEach((file) => storeAnimalPhoto(animal, file));
  saveDb();
  res.status(201).json(publicAnimal(animal));
});

app.put('/api/animals/:id', (req, res) => {
  const animal = (db.animals || []).find((a) => a.id === req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });
  if (req.body.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name is required' });
    animal.name = name;
  }
  if (req.body.species !== undefined) {
    animal.species = String(req.body.species).toLowerCase().replace(/[^a-z]/g, '').slice(0, 24) || animal.species;
  }
  if (req.body.notes !== undefined) animal.notes = String(req.body.notes).slice(0, 500);
  animal.updatedAt = now();
  saveDb();
  res.json(publicAnimal(animal));
});

app.delete('/api/animals/:id', (req, res) => {
  db.animals = db.animals || [];
  const idx = db.animals.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Animal not found' });
  const animal = db.animals[idx];
  db.animals.splice(idx, 1);
  rmrf(path.join(ANIMALS_MEDIA, animal.id));
  saveDb();
  res.json({ ok: true });
});

app.get('/api/unknown-animals', (_req, res) => {
  res.json((db.unknownAnimals || []).map(publicUnknownAnimal));
});

app.post('/api/unknown-animals', (req, res) => {
  const species = String((req.body && req.body.species) || 'animal')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 24) || 'animal';
  const color = String((req.body && req.body.color) || '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim()
    .slice(0, 24);
  const image = decodeDataImage(req.body && req.body.image);
  if (!image) return res.status(400).json({ error: 'Animal crop image required' });
  const source = String((req.body && req.body.source) || '').slice(0, 80);

  db.unknownAnimals = db.unknownAnimals || [];
  const existing = db.unknownAnimals.find((u) => {
    if (u.species !== species) return false;
    if (color && u.color && u.color !== color) return false;
    return true;
  });
  const maxPhotos = Number(db.config.unknownMaxPhotos || 36);
  if (existing) {
    existing.seenCount = (existing.seenCount || 0) + 1;
    existing.lastSeen = now();
    if (source) existing.source = source;
    if (color && !existing.color) existing.color = color;
    if (existing.images.length < maxPhotos) {
      existing.images.push(storeUnknownAnimalImage(existing, image));
    } else {
      saveDb();
      return res.json({ kind: 'duplicate', unknown: publicUnknownAnimal(existing) });
    }
    saveDb();
    return res.status(200).json({ kind: 'clustered', unknown: publicUnknownAnimal(existing) });
  }

  const cluster = {
    id: uid(),
    species,
    color,
    images: [],
    seenCount: 1,
    firstSeen: now(),
    lastSeen: now(),
    source,
    status: 'pending'
  };
  fs.mkdirSync(path.join(UNKNOWN_ANIMALS_MEDIA, cluster.id), { recursive: true });
  cluster.images.push(storeUnknownAnimalImage(cluster, image));
  db.unknownAnimals.push(cluster);
  if (db.unknownAnimals.length > 80) {
    const extra = db.unknownAnimals.shift();
    rmrf(path.join(UNKNOWN_ANIMALS_MEDIA, extra.id));
  }
  saveDb();
  const pub = publicUnknownAnimal(cluster);
  notifyUnknownAnimal(pub);
  res.status(201).json({ kind: 'new', unknown: pub });
});

app.post('/api/unknown-animals/:id/identify', (req, res) => {
  db.unknownAnimals = db.unknownAnimals || [];
  const cluster = db.unknownAnimals.find((u) => u.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Unknown animal not found' });
  let animal = req.body.animalId ? (db.animals || []).find((a) => a.id === req.body.animalId) : null;
  if (!animal) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Provide a name' });
    animal = {
      id: uid(),
      name,
      species: cluster.species || 'animal',
      notes: '',
      color: cluster.color || null,
      photos: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.animals = db.animals || [];
    db.animals.push(animal);
    fs.mkdirSync(path.join(ANIMALS_MEDIA, animal.id), { recursive: true });
  }
  adoptUnknownAnimal(animal, cluster);
  db.unknownAnimals = db.unknownAnimals.filter((u) => u.id !== cluster.id);
  animal.updatedAt = now();
  saveDb();
  res.json({ animal: publicAnimal(animal) });
});

app.delete('/api/unknown-animals/:id', (req, res) => {
  db.unknownAnimals = db.unknownAnimals || [];
  const idx = db.unknownAnimals.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Unknown animal not found' });
  const cluster = db.unknownAnimals[idx];
  db.unknownAnimals.splice(idx, 1);
  rmrf(path.join(UNKNOWN_ANIMALS_MEDIA, cluster.id));
  saveDb();
  res.json({ ok: true });
});

app.post('/api/people/:id/photos', upload.array('photos', 12), async (req, res) => {
  const person = findPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  const descriptors = parseDescriptors(req.body.descriptors);
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'At least one photo is required' });
  const added = [];
  files.forEach((file, i) => {
    const photo = storePersonPhoto(person, file, descriptors[i] || null);
    added.push(photo);
  });
  person.updatedAt = now();
  saveDb();
  const merged = db.config.autoMergeUnknowns ? reconcileUnknowns({ silent: true }) : { merged: [], suggestions: [] };
  res.status(201).json({ person: publicPerson(person), added, reconcile: merged });
});

app.post('/api/people/:id/descriptor', (req, res) => {
  const person = findPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  const photoId = req.body.photoId;
  const descriptor = asDescriptor(req.body.descriptor);
  if (!descriptor) return res.status(400).json({ error: 'Valid 128-d descriptor required' });
  const photo = person.photos.find((p) => p.id === photoId) || person.photos[person.photos.length - 1];
  if (!photo) return res.status(400).json({ error: 'No photo to attach descriptor to' });
  photo.descriptor = descriptor;
  person.updatedAt = now();
  saveDb();
  res.json(publicPerson(person));
});

app.delete('/api/people/:id/photos/:photoId', (req, res) => {
  const person = findPerson(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  const pidx = person.photos.findIndex((p) => p.id === req.params.photoId);
  if (pidx === -1) return res.status(404).json({ error: 'Photo not found' });
  const photo = person.photos[pidx];
  person.photos.splice(pidx, 1);
  const abs = path.join(MEDIA_DIR, photo.file);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  person.updatedAt = now();
  saveDb();
  res.json(publicPerson(person));
});

app.post('/api/import-url', async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const facebookUrl = cleanFacebook(req.body.facebookUrl);
    const imageUrl = String(req.body.imageUrl || '').trim();
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    if (isFacebookProfilePage(imageUrl)) {
      return res.status(400).json({
        error:
          'Facebook profile pages cannot be fetched automatically. Open the profile, save the profile photo, and upload it — or paste a direct image URL (often fbcdn.net).'
      });
    }
    const safe = await assertSafeImageUrl(imageUrl);
    const img = await fetchImage(safe);
    let person = req.body.personId ? findPerson(req.body.personId) : null;
    if (!person) {
      if (!name) return res.status(400).json({ error: 'Name is required when creating a person' });
      person = {
        id: uid(),
        name,
        facebookUrl,
        notes: '',
        photos: [],
        createdAt: now(),
        updatedAt: now()
      };
      db.people.push(person);
      fs.mkdirSync(path.join(PEOPLE_MEDIA, person.id), { recursive: true });
    } else if (facebookUrl) {
      person.facebookUrl = facebookUrl;
    }
    const fakeFile = { buffer: img.buffer, mimetype: img.mime, originalname: 'import' + extFor(img.mime) };
    const descriptor = asDescriptor(req.body.descriptor);
    storePersonPhoto(person, fakeFile, descriptor);
    person.updatedAt = now();
    saveDb();
    const merged = db.config.autoMergeUnknowns ? reconcileUnknowns({ silent: true }) : { merged: [], suggestions: [] };
    res.status(201).json({ person: publicPerson(person), reconcile: merged });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Import failed' });
  }
});

app.get('/api/unknowns', (_req, res) => {
  res.json(db.unknowns.map(publicUnknown));
});

app.post('/api/unknowns', (req, res) => {
  const descriptor = deep.l2norm(asDescriptor(req.body.descriptor));
  if (!descriptor) return res.status(400).json({ error: 'Valid descriptor required' });
  const image = decodeDataImage(req.body.image);
  if (!image) return res.status(400).json({ error: 'Face crop image required' });

  const known = deep.matchDeep(descriptor, db.people, db.config);
  if (known.status === 'known') {
    known.person.lastSeenAt = now();
    if (req.body && req.body.source) known.person.lastSeenSource = String(req.body.source).slice(0, 80);
    known.person.seenCount = (known.person.seenCount || 0) + 1;
    saveDb();
    return res.json({
      kind: 'ignored-known',
      person: publicPerson(known.person),
      distance: known.distance
    });
  }

  const clusterThresh = Math.min(db.config.matchThreshold + 0.04, 0.5);
  const existingUnknown = deep.bestUnknownMatch(descriptor, db.unknowns);
  if (existingUnknown && existingUnknown.distance <= clusterThresh) {
    const cluster = existingUnknown.cluster;
    cluster.seenCount += 1;
    cluster.lastSeen = now();
    const gallery = deep.descriptorsOfUnknown(cluster);
    const nearest = deep.minDistanceToGallery(descriptor, gallery);
    const maxPhotos = Number(db.config.unknownMaxPhotos || 36);
    if (nearest < 0.01 && cluster.images.length >= 12) {
      saveDb();
      return res.json({ kind: 'duplicate', unknown: publicUnknown(cluster), distance: nearest });
    }
    if (cluster.images.length >= maxPhotos) {
      const old = cluster.images.shift();
      try {
        const abs = path.join(MEDIA_DIR, unknownFile(old));
        if (old && unknownFile(old) && fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* keep going */
      }
    }
    cluster.images.push(storeUnknownImage(cluster, image, descriptor, req.body.quality));
    cluster.descriptor = deep.averageDescriptors(deep.descriptorsOfUnknown(cluster));
    saveDb();
    return res.status(200).json({ kind: 'clustered', unknown: publicUnknown(cluster), distance: existingUnknown.distance });
  }

  const cluster = {
    id: uid(),
    descriptor,
    images: [],
    seenCount: 1,
    firstSeen: now(),
    lastSeen: now(),
    status: 'pending'
  };
  fs.mkdirSync(path.join(UNKNOWN_MEDIA, cluster.id), { recursive: true });
  cluster.images.push(storeUnknownImage(cluster, image, descriptor, req.body.quality));
  db.unknowns.push(cluster);
  if (db.unknowns.length > 80) {
    const extra = db.unknowns.shift();
    rmrf(path.join(UNKNOWN_MEDIA, extra.id));
  }
  saveDb();
  const pub = publicUnknown(cluster);
  notifyUnknownFace(pub);
  res.status(201).json({ kind: 'new', unknown: pub });
});

app.post('/api/unknowns/:id/identify', (req, res) => {
  const cluster = db.unknowns.find((u) => u.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Unknown face not found' });
  let person = req.body.personId ? findPerson(req.body.personId) : null;
  if (!person) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Provide a name or an existing personId' });
    person = {
      id: uid(),
      name,
      facebookUrl: cleanFacebook(req.body.facebookUrl),
      notes: '',
      photos: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.people.push(person);
    fs.mkdirSync(path.join(PEOPLE_MEDIA, person.id), { recursive: true });
  }
  adoptUnknown(person, cluster);
  db.unknowns = db.unknowns.filter((u) => u.id !== cluster.id);
  const extra = pullMatchingUnknowns(person);
  person.updatedAt = now();
  saveDb();
  res.json({ person: publicPerson(person), mergedUnknowns: extra.length + 1 });
});

app.delete('/api/unknowns/:id', (req, res) => {
  const idx = db.unknowns.findIndex((u) => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Unknown face not found' });
  const cluster = db.unknowns[idx];
  db.unknowns.splice(idx, 1);
  rmrf(path.join(UNKNOWN_MEDIA, cluster.id));
  saveDb();
  res.json({ ok: true });
});

app.post('/api/match', (req, res) => {
  const descriptor = asDescriptor(req.body.descriptor);
  if (!descriptor) return res.status(400).json({ error: 'Valid descriptor required' });
  res.json(describeMatch(descriptor));
});

app.post('/api/reconcile', (_req, res) => {
  const result = reconcileUnknowns({ silent: false });
  saveDb();
  res.json(result);
});


app.get('/api/nvr/stats', (_req, res) => {
  res.json(nvr.stats());
});

app.get('/api/nvr/events', (req, res) => {
  res.json(nvr.listEvents(req.query.limit));
});

app.post(
  '/api/nvr/events',
  nvrUpload.fields([
    { name: 'gif', maxCount: 1 },
    { name: 'still', maxCount: 1 },
    { name: 'clip', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      let meta = {};
      if (req.body && req.body.meta) {
        meta = typeof req.body.meta === 'string' ? JSON.parse(req.body.meta) : req.body.meta;
      } else {
        meta = req.body || {};
      }
      const files = {
        gif: req.files && req.files.gif && req.files.gif[0],
        still: req.files && req.files.still && req.files.still[0],
        clip: req.files && req.files.clip && req.files.clip[0]
      };
      const event = await nvr.storeEvent(files, meta);
      res.status(201).json(event);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not store alert' });
    }
  }
);

app.delete('/api/nvr/events/:id', (req, res) => {
  if (!nvr.deleteEvent(req.params.id)) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
});

app.delete('/api/nvr/segments/:id', (req, res) => {
  if (!nvr.deleteSegment(req.params.id)) return res.status(404).json({ error: 'Clip not found' });
  res.json({ ok: true });
});

app.get('/api/push/key', (_req, res) => {
  res.json({ publicKey: pushHub.publicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  try {
    res.json(pushHub.subscribe(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Subscribe failed' });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  res.json(pushHub.unsubscribe((req.body && req.body.endpoint) || ''));
});

app.post('/api/nvr/events/:id/email', async (req, res) => {
  try {
    const event = await nvr.resend(req.params.id);
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Send failed' });
  }
});

app.get('/api/nvr/segments', (req, res) => {
  res.json(nvr.listSegments(req.query || {}));
});

app.post('/api/nvr/segments', nvrUpload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Video segment required' });
  try {
    const seg = nvr.storeSegment(req.file, {
      source: req.body.source,
      startedAt: req.body.startedAt,
      endedAt: req.body.endedAt
    });
    res.status(201).json(seg);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Segment save failed' });
  }
});

app.get('/api/nvr/email', (_req, res) => {
  res.json(nvr.getEmail());
});

app.put('/api/nvr/email', (req, res) => {
  res.json(nvr.setEmail(req.body || {}));
});

app.post('/api/nvr/email/test', async (_req, res) => {
  try {
    res.json(await nvr.testEmail());
  } catch (err) {
    res.status(400).json({ error: err.message || 'Test email failed' });
  }
});

app.get('/api/network', (_req, res) => {
  res.json({
    httpPort: HTTP_PORT,
    httpsPort: HTTPS_PORT,
    addresses: lanAddresses()
  });
});

app.get('/api/google/status', (_req, res) => {
  res.json(googleAuth.publicStatus());
});

app.put('/api/google/client', (req, res) => {
  try {
    res.json(googleAuth.setClient(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save Google client' });
  }
});

app.get('/api/google/start', (req, res) => {
  try {
    const st = googleAuth.publicStatus();
    const redirect = absoluteUrl(req, '/api/google/callback');
    if (!st.configured) {
      return res.redirect('/settings.html?google=need&redirect=' + encodeURIComponent(redirect) + '#google');
    }
    res.redirect(googleAuth.authUrl(redirect));
  } catch (err) {
    const redirect = absoluteUrl(req, '/api/google/callback');
    res.redirect('/settings.html?google=error&msg=' + encodeURIComponent(err.message || 'Google login failed') + '&redirect=' + encodeURIComponent(redirect) + '#google');
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const redirect = absoluteUrl(req, '/api/google/callback');
    const result = await googleAuth.handleCallback(String(req.query.code || ''), redirect);
    nvr.applyGoogleAccount(result);
    res.redirect('/settings.html?google=1#google');
  } catch (err) {
    res.redirect(
      '/settings.html?google=error&msg=' + encodeURIComponent(err.message || 'Google login failed') + '#google'
    );
  }
});

app.post('/api/google/disconnect', (_req, res) => {
  res.json(googleAuth.disconnect());
});

app.get('/api/share', async (req, res) => {
  try {
    const cam = String(req.query.cam || '').trim();
    const pathName = cam ? '/?cam=' + encodeURIComponent(cam) : '/';
    const primary = publicShareUrl(req, pathName);
    const urls = shareUrls(req, pathName);
    if (!urls.includes(primary)) urls.unshift(primary);
    const qr = await QRCode.toDataURL(primary, {
      width: 360,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1a1f3c', light: '#ffffff' }
    });
    res.json({
      urls: [...new Set(urls)],
      primary,
      qr,
      qrPng: '/api/share/qr.png?u=' + encodeURIComponent(primary),
      name: 'Trill Lookout AI Cam',
      origin: requestOrigin(req).origin,
      watch: publicShareUrl(req, '/'),
      host: publicShareUrl(req, '/host.html'),
      camera: cam ? primary : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Share failed' });
  }
});

app.get('/api/share/qr.png', async (req, res) => {
  try {
    const cam = String(req.query.cam || '').trim();
    const pathName = cam ? '/?cam=' + encodeURIComponent(cam) : '/';
    let target = String(req.query.u || '').trim();
    if (!target || !isAllowedShareUrl(req, target)) target = publicShareUrl(req, pathName);
    const buf = await QRCode.toBuffer(target, {
      type: 'png',
      width: 480,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1a1f3c', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'QR failed' });
  }
});

app.get('/api/live', (_req, res) => {
  res.json(liveHub.list());
});

app.get('/api/live/events', (req, res) => {
  liveHub.onList(res);
});

app.post('/api/live/:id/frame', nvrUpload.single('jpeg'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'jpeg frame required' });
  liveHub.push(req.params.id, req.file.buffer, {
    name: req.body && req.body.name,
    width: req.body && req.body.width,
    height: req.body && req.body.height,
    kind: req.body && req.body.kind,
    caption: req.body && req.body.caption,
    faces: req.body && req.body.faces
  });
  res.json({ ok: true });
});

app.get('/api/sightings', (req, res) => {
  const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 40));
  res.json((db.sightings || []).slice(0, limit));
});

app.post('/api/sightings', (req, res) => {
  const source = String((req.body && req.body.source) || '').slice(0, 80);
  const incoming = Array.isArray(req.body && req.body.faces) ? req.body.faces : req.body ? [req.body] : [];
  const at = now();
  db.sightings = db.sightings || [];
  let added = 0;
  for (const f of incoming) {
    if (!f) continue;
    const person = f.personId ? findPerson(f.personId) : null;
    const name = person ? person.name : cleanName(f.name);
    const status = String(f.status || (person ? 'known' : 'unknown')).slice(0, 24);
    if (!name && !person) continue;
    if (person) {
      person.lastSeenAt = at;
      person.lastSeenSource = source;
      person.seenCount = (person.seenCount || 0) + 1;
    }
    const last = db.sightings[0];
    if (
      last &&
      last.personId === (person ? person.id : null) &&
      last.name === (name || 'Unknown') &&
      last.source === source &&
      Date.now() - new Date(last.at).getTime() < 8000
    ) {
      last.at = at;
      last.count = (last.count || 1) + 1;
      added += 1;
      continue;
    }
    db.sightings.unshift({
      id: uid(),
      personId: person ? person.id : null,
      name: name || 'Unknown',
      kind: String(f.kind || '').slice(0, 24),
      status,
      source,
      at,
      count: 1
    });
    added += 1;
  }
  if (db.sightings.length > 120) db.sightings = db.sightings.slice(0, 80);
  if (added) saveDb();
  res.json({ ok: true, sightings: db.sightings.slice(0, 24) });
});

app.post('/api/live/:id/dead', (req, res) => {
  liveHub.dead(req.params.id);
  res.json({ ok: true });
});

app.get('/api/live/:id/jpeg', (req, res) => {
  const buf = liveHub.jpeg(req.params.id);
  if (!buf) return res.status(404).json({ error: 'No live frame yet — start the host camera' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

app.get('/api/live/:id/mjpeg', (req, res) => {
  liveHub.mjpegStream(req.params.id, req, res);
});

app.get('/api/cameras', (_req, res) => {
  res.json(cameraBook.list());
});

app.post('/api/cameras', (req, res) => {
  try {
    res.status(201).json(cameraBook.add(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not save camera' });
  }
});

app.put('/api/cameras/:id', (req, res) => {
  const cam = cameraBook.update(req.params.id, req.body || {});
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  res.json(cam);
});

app.delete('/api/cameras/:id', (req, res) => {
  if (!cameraBook.remove(req.params.id)) return res.status(404).json({ error: 'Camera not found' });
  liveHub.remove(req.params.id);
  res.json({ ok: true });
});

app.post('/api/cameras/:id/ptz', async (req, res) => {
  const cam = cameraBook.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found — save it under Settings → Cameras first' });
  try {
    const result = await ptz.move(cam, req.body || {});
    if (result && result.ok && result.style && result.style !== cam.ptzStyle) {
      cameraBook.update(cam.id, { ptz: true, ptzStyle: result.style });
    }
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Pan failed' });
  }
});

app.post('/api/cameras/scan', async (_req, res) => {
  try {
    res.json(await camScan.scanLan());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

app.post('/api/cameras/test', async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const result = await camScan.testLink(url, {
      username: req.body && req.body.username,
      password: req.body && req.body.password
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Test failed' });
  }
});

app.get('/api/cameras/:id/stream', (req, res) => {
  const cam = cameraBook.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  camScan.proxyCamera(cam, req, res);
});

app.post('/api/nvr/snaps', nvrUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image required' });
  try {
    res.status(201).json(nvr.storeSnap(req.file, { source: req.body.source }));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Snapshot save failed' });
  }
});

app.use((err, _req, res, _next) => {
  const msg = err && err.message ? err.message : 'Server error';
  const status = /only jpeg|file too large|unexpected/i.test(msg) ? 400 : 500;
  res.status(status).json({ error: msg });
});

function publicAnimal(animal) {
  return {
    id: animal.id,
    name: animal.name,
    species: animal.species || 'cat',
    notes: animal.notes || '',
    color: animal.color || null,
    createdAt: animal.createdAt,
    updatedAt: animal.updatedAt,
    photos: (animal.photos || []).map((p) => ({
      id: p.id,
      url: '/media/' + p.file.replace(/\\/g, '/'),
      createdAt: p.createdAt
    }))
  };
}

function storeAnimalPhoto(animal, file) {
  const id = uid();
  const ext = extFor(file.mimetype || '') || '.jpg';
  const rel = path.join('animals', animal.id, id + ext);
  const abs = path.join(MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.buffer);
  const photo = { id, file: rel.replace(/\\/g, '/'), createdAt: now() };
  animal.photos.push(photo);
  return photo;
}

function publicPerson(person) {
  return {
    id: person.id,
    name: person.name,
    facebookUrl: person.facebookUrl || '',
    notes: person.notes || '',
    relationship: person.relationship || '',
    phone: person.phone || '',
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
    lastSeenAt: person.lastSeenAt || null,
    lastSeenSource: person.lastSeenSource || '',
    seenCount: person.seenCount || 0,
    photos: person.photos.map((p) => ({
      id: p.id,
      url: '/media/' + p.file.replace(/\\/g, '/'),
      descriptor: p.descriptor || null,
      createdAt: p.createdAt
    }))
  };
}

function unknownFile(img) {
  if (!img) return '';
  return typeof img === 'string' ? img : img.file;
}

function publicUnknown(cluster) {
  const photos = (cluster.images || [])
    .map((img) => {
      const file = unknownFile(img);
      if (!file) return null;
      return {
        url: '/media/' + String(file).replace(/\\/g, '/'),
        createdAt: (img && img.createdAt) || cluster.firstSeen || null
      };
    })
    .filter(Boolean);
  return {
    id: cluster.id,
    seenCount: cluster.seenCount,
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    status: cluster.status,
    descriptor: cluster.descriptor,
    photoCount: photos.length,
    images: photos.map((p) => p.url),
    photos
  };
}

function publicUnknownAnimal(cluster) {
  const photos = (cluster.images || [])
    .map((img) => {
      const file = unknownFile(img);
      if (!file) return null;
      return {
        url: '/media/' + String(file).replace(/\\/g, '/'),
        createdAt: (img && img.createdAt) || cluster.firstSeen || null
      };
    })
    .filter(Boolean);
  return {
    id: cluster.id,
    species: cluster.species || 'animal',
    color: cluster.color || '',
    seenCount: cluster.seenCount,
    firstSeen: cluster.firstSeen,
    lastSeen: cluster.lastSeen,
    source: cluster.source || '',
    status: cluster.status,
    photoCount: photos.length,
    images: photos.map((p) => p.url),
    photos
  };
}

function storeUnknownAnimalImage(cluster, image) {
  const id = uid();
  const ext = extFor(image.mime) || '.jpg';
  const rel = path.join('unknown-animals', cluster.id, id + ext).replace(/\\/g, '/');
  const abs = path.join(MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, image.buffer);
  return { file: rel, createdAt: now() };
}

function adoptUnknownAnimal(animal, cluster) {
  const destDir = path.join(ANIMALS_MEDIA, animal.id);
  fs.mkdirSync(destDir, { recursive: true });
  for (const img of cluster.images || []) {
    const rel = unknownFile(img);
    const src = path.join(MEDIA_DIR, rel);
    if (!rel || !fs.existsSync(src)) continue;
    const id = uid();
    const ext = path.extname(rel) || '.jpg';
    const newRel = path.join('animals', animal.id, id + ext).replace(/\\/g, '/');
    fs.copyFileSync(src, path.join(MEDIA_DIR, newRel));
    animal.photos.push({ id, file: newRel, createdAt: now() });
  }
  rmrf(path.join(UNKNOWN_ANIMALS_MEDIA, cluster.id));
}

function notifyUnknownAnimal(unk) {
  if (!unk) return;
  const img = (unk.photos && unk.photos[0] && unk.photos[0].url) || (unk.images && unk.images[0]) || '';
  const kind = unk.species || 'animal';
  Promise.resolve(
    pushHub.notify({
      id: 'unk-a-' + unk.id,
      title: 'Unknown ' + kind + ' — add a name',
      description: 'Tap the photo on Home to name this ' + kind + '.',
      caption: 'Unknown ' + kind,
      watchUrl: '/#unknown-animals',
      stillUrl: img,
      gifUrl: img,
      actions: [
        { action: 'view', title: 'Add name' },
        { action: 'mute', title: 'Mute' }
      ]
    })
  ).catch(() => {});
}

function notifyUnknownFace(unk) {
  if (!unk) return;
  const img = (unk.photos && unk.photos[0] && unk.photos[0].url) || (unk.images && unk.images[0]) || '';
  const n = unk.photoCount || (unk.images && unk.images.length) || 1;
  Promise.resolve(
    pushHub.notify({
      id: 'unk-' + unk.id,
      title: 'Unknown person — add a name',
      description:
        'A new face was photographed (' +
        n +
        ' photo' +
        (n === 1 ? '' : 's') +
        '). Tap their photo on Home to add a name so Lookout can recognize them next time.',
      caption: 'Unknown face captured',
      watchUrl: '/#unknowns',
      stillUrl: img,
      gifUrl: img,
      actions: [
        { action: 'view', title: 'Add name' },
        { action: 'mute', title: 'Mute' }
      ]
    })
  ).catch(() => {});
}

function findPerson(id) {
  return db.people.find((p) => p.id === id) || null;
}

function storePersonPhoto(person, file, descriptor) {
  const id = uid();
  const ext = extFor(file.mimetype || '') || path.extname(file.originalname || '').toLowerCase() || '.jpg';
  const rel = path.join('people', person.id, id + ext);
  const abs = path.join(MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.buffer);
  const photo = { id, file: rel.replace(/\\/g, '/'), descriptor: descriptor ? deep.l2norm(descriptor) : null, createdAt: now() };
  person.photos.push(photo);
  return { id, url: '/media/' + photo.file, descriptor: photo.descriptor };
}

function storeUnknownImage(cluster, image, descriptor, quality) {
  const id = uid();
  const ext = extFor(image.mime) || '.jpg';
  const rel = path.join('unknowns', cluster.id, id + ext).replace(/\\/g, '/');
  const abs = path.join(MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, image.buffer);
  return {
    file: rel,
    descriptor: descriptor || cluster.descriptor || null,
    quality: quality || null,
    createdAt: now()
  };
}

function adoptUnknown(person, cluster) {
  const destDir = path.join(PEOPLE_MEDIA, person.id);
  fs.mkdirSync(destDir, { recursive: true });
  for (const img of cluster.images || []) {
    const rel = unknownFile(img);
    const src = path.join(MEDIA_DIR, rel);
    if (!rel || !fs.existsSync(src)) continue;
    const id = uid();
    const ext = path.extname(rel) || '.jpg';
    const newRel = path.join('people', person.id, id + ext).replace(/\\/g, '/');
    fs.copyFileSync(src, path.join(MEDIA_DIR, newRel));
    person.photos.push({
      id,
      file: newRel,
      descriptor: (img && img.descriptor) || cluster.descriptor,
      createdAt: now()
    });
  }
  rmrf(path.join(UNKNOWN_MEDIA, cluster.id));
}

function pullMatchingUnknowns(person) {
  const pulled = [];
  const remain = [];
  for (const cluster of db.unknowns) {
    const match = deep.matchDeep(cluster.descriptor, [person], db.config);
    if (match.status === 'known') {
      adoptUnknown(person, cluster);
      pulled.push(cluster.id);
    } else remain.push(cluster);
  }
  db.unknowns = remain;
  return pulled;
}

function reconcileUnknowns() {
  const merged = [];
  const suggestions = [];
  const remain = [];
  for (const cluster of db.unknowns) {
    const match = deep.matchDeep(cluster.descriptor, db.people, db.config);
    if (!match.person) {
      remain.push(cluster);
      continue;
    }
    if (match.status === 'known' && db.config.autoMergeUnknowns) {
      adoptUnknown(match.person, cluster);
      match.person.updatedAt = now();
      merged.push({ unknownId: cluster.id, personId: match.person.id, name: match.person.name, distance: match.distance });
    } else if (match.status === 'known' || match.status === 'uncertain') {
      suggestions.push({
        unknownId: cluster.id,
        personId: match.person.id,
        name: match.person.name,
        distance: match.distance
      });
      remain.push(cluster);
    } else {
      remain.push(cluster);
    }
  }
  db.unknowns = remain;
  saveDb();
  return { merged, suggestions };
}

function describeMatch(descriptor) {
  const match = deep.matchDeep(descriptor, db.people, db.config);
  if (!match.person) return { status: 'unknown', person: null, distance: null, second: null };
  return {
    status: match.status,
    person: publicPerson(match.person),
    distance: match.distance,
    second: match.second || null
  };
}

function asDescriptor(value) {
  if (!value) return null;
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length !== 128) return null;
  const nums = arr.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return deep.l2norm(nums);
}

function parseDescriptors(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(asDescriptor);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 128 && typeof parsed[0] === 'number') return [asDescriptor(parsed)];
      if (Array.isArray(parsed)) return parsed.map(asDescriptor);
    } catch {
      return [];
    }
  }
  return [];
}

function decodeDataImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(mime)) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
  return { mime, buffer };
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function cleanFacebook(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    if (!/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fbcdn\.net$/i.test(u.hostname)) return v.slice(0, 300);
    return u.href.slice(0, 300);
  } catch {
    if (/^[\w.]+$/.test(v)) return 'https://www.facebook.com/' + v;
    return '';
  }
}

function isFacebookProfilePage(url) {
  try {
    const u = new URL(url);
    return /(^|\.)facebook\.com$|(^|\.)fb\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.replace('::ffff:', ''));
    return false;
  }
  return true;
}

async function assertSafeImageUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) image URLs are allowed');
  const looked = await dns.lookup(u.hostname, { all: true });
  for (const item of looked) {
    if (isPrivateIp(item.address)) throw new Error('That host is not allowed');
  }
  return u.href;
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'LookoutFaceID/1.0', Accept: 'image/*,*/*;q=0.8' }
    });
    if (!res.ok) throw new Error('Image fetch failed (' + res.status + ')');
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mime && !/^image\//.test(mime)) throw new Error('URL did not return an image');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new Error('Image too large');
    if (buf.length < 32) throw new Error('Image too small');
    return { buffer: buf, mime: mime || 'image/jpeg' };
  } finally {
    clearTimeout(t);
  }
}

function extFor(mime) {
  if (/png/.test(mime)) return '.png';
  if (/webp/.test(mime)) return '.webp';
  if (/gif/.test(mime)) return '.gif';
  return '.jpg';
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function ensureDirs() {
  for (const d of [DATA_DIR, MEDIA_DIR, PEOPLE_MEDIA, ANIMALS_MEDIA, UNKNOWN_MEDIA, UNKNOWN_ANIMALS_MEDIA, CERT_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const fresh = { people: [], animals: [], unknowns: [], unknownAnimals: [], sightings: [], config: { ...DEFAULT_CONFIG } };
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    raw.people = Array.isArray(raw.people) ? raw.people : [];
    raw.animals = Array.isArray(raw.animals) ? raw.animals : [];
    raw.unknowns = Array.isArray(raw.unknowns) ? raw.unknowns.map(normalizeUnknownCluster) : [];
    raw.unknownAnimals = Array.isArray(raw.unknownAnimals) ? raw.unknownAnimals : [];
    raw.sightings = Array.isArray(raw.sightings) ? raw.sightings : [];
    const prev = raw.config || {};
    const firstPersonRules = !Object.prototype.hasOwnProperty.call(prev, 'alertOnPerson');
    raw.config = { ...DEFAULT_CONFIG, ...prev };
    if (firstPersonRules) {
      raw.config.nvrContinuous = false;
      raw.config.alertOnMotion = false;
      raw.config.alertOnSound = false;
      raw.config.alertOnPerson = true;
      raw.config.alertOnAnimal = true;
      raw.config.recordOnPerson = true;
      raw.config.recordOnAnimal = true;
      raw.config.recordOnThreat = true;
    }
    if (Number(raw.config.minFaceSize) >= 60) raw.config.minFaceSize = 28;
    if (Number(raw.config.minDetectionScore) >= 0.5) raw.config.minDetectionScore = 0.32;
    if (Number(raw.config.consecutiveHits) >= 5) raw.config.consecutiveHits = 2;
    if (Number(raw.config.minSharpness) >= 80) raw.config.minSharpness = 40;
    if (Number(raw.config.unknownCaptureCooldownMs) >= 800) raw.config.unknownCaptureCooldownMs = 400;
    return raw;
  } catch {
    return { people: [], animals: [], unknowns: [], unknownAnimals: [], sightings: [], config: { ...DEFAULT_CONFIG } };
  }
}

function normalizeUnknownCluster(u) {
  const images = (u.images || []).map((img) => {
    if (typeof img === 'string') return { file: img, descriptor: u.descriptor || null, createdAt: u.firstSeen || now() };
    return img;
  });
  return { ...u, images };
}

function saveDb() {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function requestOrigin(req) {
  const host = String(req.get('host') || 'localhost:' + HTTP_PORT);
  const xf = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto =
    xf === 'https' || xf === 'http'
      ? xf
      : req.secure || req.protocol === 'https' || /:3443$/.test(host)
        ? 'https'
        : 'http';
  return { proto, host, origin: proto + '://' + host };
}

function clientOriginHint(req) {
  const raw = String(req.query.origin || req.get('origin') || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function allowedShareHosts(req) {
  const hosts = new Set();
  const reqHost = String(req.get('host') || '');
  if (reqHost) hosts.add(reqHost.toLowerCase());
  hosts.add('localhost:' + HTTP_PORT);
  hosts.add('localhost:' + HTTPS_PORT);
  hosts.add('127.0.0.1:' + HTTP_PORT);
  hosts.add('127.0.0.1:' + HTTPS_PORT);
  hosts.add('[::1]:' + HTTP_PORT);
  hosts.add('[::1]:' + HTTPS_PORT);
  for (const ip of lanAddresses()) {
    hosts.add(ip + ':' + HTTP_PORT);
    hosts.add(ip + ':' + HTTPS_PORT);
    hosts.add(ip);
  }
  return hosts;
}

function isAllowedShareUrl(req, raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hosts = allowedShareHosts(req);
    const host = u.host.toLowerCase();
    const hostname = u.hostname.toLowerCase();
    if (hosts.has(host) || hosts.has(hostname)) return true;
    const reqHost = String(req.get('host') || '').toLowerCase();
    if (host === reqHost || hostname === String(req.hostname || '').toLowerCase()) return true;
    return false;
  } catch {
    return false;
  }
}

function publicShareUrl(req, pathname) {
  const pathName = pathname || '/';
  const hint = clientOriginHint(req);
  if (hint && isAllowedShareUrl(req, hint + pathName)) return hint + pathName;
  const { proto, host, origin } = requestOrigin(req);
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host);
  if (loopback) {
    const lan = lanAddresses()[0];
    if (lan) {
      const port = proto === 'https' ? HTTPS_PORT : HTTP_PORT;
      return proto + '://' + lan + ':' + port + pathName;
    }
  }
  return origin + pathName;
}

function absoluteUrl(req, pathname) {
  return requestOrigin(req).origin + pathname;
}

function shareUrls(req, pathname) {
  const pathName = pathname || '/';
  const { proto, host } = requestOrigin(req);
  const out = [publicShareUrl(req, pathName), proto + '://' + host + pathName];
  for (const ip of lanAddresses()) {
    out.push('https://' + ip + ':' + HTTPS_PORT + pathName);
    out.push('http://' + ip + ':' + HTTP_PORT + pathName);
  }
  out.push('https://localhost:' + HTTPS_PORT + pathName);
  out.push('http://localhost:' + HTTP_PORT + pathName);
  return [...new Set(out)];
}

function googleOkPage(email) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google connected</title>
  <style>body{font-family:sans-serif;background:#000;color:#fff;display:grid;place-items:center;height:100vh;margin:0}
  .card{background:#000;padding:28px;border:1px solid #222;border-radius:16px;max-width:420px}
  a{color:#ff6bb5}</style></head><body><div class="card">
  <h1>Google connected</h1>
  <p>Alerts will send from <strong>${String(email || '').replace(/[<>]/g, '')}</strong>.</p>
  <p><a href="/watch.html">Back to Trill Lookout AI Cam</a></p>
  <script>setTimeout(function(){window.location='/?google=1';},900);</script>
  </div></body></html>`;
}

function googleErrorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Google login</title>
  <style>body{font-family:sans-serif;background:#000;color:#fff;display:grid;place-items:center;height:100vh;margin:0}
  .card{background:#000;padding:28px;border:1px solid #222;border-radius:16px;max-width:420px}
  a{color:#5b8cff}</style></head><body><div class="card">
  <h1>Google login failed</h1>
  <p>${String(msg || 'Unknown error').replace(/[<>]/g, '')}</p>
  <p><a href="/">Back</a></p>
  </div></body></html>`;
}

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.internal) continue;
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      out.push(n.address);
    }
  }
  return out;
}

function ensureCerts() {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert };
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '825',
      '-subj',
      '/CN=Lookout Local',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  );
  return { key, cert };
}

function printBanner() {
  const addrs = lanAddresses();
  const lines = [
    '',
    '  TRILL LOOKOUT AI CAM  ·  local DVR + scene AI',
    '  ------------------------------------------',
    '  Local  http://localhost:' + HTTP_PORT,
    '  Local  https://localhost:' + HTTPS_PORT + '  (camera + screen share)',
    ...addrs.flatMap((ip) => [
      '  LAN    http://' + ip + ':' + HTTP_PORT + '   (no camera — use HTTPS)',
      '  LAN    https://' + ip + ':' + HTTPS_PORT + '  (accept the self-signed warning)'
    ]),
    '',
    '  Home            https://localhost:' + HTTPS_PORT + '/',
    '  Host            https://localhost:' + HTTPS_PORT + '/host.html',
    '  Live cameras    https://localhost:' + HTTPS_PORT + '/watch.html',
    '  Settings/email  https://localhost:' + HTTPS_PORT + '/settings.html',
    ''
  ];
  console.log(lines.join('\n'));
}

const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  try {
    const { key, cert } = ensureCerts();
    const httpsServer = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      app
    );
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => printBanner());
    httpsServer.on('error', (err) => {
      console.warn('HTTPS did not start:', err.message);
      printBanner();
    });
  } catch (err) {
    console.warn('Could not create TLS certs:', err.message);
    printBanner();
  }
});
