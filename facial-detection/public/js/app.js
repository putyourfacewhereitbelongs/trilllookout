import { FaceEngine, describeImage, matchDescriptor } from './engine.js';
import { NvrController } from './nvr.js';
import { mountNav } from './nav.js';
import { playAlertDing, playFaultBeep, unlockDing } from './ding.js';
import { startTutorial, replayTutorial } from './tutorial.js';
import { publishLoop } from './live-client.js';
import { absUrl, shareQuery, qrPngSrc } from './origin.js';
import { saveCapture, loadCapture, rememberHostOrigin, muteUntil, isMuted, setRole } from './persist.js';
import { setupInstall, requestKeepAlive, showPermissionCoach } from './install.js';
import { attachNightVision } from './night-vision.js';
import { bindIpCameras } from './ip-cameras.js';
import { getPerf } from './perf.js';

const faceapi = window.faceapi;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  config: null,
  people: [],
  unknowns: [],
  modelsReady: false,
  engines: [],
  screenStream: null,
  cameraStream: null,
  enrollFiles: [],
  listeners: new Map(),
  nvr: null,
  events: [],
  segments: [],
  email: null,
  openEventId: null,
  publishStops: [],
  recordingManual: false,
  animals: [],
  unknownAnimals: [],
  captureMode: null,
  scenes: {},
  lastSightingAt: new Map()
};

const ui = {
  modelStatus: $('#modelStatus'),
  streamStatus: $('#streamStatus'),
  faceCount: $('#faceCount'),
  fpsPill: $('#fpsPill'),
  stageEmpty: $('#stageEmpty'),
  liveLog: $('#liveLog'),
  peopleList: $('#peopleList'),
  unknownList: $('#unknownList'),
  unknownBadge: $('#unknownBadge'),
  peopleCount: $('#peopleCount'),
  enrollThumbs: $('#enrollThumbs'),
  hudSource: $('#hudSource'),
  hudStrict: $('#hudStrict'),
  hudMotion: $('#hudMotion'),
  netInfo: $('#netInfo'),
  feeds: $('#feeds'),
  motionPill: $('#motionPill'),
  soundPill: $('#soundPill'),
  aiPill: $('#aiPill'),
  threatPill: $('#threatPill'),
  recPill: $('#recPill'),
  liveCaption: $('#liveCaption'),
  btnInstall: $('#btnInstall'),
  nvrBadge: $('#nvrBadge'),
  nvrDisk: $('#nvrDisk'),
  eventList: $('#eventList'),
  segmentList: $('#segmentList')
};

function emit(event, payload) {
  const set = state.listeners.get(event);
  if (set) {
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.warn(err);
      }
    }
  }
}

function on(event, fn) {
  if (!state.listeners.has(event)) state.listeners.set(event, new Set());
  state.listeners.get(event).add(fn);
  return () => state.listeners.get(event).delete(fn);
}

function log(kind, message) {
  const row = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  row.className = kind;
  row.textContent = t + '  ' + message;
  ui.liveLog.prepend(row);
  while (ui.liveLog.childNodes.length > 80) ui.liveLog.removeChild(ui.liveLog.lastChild);
}

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data;
}

async function loadConfig() {
  state.config = await api('/api/config');
  fillSettings();
  ui.hudStrict.textContent = 'match ≤ ' + Number(state.config.matchThreshold).toFixed(2);
}

async function loadPeople() {
  state.people = await api('/api/people');
  renderPeople();
}

async function loadAnimals() {
  try {
    state.animals = await api('/api/animals');
    renderAnimals();
  } catch {
    state.animals = [];
  }
}

async function loadUnknownAnimals() {
  try {
    state.unknownAnimals = await api('/api/unknown-animals');
    renderUnknownAnimals();
  } catch {
    state.unknownAnimals = [];
    renderUnknownAnimals();
  }
}

function copyList(fromId, toId) {
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  if (from && to) to.innerHTML = from.innerHTML;
}

async function loadUnknowns() {
  state.unknowns = await api('/api/unknowns');
  renderUnknowns();
}

async function loadNvr() {
  try {
    const [events, segments, stats, email] = await Promise.all([
      api('/api/nvr/events?limit=40'),
      api('/api/nvr/segments'),
      api('/api/nvr/stats'),
      api('/api/nvr/email')
    ]);
    state.events = events;
    state.segments = segments;
    state.email = email;
    ui.nvrBadge.textContent = String(events.length);
    ui.nvrDisk.textContent = formatBytes(stats.bytes) + ' · ' + stats.segments + ' clips';
    fillEmail(email);
    renderEvents();
    renderSegments();
  } catch (err) {
    log('e', err.message);
  }
}

function fillEmail(email) {
  const form = $('#emailForm');
  if (!form || !email) return;
  for (const el of form.elements) {
    if (!el.name || el.name === 'pass') continue;
    const v = email[el.name];
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
  }
  const st = $('#googleStatus');
  if (!st) return;
  if (email.googleConnected && email.googleEmail) {
    st.textContent = 'Sending as ' + email.googleEmail + ' via Google. Alerts go to the address below.';
  } else if (email.googleConfigured) {
    st.textContent = 'Google client saved. Click Connect Google to pick the Gmail that sends alerts.';
  } else {
    st.textContent = 'Connect Google to send alerts from your Gmail in one click.';
  }
}

function formatBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function renderEvents() {
  if (!state.events.length) {
    ui.eventList.innerHTML = '<div class="empty-inline">No person / animal / threat alerts yet. Start the host camera.</div>';
    const dock = $('#alertDock');
    if (dock) dock.innerHTML = '<div class="muted small">Person, animal, and threat GIFs land here.</div>';
    return;
  }
  ui.eventList.innerHTML = state.events
    .map((ev) => {
      const thumb = ev.gifUrl || ev.stillUrl || '';
      const kind = (ev.threatKind && ev.threatKind[0]) || '';
      const mail =
        ev.emailStatus === 'sent'
          ? '<span class="mail-ok">emailed</span>'
          : ev.emailStatus === 'error'
            ? '<span class="mail-bad">email failed</span>'
            : '<span class="muted small">' + escapeHtml(ev.emailStatus || '') + '</span>';
      return `<article class="event-card gif-card" data-id="${ev.id}">
        ${thumb ? `<img src="${escapeAttr(thumb)}" alt="alert gif">` : `<img alt="">`}
        <div class="meta">
          <h3>${kind ? `<span class="kind-pill">${escapeHtml(kind)}</span>` : ''}${escapeHtml(ev.title || 'Alert')}</h3>
          <span class="muted small">${escapeHtml(timeAgo(ev.createdAt))} · ${mail}</span>
        </div>
      </article>`;
    })
    .join('');
  const dock = $('#alertDock');
  if (dock) {
    dock.innerHTML = state.events
      .slice(0, 10)
      .map((ev) => {
        const gif = ev.gifUrl || ev.stillUrl || '';
        const kind = (ev.threatKind && ev.threatKind[0]) || '';
        return `<article class="alert-chip" data-id="${ev.id}">
          ${gif ? `<img src="${escapeAttr(gif)}" alt="gif">` : ''}
          <div class="meta">${kind ? `<span class="kind">${escapeHtml(kind)}</span>` : ''}${escapeHtml(ev.title || 'Alert')}</div>
        </article>`;
      })
      .join('');
    dock.querySelectorAll('.alert-chip').forEach((chip) => {
      chip.onclick = () => openEvent(chip.dataset.id);
    });
  }
}

function renderSegments() {
  if (!state.segments.length) {
    ui.segmentList.innerHTML = '<div class="empty-inline">No recordings yet. Continuous NVR starts when a feed is live.</div>';
    return;
  }
  ui.segmentList.innerHTML = state.segments
    .slice(0, 24)
    .map((s) => {
      const t = s.startedAt ? new Date(s.startedAt).toLocaleString() : '';
      return `<article class="segment-card" data-url="${escapeAttr(s.url)}">
        <div class="meta">
          <h3>${escapeHtml(s.source)} · ${formatBytes(s.bytes)}</h3>
          <span class="muted small">${escapeHtml(t)}</span>
        </div>
      </article>`;
    })
    .join('');
}

function openEvent(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  state.openEventId = id;
  $('#eventTitle').textContent = ev.title || 'Alert';
  $('#eventDesc').textContent = ev.description || '';
  const media = [];
  if (ev.gifUrl) media.push(`<img src="${escapeAttr(ev.gifUrl)}" alt="10 second gif">`);
  if (ev.stillUrl) media.push(`<img src="${escapeAttr(ev.stillUrl)}" alt="still">`);
  if (ev.clipUrl) media.push(`<video src="${escapeAttr(ev.clipUrl)}" controls muted></video>`);
  $('#eventMedia').innerHTML = media.join('');
  $('#eventModal').classList.remove('hidden');
}

function fillSettings() {
  if (!state.config) return;
  fillForm($('#settingsForm'), state.config);
  const nvrVals = {
    ...state.config,
    alertCooldownSec: Math.round(Number(state.config.alertCooldownMs || 120000) / 1000)
  };
  fillForm($('#nvrForm'), nvrVals);
  updateRangeLabels();
}

function fillForm(form, values) {
  if (!form) return;
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = values[el.name];
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
  }
}

function formPayload(form) {
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
  }
  return body;
}

function updateRangeLabels() {
  $$('#settingsForm [data-for], #nvrForm [data-for]').forEach((span) => {
    const input = document.querySelector('[name="' + span.dataset.for + '"]');
    if (input) span.textContent = input.value;
  });
}

function renderPeople() {
  const q = ($('#peopleSearch').value || '').trim().toLowerCase();
  const list = state.people.filter((p) => !q || p.name.toLowerCase().includes(q));
  ui.peopleCount.textContent = String(state.people.length);
  if (!list.length) {
    ui.peopleList.innerHTML =
      '<div class="empty-inline">No one enrolled yet. Use the Add tab — name, photos, optional Facebook profile.</div>';
    copyList('peopleList', 'hostKnownFaces');
    return;
  }
  ui.peopleList.innerHTML = list
    .map((p) => {
      const thumb = (p.photos && p.photos[0] && p.photos[0].url) || '';
      const seen = p.lastSeenAt ? 'Last seen ' + timeAgo(p.lastSeenAt) : (p.photos.length + ' photo' + (p.photos.length === 1 ? '' : 's'));
      const fb = p.facebookUrl
        ? `<a class="fb" href="${escapeAttr(p.facebookUrl)}" target="_blank" rel="noopener">${escapeHtml(prettyFb(p.facebookUrl))}</a>`
        : `<span class="muted small">${escapeHtml(seen)}</span>`;
      return `<article class="person-card" data-id="${p.id}">
        ${thumb ? `<img src="${escapeAttr(thumb)}" alt="">` : `<img alt="">`}
        <div class="meta"><h3>${escapeHtml(p.name)}</h3>${fb}</div>
        <div class="tools">
          <button class="icon-btn" data-act="add" title="Add photos">+</button>
          <button class="icon-btn" data-act="del" title="Remove">✕</button>
        </div>
      </article>`;
    })
    .join('');
  copyList('peopleList', 'hostKnownFaces');
}

function renderUnknowns() {
  ui.unknownBadge.textContent = String(state.unknowns.length);
  if (!state.unknowns.length) {
    ui.unknownList.innerHTML =
      '<div class="empty-inline">No unknown captures. When a stable unfamiliar face appears, Lookout will crop it here.</div>';
    copyList('unknownList', 'hostUnknownFaces');
    return;
  }
  const options = state.people.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  ui.unknownList.innerHTML = state.unknowns
    .map((u) => {
      const photos = u.images || [];
      const gallery = photos
        .map((src) => `<img src="${escapeAttr(src)}" alt="unknown face">`)
        .join('');
      const n = u.photoCount || photos.length;
      return `<article class="unknown-card" data-id="${u.id}">
        <div class="gallery">${gallery || '<img alt="">'}</div>
        <div class="meta">
          <h3>Unknown · ${n} photo${n === 1 ? '' : 's'} · seen ${u.seenCount}×</h3>
          <span class="muted small">${timeAgo(u.lastSeen)}</span>
        </div>
        <div class="tools">
          <input type="text" placeholder="Name this person" data-name />
          <select data-assign>
            <option value="">Assign existing…</option>
            ${options}
          </select>
          <button class="btn tiny primary" data-act="id">Save</button>
          <button class="btn tiny" data-act="drop">Dismiss</button>
        </div>
      </article>`;
    })
    .join('');
  copyList('unknownList', 'hostUnknownFaces');
}

function renderAnimals() {
  const el = $('#animalList');
  if (!el) return;
  const list = state.animals || [];
  if (!list.length) {
    el.innerHTML = '<div class="empty-inline">Name a cat, dog, or other animal when you see it — labels then use that name.</div>';
    copyList('animalList', 'hostKnownAnimals');
    return;
  }
  el.innerHTML = list
    .map((a) => {
      const thumb = (a.photos && a.photos[0] && a.photos[0].url) || '';
      return `<article class="person-card" data-animal="${a.id}">
        ${thumb ? `<img src="${escapeAttr(thumb)}" alt="">` : `<img alt="">`}
        <div class="meta"><h3>${escapeHtml(a.name)}</h3><span class="muted small">${escapeHtml(a.species)}</span></div>
        <div class="tools"><button class="icon-btn" data-act="adel" title="Remove">✕</button></div>
      </article>`;
    })
    .join('');
}

function prettyFb(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(iso).toLocaleString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

async function loadModels() {
  ui.modelStatus.classList.remove('on');
  log('', 'Loading face models…');
  const uri = '/models';
  const p = getPerf();
  const loads = [
    faceapi.nets.tinyFaceDetector.loadFromUri(uri),
    faceapi.nets.faceLandmark68Net.loadFromUri(uri),
    faceapi.nets.faceRecognitionNet.loadFromUri(uri)
  ];
  if (!p.skipSsd) loads.unshift(faceapi.nets.ssdMobilenetv1.loadFromUri(uri));
  await Promise.all(loads);
  if (!p.skipAgeGender) {
    try {
      await faceapi.nets.ageGenderNet.loadFromUri(uri);
      log('k', 'Age / gender model ready — girl & boy labels');
    } catch (err) {
      log('e', 'Age/gender model missing — person kind labels limited');
    }
  }
  state.modelsReady = true;
  ui.modelStatus.classList.add('on');
  ui.modelStatus.innerHTML = '<i class="led"></i> models ready';
  log('k', 'Models ready — faces + scene AI');
  if (p.level !== 'high') log('k', 'Low-end mode (' + p.level + ') — lighter AI for this device');
}

function peopleForMatch() {
  return state.people;
}

function makeEngine(video, canvas) {
  const engine = new FaceEngine({
    video,
    canvas,
    config: state.config,
    getPeople: peopleForMatch,
    onLog: log
  });
  engine.onUnknown = async (payload) => {
    try {
      const result = await api('/api/unknowns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          descriptor: payload.descriptor,
          image: payload.image,
          quality: payload.quality || null,
          source: feedSource(engine)
        })
      });
      if (result.kind === 'ignored-known') {
        log('k', 'Skip capture — already ' + result.person.name);
        return;
      }
      if (result.kind === 'duplicate') return;
      if (result.kind === 'clustered') {
        const n = result.unknown.photoCount || (result.unknown.images && result.unknown.images.length) || 0;
        log('u', 'Unknown cluster +photo (' + n + ' shots, seen ' + result.unknown.seenCount + '×)');
        await loadUnknowns();
      } else if (result.kind === 'new' || result.unknown) {
        log('u', 'New unknown face — collecting shots');
        toast('New unknown face — extra photos will group here');
        await loadUnknowns();
        emit('unknown', result.unknown);
      }
    } catch (err) {
      log('e', err.message);
    }
  };
  engine.onDetect = (dets) => {
    const faces = state.engines.reduce((n, e) => n + e.tracks.length, 0);
    ui.faceCount.textContent = faces + (faces === 1 ? ' face' : ' faces');
    const fps = Math.max(...state.engines.map((e) => e.fps), 0);
    ui.fpsPill.textContent = fps + ' fps';
    const source = feedSource(engine);
    const packed = (dets || [])
      .map((d) => ({
        name: (d.label && d.label.name) || '',
        personId: (d.label && d.label.personId) || '',
        kind: (d.label && d.label.kind) || '',
        status: (d.label && d.label.status) || ''
      }))
      .filter((f) => f.name || f.status);
    if (!state.scenes[source]) state.scenes[source] = { caption: '', faces: [] };
    state.scenes[source].faces = packed;
    reportSightings(packed, source);
    emit('detect', dets);
  };
  return engine;
}

function feedSource(engine) {
  const id = (engine && engine.video && engine.video.id) || (engine && engine.name) || '';
  if (id === 'videoScreen') return 'screen';
  if (id === 'videoCamera') return 'camera';
  return String(id).replace(/^video-/, '') || 'host';
}

function publishMeta(camId) {
  return () => {
    const sc = state.scenes[camId] || {};
    return { caption: sc.caption || '', faces: sc.faces || [] };
  };
}

function reportSightings(faces, source) {
  if (!faces || !faces.length) return;
  const nowt = Date.now();
  const batch = [];
  for (const f of faces) {
    const key = (f.personId || f.name || '') + '@' + source;
    if (!key || key === '@' + source) continue;
    if (nowt - (state.lastSightingAt.get(key) || 0) < 5000) continue;
    state.lastSightingAt.set(key, nowt);
    batch.push(f);
  }
  if (!batch.length) return;
  fetch('/api/sightings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, faces: batch })
  }).catch(() => {});
}

function showFeed(which) {
  const screen = document.querySelector('[data-feed="screen"]');
  const camera = document.querySelector('[data-feed="camera"]');
  ui.feeds.classList.toggle('split', which === 'both');
  if (which === 'camera') {
    screen.classList.add('hidden');
    camera.classList.remove('hidden');
  } else if (which === 'both') {
    screen.classList.remove('hidden');
    camera.classList.remove('hidden');
  } else {
    screen.classList.remove('hidden');
    camera.classList.add('hidden');
  }
}

function bindStream(video, stream) {
  video.srcObject = stream;
  return video.play().catch(() => {});
}

function stopEngines() {
  for (const e of state.engines) e.stop();
  state.engines = [];
}

function stopStreams() {
  for (const s of [state.screenStream, state.cameraStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  state.screenStream = null;
  state.cameraStream = null;
  $('#videoScreen').srcObject = null;
  $('#videoCamera').srcObject = null;
}

async function startScreen() {
  await ensureModels();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: getPerf().camFps || 15, displaySurface: 'browser' },
      audio: true,
      preferCurrentTab: false,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      systemAudio: 'include'
    });
  } catch {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: getPerf().camFps || 15, displaySurface: 'browser' },
      audio: false
    });
  }
  if (!stream.getAudioTracks().length) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      mic.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch {
      /* sound optional */
    }
  }
  state.screenStream = stream;
  stream.getVideoTracks()[0].addEventListener('ended', () => stopAll());
  await bindStream($('#videoScreen'), stream);
  return stream;
}

async function startCamera() {
  await ensureModels();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: {
        width: { ideal: getPerf().camWidth || 1280 },
        height: { ideal: getPerf().camHeight || 720 },
        frameRate: { ideal: getPerf().camFps || 15, max: 24 },
        facingMode: 'user'
      }
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: getPerf().camWidth || 1280 },
        height: { ideal: getPerf().camHeight || 720 },
        frameRate: { ideal: getPerf().camFps || 15, max: 24 },
        facingMode: 'user'
      }
    });
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      mic.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch {
      /* sound optional */
    }
  }
  state.cameraStream = stream;
  await bindStream($('#videoCamera'), stream);
  return stream;
}

function stopOneStream(which) {
  if (which === 'screen' && state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    $('#videoScreen').srcObject = null;
  }
  if (which === 'camera' && state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
    $('#videoCamera').srcObject = null;
  }
}

async function begin(mode) {
  try {
    await ensureModels();
    stopEngines();
    if (mode === 'screen') {
      stopOneStream('camera');
      showFeed('screen');
      if (!state.screenStream) await startScreen();
    } else if (mode === 'camera') {
      stopOneStream('screen');
      showFeed('camera');
      if (!state.cameraStream) await startCamera();
    } else {
      showFeed('both');
      if (!state.screenStream) await startScreen();
      if (!state.cameraStream) await startCamera();
    }
    ui.stageEmpty.classList.add('hidden');
    document.body.classList.add('live-on');
    ui.streamStatus.classList.add('on');
    ui.streamStatus.innerHTML = '<i class="led"></i> live';
    $('#btnStop').disabled = false;
    $('#btnSnapshot').disabled = false;
    if ($('#btnSnapSave')) $('#btnSnapSave').disabled = false;
    if ($('#btnRecClip')) $('#btnRecClip').disabled = false;
    ui.hudSource.textContent = mode === 'both' ? 'screen + camera' : mode;

    if (mode !== 'camera') {
      state.engines.push(makeEngine($('#videoScreen'), $('#overlayScreen')));
    }
    if (mode !== 'screen') {
      state.engines.push(makeEngine($('#videoCamera'), $('#overlayCamera')));
    }
    for (const e of state.engines) {
      e.setConfig(state.config);
      e.start();
    }
    startNvr(mode);
    stopPublish();
    if (mode !== 'camera' && state.screenStream) {
      state.publishStops.push(publishLoop($('#videoScreen'), 'screen', 'Host camera', 'host', publishMeta('screen')));
    }
    if (mode !== 'screen' && state.cameraStream) {
      state.publishStops.push(publishLoop($('#videoCamera'), 'camera', 'Device camera', 'device', publishMeta('camera')));
    }
    unlockDing();
    state.captureMode = mode;
    setRole('host');
    saveCapture({ mode, running: true });
    rememberHostOrigin();
    applyNightVision();
    requestKeepAlive();
    showPermissionCoach();
    hideResumeBar();
    log('k', 'Recognition live on ' + mode);
    emit('start', { mode });
  } catch (err) {
    toast(err.message || String(err), 'err');
    log('e', err.message || String(err));
    if (/not supported|undefined/i.test(err.message || '') || err.name === 'NotAllowedError') {
      toast('Allow screen/camera. Use localhost or HTTPS if you are on the network.', 'err');
    }
  }
}

function startNvr(mode) {
  if (!state.nvr) {
    state.nvr = new NvrController({
      getConfig: () => state.config,
      getAnimals: () => state.animals || [],
      log,
      onUnknownAnimal: async (payload) => {
        try {
          const result = await api('/api/unknown-animals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (result.kind === 'ignored-known' || result.kind === 'duplicate') return;
          if (result.kind === 'new') log('u', 'Unknown ' + ((result.unknown && result.unknown.species) || 'animal') + ' — add a name');
          await loadUnknownAnimals();
        } catch (err) {
          log('e', err.message);
        }
      },
      onEvent: async (ev) => {
        await loadNvr();
        notifyLocal(ev);
        showHostGifPop(ev);
        playAlertDing();
        enlargeCam(ev && ev.source);
      },
      onDead: (source) => {
        playFaultBeep();
        toast('Camera "' + source + '" stopped or froze', 'err');
        const tile = document.querySelector('[data-feed="' + source + '"]');
        if (tile) tile.classList.add('dead');
      },
      onMotion: (_source, result, sound, _objects, threats) => {
        if (result && result.active) {
          ui.motionPill.classList.add('hot', 'on');
          if (ui.hudMotion) ui.hudMotion.textContent = (result.where && result.where.length ? result.where.join(', ') : 'motion');
        } else {
          ui.motionPill.classList.remove('hot');
        }
        if (ui.soundPill) {
          if (sound && sound.active) ui.soundPill.classList.add('hot', 'on');
          else ui.soundPill.classList.remove('hot');
        }
        if (ui.threatPill) {
          const banner = document.getElementById('threatBanner');
          if (threats && threats.length) {
            const label = String(threats[0].type || 'threat').replace(/_/g, ' ');
            ui.threatPill.classList.add('hot', 'on');
            ui.threatPill.innerHTML = '<i class="led"></i> ' + label;
            if (banner) {
              banner.textContent = label.toUpperCase();
              banner.classList.remove('hidden');
            }
          } else {
            ui.threatPill.classList.remove('hot');
            ui.threatPill.innerHTML = '<i class="led"></i> threat';
            if (banner) banner.classList.add('hidden');
          }
        }
      },
      onCaption: (source, scene) => {
        const text = (scene && (scene.live || scene.description)) || '';
        if (ui.liveCaption) ui.liveCaption.textContent = text;
        if (!state.scenes[source]) state.scenes[source] = { caption: '', faces: [] };
        state.scenes[source].caption = text;
      }
    });
    if (state.nvr.objects) {
      state.nvr.objects.onReady = () => {
        if (ui.aiPill) {
          ui.aiPill.classList.add('on');
          ui.aiPill.innerHTML = '<i class="led"></i> scene ai';
        }
        log('k', 'Scene AI ready — people, animals, objects');
      };
    }
  }
  ui.recPill.classList.add('on');
  ui.recPill.innerHTML = '<i class="led"></i> dvr';

  if (mode !== 'camera' && state.screenStream) {
    const eng = state.engines.find((e) => e.video === $('#videoScreen'));
    state.nvr.attach($('#videoScreen'), state.screenStream, 'screen', eng);
  }
  if (mode !== 'screen' && state.cameraStream) {
    const eng = state.engines.find((e) => e.video === $('#videoCamera'));
    state.nvr.attach($('#videoCamera'), state.cameraStream, 'camera', eng);
  }
}

function stopPublish() {
  for (const fn of state.publishStops || []) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  state.publishStops = [];
}

function enlargeCam(source) {
  const feeds = $('#feeds');
  if (!feeds) return;
  const tiles = [...feeds.querySelectorAll('.feed, .cam-tile')];
  const live = tiles.filter((t) => !t.classList.contains('hidden'));
  if (live.length <= 1) {
    feeds.classList.add('solo');
    feeds.classList.remove('alerted');
    return;
  }
  feeds.classList.remove('solo');
  feeds.classList.add('alerted');
  tiles.forEach((t) => {
    const id = t.dataset.feed || t.dataset.id;
    t.classList.toggle('hero', id === source);
  });
}

function applyNightVision() {
  const on = !!(state.config && state.config.nightVision);
  const vs = [$('#videoScreen'), $('#videoCamera')].filter(Boolean);
  vs.forEach((v) => attachNightVision(v, on && v.srcObject));
}

function showResumeBar() {
  let bar = $('#resumeBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'resumeBar';
    bar.className = 'resume-bar';
    bar.innerHTML =
      '<span>Resume the same camera / shared tab?</span><button type="button" class="btn primary" id="btnResume">Resume</button>';
    document.body.appendChild(bar);
    bar.querySelector('#btnResume').onclick = () => {
      const cap = loadCapture();
      begin(cap.mode || state.captureMode || 'screen');
    };
  }
  bar.classList.add('show');
}

function hideResumeBar() {
  const bar = $('#resumeBar');
  if (bar) bar.classList.remove('show');
}

function stopAll(opts = {}) {
  stopPublish();
  if (state.nvr) state.nvr.detach();
  ui.recPill.classList.remove('rec', 'on');
  ui.recPill.innerHTML = '<i class="led"></i> dvr';
  ui.motionPill.classList.remove('hot');
  if (ui.soundPill) ui.soundPill.classList.remove('hot');
  if (ui.threatPill) {
    ui.threatPill.classList.remove('hot');
    ui.threatPill.innerHTML = '<i class="led"></i> threat';
  }
  if (ui.hudMotion) ui.hudMotion.textContent = '';
  stopEngines();
  stopStreams();
  ui.stageEmpty.classList.remove('hidden');
  ui.streamStatus.classList.remove('on');
  ui.streamStatus.innerHTML = '<i class="led"></i> stream';
  $('#btnStop').disabled = true;
  $('#btnSnapshot').disabled = true;
  if ($('#btnSnapSave')) $('#btnSnapSave').disabled = true;
  if ($('#btnRecClip')) {
    $('#btnRecClip').disabled = true;
    $('#btnRecClip').textContent = 'Record';
  }
  state.recordingManual = false;
  ui.hudSource.textContent = 'idle';
  ui.faceCount.textContent = '0 faces';
  applyNightVision();
  saveCapture({ running: false, mode: state.captureMode || loadCapture().mode });
  if (state.captureMode || loadCapture().mode) showResumeBar();
  if (opts.keepResume) showResumeBar();
  log('', 'Stopped');
  emit('stop');
}

async function ensureModels() {
  if (!state.modelsReady) await loadModels();
  if (!state.config) await loadConfig();
}

async function enrollFromForm(ev) {
  ev.preventDefault();
  const form = ev.target;
  const name = form.name.value.trim();
  const facebookUrl = form.facebookUrl.value.trim();
  const notes = form.notes.value.trim();
  const imageUrl = form.imageUrl.value.trim();
  if (!name) return toast('Name is required', 'err');
  if (!state.enrollFiles.length && !imageUrl) return toast('Add at least one photo or an image URL', 'err');
  let person = null;
  try {
    await ensureModels();
    person = await api('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, facebookUrl, notes })
    });

    if (imageUrl) {
      const imported = await api('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: person.id, imageUrl, facebookUrl, name })
      });
      person = imported.person;
    }

    if (state.enrollFiles.length) {
      const descriptors = [];
      const kept = [];
      for (const file of state.enrollFiles) {
        const desc = await describeImage(file);
        if (!desc) {
          toast('No face found in ' + file.name + ' — skipped', 'err');
          continue;
        }
        descriptors.push(desc.descriptor);
        kept.push(file);
      }
      if (!kept.length && !imageUrl) throw new Error('No usable faces in those photos');
      if (kept.length) {
        const body = new FormData();
        kept.forEach((f) => body.append('photos', f));
        body.append('descriptors', JSON.stringify(descriptors));
        const added = await fetch('/api/people/' + person.id + '/photos', { method: 'POST', body });
        const data = await added.json();
        if (!added.ok) throw new Error(data.error || 'Upload failed');
        person = data.person;
        if (data.reconcile && data.reconcile.merged && data.reconcile.merged.length) {
          toast('Merged ' + data.reconcile.merged.length + ' previous unknown capture(s) into ' + person.name);
        }
      }
    }

    await backfillDescriptors(person.id);

    form.reset();
    state.enrollFiles = [];
    ui.enrollThumbs.innerHTML = '';
    await loadPeople();
    await loadUnknowns();
    toast('Saved ' + name);
    log('k', 'Enrolled ' + name + ' with ' + (person.photos ? person.photos.length : 0) + ' photo(s)');
    emit('enroll', person);
    $$('.tab')
      .find((t) => t.dataset.tab === 'people')
      .click();
  } catch (err) {
    if (person && person.id) {
      const fresh = await api('/api/people/' + person.id).catch(() => person);
      if (!fresh.photos || !fresh.photos.length) {
        await api('/api/people/' + person.id, { method: 'DELETE' }).catch(() => {});
      }
    }
    toast(err.message, 'err');
    log('e', err.message);
  }
}

async function backfillDescriptors(personId) {
  const person = await api('/api/people/' + personId);
  for (const photo of person.photos || []) {
    if (photo.descriptor && photo.descriptor.length === 128) continue;
    try {
      const res = await fetch(photo.url);
      const blob = await res.blob();
      const desc = await describeImage(blob);
      if (!desc) continue;
      await api('/api/people/' + personId + '/descriptor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId: photo.id, descriptor: desc.descriptor })
      });
    } catch (err) {
      log('e', 'Descriptor backfill: ' + err.message);
    }
  }
  await loadPeople();
}

async function grabLiveFace() {
  const engine = state.engines.find((e) => e.tracks.length) || state.engines[0];
  const video = engine ? engine.video : $('#videoScreen').srcObject ? $('#videoScreen') : $('#videoCamera');
  if (!video || !video.videoWidth) return toast('Start a live feed first', 'err');
  try {
    await ensureModels();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    const desc = await describeImage(blob);
    if (!desc) return toast('No face in the current frame', 'err');
    const file = new File([blob], 'live-grab.jpg', { type: 'image/jpeg' });
    state.enrollFiles.push(file);
    previewEnroll();
    toast('Grabbed a face from the live feed');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function previewEnroll() {
  ui.enrollThumbs.innerHTML = '';
  for (const file of state.enrollFiles) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    ui.enrollThumbs.appendChild(img);
  }
}

async function identifyUnknown(id, name, personId) {
  const body = personId ? { personId } : { name };
  const result = await api('/api/unknowns/' + id + '/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  toast(
    'Named as ' + result.person.name + (result.mergedUnknowns > 1 ? ' · merged ' + result.mergedUnknowns + ' captures' : '')
  );
  await loadPeople();
  await loadUnknowns();
}

async function addPhotosToPerson(id, files) {
  await ensureModels();
  const descriptors = [];
  const kept = [];
  for (const file of files) {
    const d = await describeImage(file);
    if (!d) {
      toast('No face in ' + file.name, 'err');
      continue;
    }
    descriptors.push(d.descriptor);
    kept.push(file);
  }
  if (!kept.length) return;
  const body = new FormData();
  kept.forEach((f) => body.append('photos', f));
  body.append('descriptors', JSON.stringify(descriptors));
  const res = await fetch('/api/people/' + id + '/photos', { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  if (data.reconcile && data.reconcile.merged && data.reconcile.merged.length) {
    toast('Added photos and merged ' + data.reconcile.merged.length + ' unknown capture(s)');
  } else {
    toast('Added ' + kept.length + ' photo(s)');
  }
  await loadPeople();
  await loadUnknowns();
}

window.FaceID = {
  version: '1.0.0',
  startScreen: () => begin('screen'),
  startCamera: () => begin('camera'),
  startBoth: () => begin('both'),
  stop: stopAll,
  snapshot: async () => {
    const all = [];
    for (const e of state.engines) all.push(...e.snapshotUnknowns());
    for (const item of all) {
      await api('/api/unknowns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor: item.descriptor, image: item.image })
      });
    }
    await loadUnknowns();
    return all.length;
  },
  addPerson: async ({ name, facebookUrl, files, imageUrl, notes } = {}) => {
    const person = await api('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, facebookUrl, notes })
    });
    if (imageUrl) {
      await api('/api/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: person.id, imageUrl, name, facebookUrl })
      });
    }
    if (files && files.length) {
      const descriptors = [];
      const kept = [];
      for (const file of files) {
        const d = await describeImage(file);
        if (!d) continue;
        descriptors.push(d.descriptor);
        kept.push(file);
      }
      if (kept.length) {
        const body = new FormData();
        kept.forEach((f) => body.append('photos', f));
        body.append('descriptors', JSON.stringify(descriptors));
        await fetch('/api/people/' + person.id + '/photos', { method: 'POST', body });
      }
    }
    await backfillDescriptors(person.id);
    await loadPeople();
    await loadUnknowns();
    return api('/api/people/' + person.id);
  },
  listPeople: () => state.people.slice(),
  removePerson: async (id) => {
    await api('/api/people/' + id, { method: 'DELETE' });
    await loadPeople();
  },
  identifyUnknown: (unknownId, nameOrPersonId) => {
    const isId = state.people.some((p) => p.id === nameOrPersonId);
    return identifyUnknown(unknownId, isId ? '' : nameOrPersonId, isId ? nameOrPersonId : '');
  },
  setConfig: async (partial) => {
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    });
    fillSettings();
    for (const e of state.engines) e.setConfig(state.config);
    return state.config;
  },
  getConfig: () => ({ ...state.config }),
  match: (descriptor) => matchDescriptor(descriptor, state.people, state.config),
  events: () => state.events.slice(),
  on,
  off: (event, fn) => {
    const set = state.listeners.get(event);
    if (set) set.delete(fn);
  }
};

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function showHostGifPop(ev) {
  let pop = document.getElementById('gifPop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'gifPop';
    pop.className = 'gif-pop hidden';
    pop.setAttribute('role', 'alert');
    pop.innerHTML =
      '<img id="gifPopImg" alt="Alert preview" /><div class="gif-pop-meta"><strong id="gifPopTitle">Alert</strong><span id="gifPopBody"></span></div><button type="button" class="btn" id="gifPopClose">Close</button>';
    document.body.appendChild(pop);
    const close = () => pop.classList.add('hidden');
    pop.querySelector('#gifPopClose').onclick = close;
    let sx = 0;
    pop.addEventListener('touchstart', (e) => { sx = e.changedTouches[0].clientX; }, { passive: true });
    pop.addEventListener('touchend', (e) => {
      if (Math.abs(e.changedTouches[0].clientX - sx) > 80) close();
    }, { passive: true });
  }
  const img = pop.querySelector('#gifPopImg');
  const gif = ev && (ev.gifUrl || ev.stillUrl);
  if (img && gif) img.src = gif + (gif.includes('?') ? '&' : '?') + 'r=' + Date.now();
  const title = pop.querySelector('#gifPopTitle');
  const body = pop.querySelector('#gifPopBody');
  if (title) title.textContent = (ev && ev.title) || 'Alert';
  if (body) body.textContent = (ev && (ev.caption || ev.description)) || '';
  pop.classList.remove('hidden');
  clearTimeout(pop._hide);
  pop._hide = setTimeout(() => pop.classList.add('hidden'), 45000);
}

function notifyLocal(ev) {
  if (isMuted()) return;
  const title = (ev && ev.title) || 'Lookout';
  const body = (ev && (ev.caption || ev.description)) || 'Activity detected';
  const gif = ev && (ev.gifUrl || ev.stillUrl);
  const image = gif ? (gif.startsWith('http') ? gif : location.origin + gif) : undefined;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && navigator.serviceWorker) {
    navigator.serviceWorker.ready
      .then((reg) =>
        reg.showNotification(title, {
          body,
          icon: image || '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          image,
          tag: (ev && ev.id) || 'trill-alert',
          requireInteraction: true,
          renotify: true,
          data: { url: (ev && ev.watchUrl) || '/', gif: image },
          actions: [
            { action: 'view', title: 'View' },
            { action: 'mute', title: 'Mute' }
          ]
        })
      )
      .catch(() => {});
  }
}

async function setupPush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push is not available in this browser');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notification permission was not granted');
  const { publicKey } = await api('/api/push/key');
  if (!publicKey) throw new Error('Server has no VAPID key');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  await api('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub)
  });
  toast('Push alerts enabled');
}

function setupPwa() {
  setupInstall();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => log('e', 'SW: ' + err.message));
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'lookout-mute') {
        muteUntil((ev.data.minutes || 30) * 60 * 1000);
        toast('Alerts muted for ' + (ev.data.minutes || 30) + ' minutes');
      }
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    if (ui.btnInstall) ui.btnInstall.classList.remove('hidden');
  });
  if (ui.btnInstall) {
    ui.btnInstall.onclick = async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      ui.btnInstall.classList.add('hidden');
    };
  }
}

async function openShare() {
  try {
    const data = await api(shareQuery());
    state.share = data;
    const img = $('#shareQr');
    const primary = data.primary || location.origin + '/watch.html';
    if (img) {
      img.src = data.qrPng || qrPngSrc(primary);
      img.onerror = () => {
        if (data.qr) img.src = data.qr;
      };
      img.classList.remove('hidden');
    }
    const list = $('#shareUrls');
    if (list) {
      list.innerHTML = (data.urls || [])
        .map((u) => '<li><a href="' + escapeAttr(u) + '">' + escapeHtml(u) + '</a></li>')
        .join('');
    }
    const mail = $('#shareMail');
    if (mail) {
      mail.href =
        'mailto:?subject=' +
        encodeURIComponent('Trill Lookout AI Cam') +
        '&body=' +
        encodeURIComponent((data.primary || '') + '\n');
    }
    $('#shareModal').classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function wireUi() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      $$('.panel').forEach((p) => p.classList.remove('on'));
      $('#panel-' + tab.dataset.tab).classList.add('on');
    });
  });

  $('#btnShare').onclick = () => begin('screen');
  if ($('#btnBroadcast')) $('#btnBroadcast').onclick = () => begin('camera');
  if ($('#btnShareCam')) $('#btnShareCam').onclick = () => openShare();
  if ($('#btnSnapSave')) {
    $('#btnSnapSave').onclick = async () => {
      try {
        if (!state.nvr) throw new Error('Start a camera first');
        await state.nvr.snapshotNow();
        toast('Snapshot saved — open Videos');
        await loadNvr();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
  if ($('#btnRecClip')) {
    $('#btnRecClip').onclick = () => {
      try {
        if (!state.nvr) throw new Error('Start a camera first');
        if (!state.recordingManual) {
          state.nvr.startManualRecord();
          state.recordingManual = true;
          $('#btnRecClip').textContent = 'Stop rec';
          toast('Recording to DVR');
        } else {
          state.nvr.stopManualRecord();
          state.recordingManual = false;
          $('#btnRecClip').textContent = 'Record';
          toast('Clip saved');
          loadNvr();
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
  document.addEventListener('lookout-share', () => {
    if (typeof openShare === 'function') openShare();
  });
  if ($('#btnShareApp')) $('#btnShareApp').onclick = () => openShare();
  if ($('#shareClose')) $('#shareClose').onclick = () => $('#shareModal').classList.add('hidden');
  if ($('#shareModal')) {
    $('#shareModal').addEventListener('click', (e) => {
      if (e.target.id === 'shareModal') $('#shareModal').classList.add('hidden');
    });
  }
  if ($('#shareCopy')) {
    $('#shareCopy').onclick = async () => {
      try {
        const data = state.share || (await api(shareQuery()));
        await navigator.clipboard.writeText(data.primary);
        toast('Link copied');
      } catch (err) {
        toast(err.message || 'Could not copy', 'err');
      }
    };
  }
  if ($('#shareNative')) {
    $('#shareNative').onclick = async () => {
      try {
        const data = state.share || (await api(shareQuery()));
        if (navigator.share) {
          await navigator.share({ title: data.name || 'Trill Lookout AI Cam', url: data.primary, text: 'Open Trill Lookout AI Cam' });
        } else {
          await navigator.clipboard.writeText(data.primary);
          toast('Link copied');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        toast(err.message || 'Share failed', 'err');
      }
    };
  }
  if ($('#btnGoogle')) {
    $('#btnGoogle').onclick = async () => {
      try {
        const st = await api('/api/google/status');
        if (!st.configured) {
          toast('Paste Client ID and secret, click Save client, then Connect Google', 'err');
          const box = document.querySelector('.google-setup');
          if (box) box.open = true;
          $('#googleClientId') && $('#googleClientId').focus();
          return;
        }
      } catch {
        /* continue */
      }
      window.location.href = '/api/google/start';
    };
  }
  if ($('#btnGoogleDisconnect')) {
    $('#btnGoogleDisconnect').onclick = async () => {
      try {
        await api('/api/google/disconnect', { method: 'POST' });
        await loadNvr();
        toast('Google disconnected');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
  if ($('#btnSaveGoogleClient')) {
    $('#btnSaveGoogleClient').onclick = async () => {
      try {
        const data = await api('/api/google/client', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: ($('#googleClientId') && $('#googleClientId').value) || '',
            clientSecret: ($('#googleClientSecret') && $('#googleClientSecret').value) || ''
          })
        });
        if (data.configured) toast('Google client saved — now Connect Google');
        else toast('Paste both client ID and secret', 'err');
        await loadNvr();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }
  $('#btnCam').onclick = () => begin('camera');
  $('#btnBoth').onclick = () => begin('both');
  $('#btnStop').onclick = stopAll;
  $('#btnCameraTab').onclick = () => window.open('/camera.html', 'lookout-camera', 'noopener');
  $('#btnHelp').onclick = () => replayTutorial();
  $('#closeHelp').onclick = () => $('#helpModal').classList.add('hidden');
  $('#helpModal').addEventListener('click', (e) => {
    if (e.target.id === 'helpModal') $('#helpModal').classList.add('hidden');
  });

  $('#btnSnapshot').onclick = async () => {
    const n = await window.FaceID.snapshot();
    toast(n ? 'Captured ' + n + ' face crop(s)' : 'No unlabeled faces in view');
  };

  $('#peopleSearch').addEventListener('input', renderPeople);

  if ($('#animalForm')) {
    $('#animalForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = formPayload(e.target);
        await api('/api/animals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        e.target.reset();
        await loadAnimals();
        toast('Named ' + body.name);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }
  const animalClick = async (e) => {
    const btn = e.target.closest('[data-act=adel]');
    if (!btn) return;
    const card = btn.closest('[data-animal]');
    if (!card) return;
    const id = card.dataset.animal;
    await api('/api/animals/' + id, { method: 'DELETE' });
    await loadAnimals();
  };
  if ($('#animalList')) $('#animalList').addEventListener('click', animalClick);
  const hostKnownAnimals = document.getElementById('hostKnownAnimals');
  if (hostKnownAnimals) hostKnownAnimals.addEventListener('click', animalClick);

  const unkAnimalRoot = document.getElementById('hostUnknownAnimals');
  if (unkAnimalRoot) {
    unkAnimalRoot.addEventListener('click', async (e) => {
      const card = e.target.closest('[data-animal-unk]');
      if (!card) return;
      const id = card.dataset.animalUnk;
      const act = e.target.dataset.act;
      if (act === 'adrop') {
        await api('/api/unknown-animals/' + id, { method: 'DELETE' });
        await loadUnknownAnimals();
      }
      if (act === 'aid') {
        const name = (card.querySelector('[data-aname]') && card.querySelector('[data-aname]').value.trim()) || '';
        if (!name) return toast('Type a name first', 'err');
        try {
          await api('/api/unknown-animals/' + id + '/identify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          toast('Named ' + name);
          await loadAnimals();
          await loadUnknownAnimals();
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    });
  }

  $('#peopleList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.person-card').dataset.id;
    const person = state.people.find((p) => p.id === id);
    if (!person) return;
    if (btn.dataset.act === 'del') {
      if (!confirm('Remove ' + person.name + ' and their photos?')) return;
      await api('/api/people/' + id, { method: 'DELETE' });
      await loadPeople();
      return;
    }
    if (btn.dataset.act === 'add') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async () => {
        try {
          await addPhotosToPerson(id, [...input.files]);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      input.click();
    }
  });

  $('#unknownList').addEventListener('click', async (e) => {
    const card = e.target.closest('.unknown-card');
    if (!card) return;
    const id = card.dataset.id;
    const act = e.target.dataset.act;
    if (act === 'drop') {
      await api('/api/unknowns/' + id, { method: 'DELETE' });
      await loadUnknowns();
    }
    if (act === 'id') {
      const name = card.querySelector('[data-name]').value.trim();
      const personId = card.querySelector('[data-assign]').value;
      if (!name && !personId) return toast('Type a name or pick an existing person', 'err');
      try {
        await identifyUnknown(id, name, personId);
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  $('#btnReconcile').onclick = async () => {
    const result = await api('/api/reconcile', { method: 'POST' });
    await loadPeople();
    await loadUnknowns();
    const n = (result.merged || []).length;
    const s = (result.suggestions || []).length;
    toast((n ? 'Auto-merged ' + n + '. ' : 'No auto-merges. ') + (s ? s + ' suggestion(s) remain.' : ''));
  };

  $('#enrollForm').addEventListener('submit', enrollFromForm);
  $('#pickPhotos').onclick = () => $('#photoInput').click();
  $('#photoInput').addEventListener('change', (e) => {
    state.enrollFiles.push(...e.target.files);
    previewEnroll();
  });
  const drop = $('#dropZone');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('hot');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('hot');
    state.enrollFiles.push(...e.dataTransfer.files);
    previewEnroll();
  });
  $('#btnGrabFace').onclick = grabLiveFace;

  const btnNotify = $('#btnNotify');
  if (btnNotify) {
    btnNotify.onclick = async () => {
      try {
        await setupPush();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  $('#nvrForm').addEventListener('input', updateRangeLabels);
  $('#nvrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formPayload(e.target);
    if (body.alertCooldownSec != null) {
      body.alertCooldownMs = Number(body.alertCooldownSec) * 1000;
      delete body.alertCooldownSec;
    }
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    fillSettings();
    applyNightVision();
    toast('NVR settings saved');
  });

  $('#emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formPayload(e.target);
    state.email = await api('/api/nvr/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    fillEmail(state.email);
    toast('Email settings saved');
  });

  $('#btnTestEmail').onclick = async () => {
    try {
      await api('/api/nvr/email/test', { method: 'POST' });
      toast('Test email sent');
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#eventList').addEventListener('click', (e) => {
    const card = e.target.closest('.event-card');
    if (card) openEvent(card.dataset.id);
  });

  $('#segmentList').addEventListener('click', (e) => {
    const card = e.target.closest('.segment-card');
    if (card && card.dataset.url) window.open(card.dataset.url, '_blank');
  });

  $('#eventClose').onclick = () => $('#eventModal').classList.add('hidden');
  $('#eventModal').addEventListener('click', (e) => {
    if (e.target.id === 'eventModal') $('#eventModal').classList.add('hidden');
  });
  $('#eventDelete').onclick = async () => {
    if (!state.openEventId) return;
    await api('/api/nvr/events/' + state.openEventId, { method: 'DELETE' });
    $('#eventModal').classList.add('hidden');
    await loadNvr();
  };
  if ($('#eventShare')) {
    $('#eventShare').onclick = async () => {
      const ev = state.events.find((e) => e.id === state.openEventId);
      const url = (ev && (ev.gifUrl || ev.stillUrl || ev.clipUrl)) || location.origin + '/';
      const abs = url.startsWith('http') ? url : location.origin + url;
      try {
        if (navigator.share) {
          await navigator.share({ title: (ev && ev.title) || 'Trill Lookout AI Cam', url: abs, text: (ev && ev.description) || '' });
        } else {
          await navigator.clipboard.writeText(abs);
          toast('Alert link copied');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        toast(err.message || 'Share failed', 'err');
      }
    };
  }

  $('#eventEmail').onclick = async () => {
    if (!state.openEventId) return;
    try {
      await api('/api/nvr/events/' + state.openEventId + '/email', { method: 'POST' });
      toast('Alert emailed');
      await loadNvr();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  $('#settingsForm').addEventListener('input', updateRangeLabels);
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const el of e.target.elements) {
      if (!el.name) continue;
      body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    }
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    for (const eng of state.engines) eng.setConfig(state.config);
    ui.hudStrict.textContent = 'match ≤ ' + Number(state.config.matchThreshold).toFixed(2);
    toast('Settings saved');
  });
}

async function attachSavedCameras() {
  let list = [];
  try {
    list = await api('/api/cameras');
  } catch {
    return;
  }
  const feeds = $('#feeds');
  if (!feeds) return;
  for (const cam of list) {
    if (!cam.enabled || document.querySelector('[data-feed="' + cam.id + '"]')) continue;
    const tile = document.createElement('div');
    tile.className = 'feed cam-tile hidden';
    tile.dataset.feed = cam.id;
    tile.innerHTML =
      '<video id="video-' +
      cam.id +
      '" autoplay muted playsinline></video><canvas id="overlay-' +
      cam.id +
      '"></canvas><div class="feed-label">' +
      escapeHtml(cam.name) +
      '</div>';
    feeds.appendChild(tile);
    pumpIpCamera(cam, tile);
  }
}

function pumpIpCamera(cam, tile) {
  const video = tile.querySelector('video');
  const overlay = tile.querySelector('canvas');
  const draw = document.createElement('canvas');
  const ctx = draw.getContext('2d');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  let started = false;
  img.onload = async () => {
    try {
      draw.width = img.naturalWidth || 640;
      draw.height = img.naturalHeight || 360;
      ctx.drawImage(img, 0, 0);
      if (!started) {
        started = true;
        tile.classList.remove('hidden');
        $('#stageEmpty').classList.add('hidden');
        document.body.classList.add('live-on');
        video.srcObject = draw.captureStream(6);
        await video.play().catch(() => {});
        const eng = makeEngine(video, overlay);
        eng.start();
        state.engines.push(eng);
        if (!state.nvr) startNvr('camera');
        if (state.nvr) state.nvr.attach(video, video.srcObject, cam.id, eng);
        state.publishStops.push(publishLoop(video, cam.id, cam.name, 'ip', publishMeta(cam.id)));
        enlargeCam(cam.id);
      }
    } catch (err) {
      log('e', cam.name + ': ' + err.message);
    }
  };
  const tick = () => {
    if (cam.type === 'mjpeg') return;
    img.src = '/api/cameras/' + cam.id + '/stream?t=' + Date.now();
  };
  img.src = '/api/cameras/' + cam.id + '/stream';
  if (cam.type === 'mjpeg') {
    const loop = () => {
      if (img.naturalWidth) img.onload();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    setInterval(tick, getPerf().level === 'low' ? 1400 : 900);
  }
}

async function boot() {
  if (!faceapi) {
    toast('face-api.js failed to load', 'err');
    return;
  }
  mountNav('host', { keepHost: true });
  wireUi();
  bindIpCameras({ toast, api, onSaved: attachSavedCameras });
  setupPwa();
  startTutorial();
  rememberHostOrigin();
  window.addEventListener('resize', () => state.engines.forEach((e) => e.layout()));
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 's') begin('screen');
    if (e.key === 'c') begin('camera');
    if (e.key === 'b') begin('both');
    if (e.key === 'Escape') stopAll();
  });
  try {
    await loadConfig();
    await loadPeople();
    await loadAnimals();
    await loadUnknowns();
    await loadUnknownAnimals();
    await loadNvr();
    const net = await api('/api/network');
    const lines = ['http://localhost:' + net.httpPort, 'https://localhost:' + net.httpsPort];
    for (const ip of net.addresses || []) {
      lines.push('https://' + ip + ':' + net.httpsPort);
    }
    ui.netInfo.textContent = 'Reachable at: ' + lines.join('  ·  ');
    if ($('#googleRedirect')) $('#googleRedirect').textContent = absUrl('/api/google/callback');
    await attachSavedCameras();
  } catch (err) {
    log('e', err.message);
  }
  try {
    await loadModels();
  } catch (err) {
    ui.modelStatus.classList.add('warn');
    toast('Could not load models: ' + err.message, 'err');
    log('e', err.message);
  }
  if (!localStorage.getItem('lookout_onboarded')) {
    localStorage.setItem('lookout_onboarded', '1');
  }
  const cap = loadCapture();
  if (cap.running && cap.mode === 'camera') {
    begin('camera').catch(() => showResumeBar());
  } else if (cap.mode) {
    showResumeBar();
  }
}

boot();
