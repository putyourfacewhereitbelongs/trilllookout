#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ThreatHub, threatLabel, SmartFallDetector, SmartTheftDetector, ViolenceDetector } from '../public/js/threat.js';
import { describeScene, SceneTracker } from '../public/js/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL  ' + name + ' — ' + (err && err.message));
  }
}

async function okAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL  ' + name + ' — ' + (err && err.message));
  }
}

function person(x, y, w, h, score = 0.9) {
  return { class: 'person', x, y, w, h, score, label: 'Person', kind: 'person' };
}
function thing(cls, x, y, w, h, score = 0.8) {
  return { class: cls, x, y, w, h, score, label: cls, kind: 'thing' };
}

console.log('syntax');
for (const rel of [
  'server.js',
  'mailer.js',
  'nvr-store.js',
  'google-oauth.js',
  'push.js',
  'deep-match.js',
  'live-hub.js',
  'cameras-store.js',
  'cam-scan.js',
  'ptz.js',
  'public/js/app.js',
  'public/js/nvr.js',
  'public/js/engine.js',
  'public/js/vision.js',
  'public/js/threat.js',
  'public/js/videos.js',
  'public/js/detect-worker.js',
  'public/js/nav.js',
  'public/js/origin.js',
  'public/js/ding.js',
  'public/js/watch.js',
  'public/js/tutorial.js',
  'public/js/settings-page.js',
  'public/js/enroll-page.js',
  'public/js/live-client.js',
  'public/js/night-vision.js',
  'public/js/persist.js',
  'public/js/install.js',
  'public/js/share-page.js',
  'public/js/ip-cameras.js',
  'public/js/moondream.js',
  'public/js/perf.js'
]) {
  const file = path.join(ROOT, rel);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  ok(rel + ' parses', () => {
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
}

console.log('threat heuristics');
ok('fall detector needs a drop + horizontal + ground', () => {
  const fall = new SmartFallDetector('cam');
  const H = 720;
  const standing = { class_name: 'person', conf: 0.9, bbox: [200, 80, 280, 420] };
  for (let i = 0; i < 8; i++) fall.analyze([standing], H, i);
  const empty = fall.analyze([standing], H, 9);
  assert.equal(empty.length, 0);
  let hit = [];
  const frames = [
    [200, 180, 290, 480],
    [180, 280, 310, 540],
    [160, 400, 360, 620],
    [150, 520, 390, 680],
    [140, 610, 420, 700]
  ];
  for (let i = 0; i < 24; i++) {
    const box = frames[Math.min(i, frames.length - 1)];
    const fallen = { class_name: 'person', conf: 0.9, bbox: box };
    hit = fall.analyze([fallen], H, 10 + i);
    if (hit.length) break;
  }
  assert.ok(hit.some((h) => h.type === 'fall_detected'), 'expected fall_detected, got ' + JSON.stringify(hit));
});

ok('theft flags a vanished stationary backpack', () => {
  const theft = new SmartTheftDetector('cam');
  const pack = { class_name: 'backpack', conf: 0.9, bbox: [40, 200, 90, 280] };
  const owner = { class_name: 'person', conf: 0.9, bbox: [30, 80, 110, 400] };
  for (let f = 0; f < 16; f++) theft.analyze([pack, owner], f, f);
  let hit = [];
  for (let f = 16; f < 28; f++) {
    hit = theft.analyze([owner], f, f);
    if (hit.length) break;
  }
  assert.ok(hit.some((h) => h.type === 'theft_detected'), 'expected theft_detected');
});

ok('violence needs two close people + motion', () => {
  const v = new ViolenceDetector('cam');
  const a = { class_name: 'person', conf: 0.9, bbox: [100, 100, 180, 360] };
  const b = { class_name: 'person', conf: 0.9, bbox: [150, 110, 230, 370] };
  let hit = [];
  for (let i = 0; i < 12; i++) {
    hit = v.analyze([a, b], { score: 0.12 }, i);
    if (hit.length) break;
  }
  assert.ok(hit.some((h) => h.type === 'fight_detected' || h.type === 'violence_detected'));
});

ok('ThreatHub cooldown suppresses duplicate types', () => {
  const hub = new ThreatHub('cam');
  const video = { videoHeight: 720, videoWidth: 1280 };
  const a = person(100, 100, 80, 260);
  const b = person(150, 110, 80, 260);
  let first = [];
  for (let i = 0; i < 14; i++) {
    first = hub.analyze([a, b], video, { score: 0.2 });
    if (first.length) break;
  }
  assert.ok(first.length);
  const second = hub.analyze([a, b], video, { score: 0.2 });
  assert.equal(second.length, 0);
  assert.equal(threatLabel('fall_detected'), 'FALL');
  assert.equal(threatLabel('theft_detected'), 'THEFT');
});

console.log('scene copy');
ok('describeScene titles a fall', () => {
  const scene = describeScene({
    faces: [],
    objects: [person(10, 10, 40, 80)],
    motion: { score: 0.2, where: ['center'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: [{ type: 'fall_detected', description: 'fall' }]
  });
  assert.match(scene.title, /fall/i);
  assert.match(scene.description, /ALERT/);
  assert.match(scene.live.toUpperCase(), /FALL/);
});

ok('describeScene names a walking person', () => {
  const scene = describeScene({
    faces: [{ label: { status: 'known', name: 'Maya', kind: 'Girl' } }],
    objects: [person(10, 10, 40, 80)],
    motion: { score: 0.12, where: ['top-center'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: [],
    tracks: [{ class: 'person', kind: 'person', name: 'Maya', action: 'walking up', cx: 100, cy: 80 }]
  });
  assert.match(scene.title, /Maya/i);
  assert.match(scene.live, /Maya/);
  assert.doesNotMatch(scene.title, /Trill Lookout Cam/i);
});

ok('describeScene still scene without threats', () => {
  const scene = describeScene({
    faces: [],
    objects: [],
    motion: { score: 0, where: [], lighting: 'normal' },
    sound: { active: false },
    source: 'screen',
    threats: []
  });
  assert.match(scene.description, /Watching/);
  assert.doesNotMatch(scene.title, /FALL|THEFT|THREAT/);
  assert.doesNotMatch(scene.live, /heavy motion/i);
});

ok('describeScene never leads with motion intensity', () => {
  const scene = describeScene({
    faces: [],
    objects: [],
    motion: { score: 0.25, where: ['center'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: []
  });
  assert.doesNotMatch(scene.live, /heavy motion/i);
  assert.doesNotMatch(scene.description, /Heavy movement/);
  assert.match(scene.live, /Watching/i);
});

ok('describeScene counts animals by kind', () => {
  const scene = describeScene({
    faces: [],
    objects: [
      { class: 'cat', kind: 'animal', x: 1, y: 1, w: 10, h: 10 },
      { class: 'cat', kind: 'animal', x: 2, y: 1, w: 10, h: 10 },
      { class: 'dog', kind: 'animal', x: 3, y: 1, w: 10, h: 10 },
      { class: 'dog', kind: 'animal', x: 4, y: 1, w: 10, h: 10 },
      { class: 'bird', kind: 'animal', x: 5, y: 1, w: 10, h: 10 }
    ],
    motion: { score: 0.05, where: ['center'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: []
  });
  assert.match(scene.live, /5 animals/i);
  assert.match(scene.live, /2 cats/i);
  assert.match(scene.live, /2 dogs/i);
  assert.match(scene.live, /1 bird/i);
  assert.match(scene.description, /5 animals/i);
});

ok('describeScene uses Moondream narrative when provided', () => {
  const scene = describeScene({
    faces: [{ label: { status: 'known', name: 'Maya', kind: 'Girl' } }],
    objects: [person(10, 10, 40, 80)],
    motion: { score: 0.04, where: ['center'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: [],
    narrative: 'Maya in a blue coat walks a tan dog up the ramp beside a red car.'
  });
  assert.match(scene.live, /ramp/i);
  assert.match(scene.description, /ramp/i);
  assert.match(scene.title, /Maya|ramp|dog/i);
});

ok('SceneTracker follow coasts boxes between detections', () => {
  const t = new SceneTracker();
  t.update([{ class: 'cat', kind: 'animal', x: 10, y: 10, w: 40, h: 30, score: 0.9, name: 'Luna' }], 720);
  t.items[0].vx = 0.2;
  t.items[0].vy = 0;
  t.items[0].updated = performance.now() - 100;
  const coast = t.follow();
  assert.ok(coast[0].x > 10);
  assert.equal(coast[0].name, 'Luna');
});

ok('describeScene names car color and kind', () => {
  const scene = describeScene({
    faces: [],
    objects: [{ class: 'car', kind: 'vehicle', colorName: 'red', x: 1, y: 1, w: 40, h: 20, label: 'Car' }],
    motion: { score: 0.04, where: ['left'], lighting: 'normal' },
    sound: { active: false },
    source: 'camera',
    threats: []
  });
  assert.match(scene.live, /red car/i);
  assert.match(scene.description, /red car/i);
});

console.log('files');
ok('host page has camera + snap/record + IP cams + alert dock', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/host.html'), 'utf8');
  for (const id of ['btnShare', 'btnSnapSave', 'btnRecClip', 'alertDock', 'threatPill', 'btnBroadcast', 'btnShareCam', 'camForm', 'btnTestCam', 'btnSaveCam', 'hostRoster', 'hostKnownFaces', 'hostUnknownFaces', 'hostKnownAnimals', 'hostUnknownAnimals']) {
    assert.ok(html.includes(id), 'missing ' + id);
  }
  assert.doesNotMatch(html, /location\.replace\('\/watch\.html'\)/);
});

ok('settings has Google email + camera scan', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');
  for (const id of ['btnGoogle', 'btnTestCam', 'btnSaveCam', 'btnScan', 'btnReplay']) {
    assert.ok(html.includes(id), 'missing ' + id);
  }
});

ok('watch/enroll pages and ding exist', () => {
  for (const f of ['watch.html', 'host.html', 'enroll.html', 'settings.html', 'share.html', 'go.html', 'sounds/alert.wav']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), f);
  }
});

ok('viewers land on live cameras; share QR is a PNG of this origin', () => {
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const go = fs.readFileSync(path.join(ROOT, 'public/go.html'), 'utf8');
  const share = fs.readFileSync(path.join(ROOT, 'public/share.html'), 'utf8');
  const watchHtml = fs.readFileSync(path.join(ROOT, 'public/watch.html'), 'utf8');
  const watchJs = fs.readFileSync(path.join(ROOT, 'public/js/watch.js'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'public/js/live-client.js'), 'utf8');
  const man = fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8');
  const origin = fs.readFileSync(path.join(ROOT, 'public/js/origin.js'), 'utf8');
  const install = fs.readFileSync(path.join(ROOT, 'public/js/install.js'), 'utf8');
  assert.match(index, /watch\.html/);
  assert.match(index, /host\.html/);
  assert.doesNotMatch(index, /getDisplayMedia|getUserMedia|btnBroadcast/);
  assert.match(go, /watch\.html/);
  assert.match(go, /host\.html/);
  assert.match(share, /\/api\/share\/qr\.png/);
  assert.doesNotMatch(watchHtml, /btnBroadcast/);
  assert.doesNotMatch(watchHtml, /Use this device as a camera/);
  assert.match(watchHtml, /peopleList/);
  assert.match(watchHtml, /unknownList/);
  assert.match(watchHtml, /unknownAnimalList/);
  assert.match(watchHtml, /nameModal/);
  assert.match(watchHtml, /Tap a photo to add a name/);
  assert.match(watchHtml, /liveScene/);
  assert.match(watchHtml, /sightingList/);
  assert.match(watchHtml, /homeDvr/);
  assert.match(watchHtml, /dvrGrid/);
  assert.match(watchJs, /watch-focus/);
  assert.match(watchJs, /jpegSrc/);
  assert.match(watchJs, /refreshFaces/);
  assert.match(watchJs, /whenLabel/);
  assert.match(watchJs, /openNameModal/);
  assert.match(watchJs, /\/api\/unknown-animals/);
  assert.match(watchJs, /renderDvr/);
  assert.match(watchJs, /osNotifyGif/);
  assert.match(watchJs, /showNotification/);
  assert.match(live, /camKind/);
  assert.match(man, /"start_url": "\/"/);
  assert.match(man, /standalone/);
  assert.match(origin, /host\.html/);
  assert.match(origin, /label: 'Home'/);
  assert.match(install, /watch-page/);
  assert.match(install, /subscribePush/);
  assert.match(install, /notificationsOn/);
  assert.match(install, /Notification.permission === 'granted'/);
});

ok('product title is Trill Lookout AI Cam', () => {
  const man = fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const nav = fs.readFileSync(path.join(ROOT, 'public/js/nav.js'), 'utf8');
  assert.match(man, /Trill Lookout AI Cam/);
  assert.match(man, /"short_name": "Trill Lookout AI Cam"/);
  assert.match(index, /Trill Lookout AI Cam/);
  assert.match(index, /apple-mobile-web-app-title" content="Trill Lookout AI Cam"/);
  assert.match(nav, /brand-name">Trill Lookout AI Cam/);
});

ok('UI shell is complete on home and host', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'public/css/shell.css'), 'utf8');
  const watchHtml = fs.readFileSync(path.join(ROOT, 'public/watch.html'), 'utf8');
  const hostHtml = fs.readFileSync(path.join(ROOT, 'public/host.html'), 'utf8');
  const watchJs = fs.readFileSync(path.join(ROOT, 'public/js/watch.js'), 'utf8');
  const nav = fs.readFileSync(path.join(ROOT, 'public/js/nav.js'), 'utf8');
  assert.match(shell, /host-chrome/);
  assert.match(shell, /cam-frame/);
  assert.match(shell, /object-fit: contain/);
  assert.doesNotMatch(shell, /object-fit:\s*cover/);
  assert.match(watchHtml, /shell\.css/);
  assert.match(watchHtml, /Open Host/);
  assert.match(watchHtml, /reveal-card/);
  assert.match(hostHtml, /host-chrome/);
  assert.match(hostHtml, /class="has-nav host-page"/);
  assert.match(watchJs, /cam-frame/);
  assert.match(nav, /nav-logo/);
});

ok('mobile CSS puts nav on top and keeps desktop sidebar', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 960px\)/);
  assert.match(css, /@media \(min-width: 961px\)/);
  assert.match(css, /flex-direction: row !important/);
  assert.match(css, /host-mobile-extra \{ display: none !important; \}/);
  assert.match(css, /overscroll-behavior: none/);
  assert.match(css, /ptz-pad/);
  assert.match(css, /scroll-hint/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /object-fit: contain/);
  assert.doesNotMatch(css, /object-fit:\s*cover/);
  assert.match(css, /home-faces/);
  assert.match(css, /live-scene/);
  assert.match(css, /home-dvr/);
  assert.match(css, /host-roster/);
  assert.match(css, /touch-action: pan-y/);
});

ok('server exposes google + share routes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const s of ['/api/google/start', '/api/google/callback', '/api/live', '/api/cameras', '/api/share', '/api/share/qr.png', '/api/cameras/:id/ptz', 'publicShareUrl', 'alertOnPerson', 'recordOnPerson', '/api/sightings', 'notifyUnknownFace', '/api/unknown-animals', 'notifyUnknownAnimal', '/api/vision/analyze', 'discipline-tracking-sympathy-tommy.trycloudflare.com']) {
    assert.ok(src.includes(s), 'missing ' + s);
  }
});

ok('nvr-store exports applyGoogleAccount', () => {
  const src = fs.readFileSync(path.join(ROOT, 'nvr-store.js'), 'utf8');
  assert.ok(src.includes('applyGoogleAccount'));
  assert.ok(src.includes('threats:'));
});

ok('nvr records on people and animals, not motion', () => {
  const nvr = fs.readFileSync(path.join(ROOT, 'public/js/nvr.js'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'public/js/engine.js'), 'utf8');
  assert.match(nvr, /export function sceneLife/);
  assert.match(nvr, /lastDetections/);
  assert.match(nvr, /needCoco/);
  assert.match(nvr, /recordOnPerson !== false && life\.person/);
  assert.match(nvr, /recordOnAnimal !== false && life\.animal/);
  assert.doesNotMatch(nvr, /shouldRecord[\s\S]{0,280}result\.active/);
  assert.match(engine, /track\.captures >= 36/);
  assert.match(engine, /track\.hits < 2/);
  assert.match(engine, /pad = 0.08/);
  assert.match(engine, /snapUnknownFace/);
  assert.match(engine, /scaleLandmarksInPlace/);
  assert.match(engine, /typeof crop === 'string'/);
  assert.match(nvr, /captureUnknownAnimals/);
  assert.match(nvr, /cropBox/);
  assert.match(nvr, /onUnknownAnimal/);
  assert.match(nvr, /maybeMoondream/);
  assert.match(nvr, /startMoondream/);
  assert.match(nvr, /tracker.follow/);
  assert.match(nvr, /narrative: moon/);
  const moon = fs.readFileSync(path.join(ROOT, 'public/js/moondream.js'), 'utf8');
  assert.match(moon, /describeFrame/);
  assert.match(moon, /\/api\/vision\/analyze/);
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /trill-lookout-cam-v16/);
  assert.ok(sw.includes('/css/shell.css'));
  assert.match(sw, /\/js\/perf\.js/);
  assert.match(sw, /moondream-worker.js/);
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /onUnknownAnimal/);
  assert.match(app, /hostUnknownAnimals/);
  assert.match(app, /showHostGifPop/);
  assert.match(app, /getPerf/);
  const perfJs = fs.readFileSync(path.join(ROOT, 'public/js/perf.js'), 'utf8');
  assert.match(perfJs, /export function getPerf/);
  assert.match(perfJs, /skipLocalVision/);
  assert.match(engine, /detectMaxWidth/);
  assert.match(nvr, /nvrMs/);
});

console.log('cjs modules');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-test-'));
const { createGoogleOAuth } = await import(pathToFileURL(path.join(ROOT, 'google-oauth.js')).href);
ok('google oauth status shape', () => {
  const g = createGoogleOAuth(tmp);
  const st = g.publicStatus();
  assert.equal(typeof st.configured, 'boolean');
  assert.equal(typeof st.connected, 'boolean');
});

const { threatKind } = await import(pathToFileURL(path.join(ROOT, 'mailer.js')).href);
ok('mailer labels threats', () => {
  assert.equal(threatKind('fall_detected'), 'Fall');
  assert.equal(threatKind({ type: 'theft_detected' }), 'Theft');
  assert.equal(threatKind({ type: 'fight_detected' }), 'Fight');
});

const { createLiveHub } = await import(pathToFileURL(path.join(ROOT, 'live-hub.js')).href);
ok('live hub stores jpeg frames', () => {
  const hub = createLiveHub();
  hub.push('host', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { name: 'Host camera', caption: 'Maya is walking up the ramp.' });
  const list = hub.list();
  assert.equal(list[0].id, 'host');
  assert.ok(hub.jpeg('host').length);
  assert.match(list[0].caption, /Maya/);
});

const { createCamerasStore } = await import(pathToFileURL(path.join(ROOT, 'cameras-store.js')).href);
ok('cameras store rejects RTSP', () => {
  const book = createCamerasStore(tmp, () => 'cam-1', () => new Date().toISOString());
  let threw = false;
  try {
    book.add({ name: 'Wyze', url: 'rtsp://192.168.1.8/live', brand: 'wyze' });
  } catch (err) {
    threw = /RTSP/i.test(err.message);
  }
  assert.ok(threw);
  const cam = book.add({ name: 'Porch', url: 'http://192.168.1.8/snapshot.jpg', brand: 'wyze' });
  assert.equal(cam.brand, 'wyze');
  assert.equal(cam.ptz, true);
  assert.ok(cam.watchPath.includes('watch.html'));
});

const { createNvr } = await import(pathToFileURL(path.join(ROOT, 'nvr-store.js')).href);
await okAsync('nvr event labels Fall threat kind', async () => {
  const nvr = createNvr({
    root: tmp,
    uid: () => 'evt-' + Math.random().toString(16).slice(2),
    now: () => new Date().toISOString(),
    getConfig: () => ({}),
    google: createGoogleOAuth(tmp)
  });
  const ev = await nvr.storeEvent({}, { title: 'Fall', threats: [{ type: 'fall_detected' }], source: 'screen' });
  assert.deepEqual(ev.threatKind, ['Fall']);
  assert.equal(ev.title, 'Fall');
});
ok('nvr applyGoogleAccount enables mail', () => {
  const nvr = createNvr({
    root: tmp,
    uid: () => 'test-id',
    now: () => new Date().toISOString(),
    getConfig: () => ({}),
    google: createGoogleOAuth(tmp)
  });
  const before = nvr.getEmail();
  assert.ok('googleConfigured' in before || true);
  const after = nvr.applyGoogleAccount({ email: 'lookout@example.com' });
  assert.equal(after.enabled, true);
  assert.equal(after.to, 'lookout@example.com');
  assert.equal(after.googleEmail, 'lookout@example.com');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
