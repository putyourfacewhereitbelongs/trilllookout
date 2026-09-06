'use strict';

const fs = require('fs');
const path = require('path');
const mailer = require('./mailer');

function createNvr({ root, uid, now, getConfig, onAlert, google }) {
  const NVR_DIR = path.join(root, 'data', 'nvr');
  const VIDEO_DIR = path.join(NVR_DIR, 'video');
  const ALERT_DIR = path.join(NVR_DIR, 'alerts');
  const SNAP_DIR = path.join(NVR_DIR, 'snaps');
  const EVENTS_PATH = path.join(NVR_DIR, 'events.json');
  const SEGMENTS_PATH = path.join(NVR_DIR, 'segments.json');
  const EMAIL_PATH = path.join(NVR_DIR, 'email.json');

  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  fs.mkdirSync(ALERT_DIR, { recursive: true });
  fs.mkdirSync(SNAP_DIR, { recursive: true });

  let events = loadJson(EVENTS_PATH, []);
  let segments = loadJson(SEGMENTS_PATH, []);
  let email = loadJson(EMAIL_PATH, {
    enabled: false,
    preset: 'gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '',
    to: ''
  });
  let lastEmailAt = 0;

  function saveEvents() {
    atomic(EVENTS_PATH, events);
  }
  function saveSegments() {
    atomic(SEGMENTS_PATH, segments);
  }
  function saveEmail() {
    atomic(EMAIL_PATH, email);
  }

  function publicEvent(ev) {
    return {
      id: ev.id,
      createdAt: ev.createdAt,
      source: ev.source,
      title: ev.title,
      description: ev.description,
      people: ev.people || [],
      animals: ev.animals || [],
      objects: ev.objects || [],
      caption: ev.caption || '',
      sound: Boolean(ev.sound),
      threats: ev.threats || [],
      threatKind: threatKinds(ev.threats),
      watchUrl: ev.watchUrl || '',
      motionScore: ev.motionScore,
      motionLabel: ev.motionLabel,
      lighting: ev.lighting,
      where: ev.where || [],
      emailStatus: ev.emailStatus || 'skipped',
      emailError: ev.emailError || '',
      gifUrl: ev.gif ? '/nvr/alerts/' + ev.id + '/clip.gif' : null,
      stillUrl: ev.still ? '/nvr/alerts/' + ev.id + '/still.jpg' : null,
      clipUrl: ev.clip ? '/nvr/alerts/' + ev.id + '/clip.webm' : null
    };
  }

  function publicSegment(seg) {
    return {
      id: seg.id,
      source: seg.source,
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
      bytes: seg.bytes,
      kind: seg.kind || (/\.jpe?g$/i.test(seg.file || '') ? 'snap' : 'video'),
      url: '/nvr/' + seg.file.replace(/\\/g, '/')
    };
  }

  function storeSegment(file, meta) {
    const started = meta.startedAt || now();
    const day = started.slice(0, 10);
    const id = uid();
    const ext = extFrom(file.mimetype, file.originalname, '.webm');
    const rel = path.join('video', day, (meta.source || 'feed') + '-' + stamp(started) + '-' + id.slice(0, 8) + ext);
    const abs = path.join(NVR_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    const seg = {
      id,
      source: meta.source || 'feed',
      startedAt: started,
      endedAt: meta.endedAt || now(),
      bytes: file.buffer.length,
      file: rel.replace(/\\/g, '/')
    };
    segments.push(seg);
    if (segments.length > 20000) segments = segments.slice(-16000);
    saveSegments();
    return publicSegment(seg);
  }

  function storeSnap(file, meta) {
    const started = (meta && meta.createdAt) || now();
    const day = started.slice(0, 10);
    const id = uid();
    const ext = extFrom(file.mimetype, file.originalname, '.jpg');
    const rel = path.join('snaps', day, (meta.source || 'feed') + '-' + stamp(started) + '-' + id.slice(0, 8) + ext);
    const abs = path.join(NVR_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    const rec = {
      id,
      source: (meta && meta.source) || 'feed',
      startedAt: started,
      endedAt: started,
      bytes: file.buffer.length,
      file: rel.replace(/\\/g, '/'),
      kind: 'snap'
    };
    segments.push(rec);
    saveSegments();
    return publicSegment(rec);
  }

  async function storeEvent(files, meta) {
    const id = uid();
    const dir = path.join(ALERT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      id,
      createdAt: now(),
      source: meta.source || 'feed',
      title: String(meta.title || 'Alert').slice(0, 160),
      description: String(meta.description || '').slice(0, 2500),
      people: Array.isArray(meta.people) ? meta.people.map((p) => String(p).slice(0, 80)).slice(0, 12) : [],
      animals: Array.isArray(meta.animals) ? meta.animals.map((p) => String(p).slice(0, 40)).slice(0, 12) : [],
      objects: Array.isArray(meta.objects) ? meta.objects.map((p) => String(p).slice(0, 40)).slice(0, 16) : [],
      caption: String(meta.caption || '').slice(0, 400),
      watchUrl: String(meta.watchUrl || '').slice(0, 400),
      sound: Boolean(meta.sound),
      threats: Array.isArray(meta.threats)
        ? meta.threats.slice(0, 8).map((t) =>
            typeof t === 'string'
              ? t
              : { type: t.type, severity: t.severity, description: t.description, confidence: t.confidence }
          )
        : [],
      motionScore: Number(meta.motionScore || 0),
      motionLabel: String(meta.motionLabel || ''),
      lighting: String(meta.lighting || ''),
      where: Array.isArray(meta.where) ? meta.where.slice(0, 8) : [],
      emailStatus: 'skipped',
      emailError: '',
      gif: false,
      still: false,
      clip: false
    };
    if (files.gif) {
      fs.writeFileSync(path.join(dir, 'clip.gif'), files.gif.buffer);
      rec.gif = true;
    }
    if (files.still) {
      fs.writeFileSync(path.join(dir, 'still.jpg'), files.still.buffer);
      rec.still = true;
    }
    if (files.clip) {
      fs.writeFileSync(path.join(dir, 'clip.webm'), files.clip.buffer);
      rec.clip = true;
    }
    events.unshift(rec);
    if (events.length > 800) {
      const extra = events.splice(800);
      for (const e of extra) rmrf(path.join(ALERT_DIR, e.id));
    }
    saveEvents();
    await maybeEmail(rec);
    saveEvents();
    const pub = publicEvent(rec);
    if (typeof onAlert === 'function') {
      try {
        await onAlert(pub);
      } catch {
        /* push is best-effort */
      }
    }
    return pub;
  }

  async function maybeEmail(rec) {
    if (!email.enabled) {
      rec.emailStatus = 'skipped';
      return;
    }
    const cfg = getConfig() || {};
    const cooldown = Number(cfg.alertCooldownMs || 120000);
    if (Date.now() - lastEmailAt < cooldown) {
      rec.emailStatus = 'throttled';
      return;
    }
    try {
      await mailer.sendAlert(
        email,
        rec,
        {
          gif: rec.gif ? path.join(ALERT_DIR, rec.id, 'clip.gif') : null,
          still: rec.still ? path.join(ALERT_DIR, rec.id, 'still.jpg') : null
        },
        google
      );
      rec.emailStatus = 'sent';
      rec.emailError = '';
      lastEmailAt = Date.now();
    } catch (err) {
      rec.emailStatus = 'error';
      rec.emailError = (err && err.message) || String(err);
    }
  }

  async function resend(id) {
    const rec = events.find((e) => e.id === id);
    if (!rec) throw new Error('Event not found');
    await mailer.sendAlert(
      email,
      rec,
      {
        gif: rec.gif ? path.join(ALERT_DIR, rec.id, 'clip.gif') : null,
        still: rec.still ? path.join(ALERT_DIR, rec.id, 'still.jpg') : null
      },
      google
    );
    rec.emailStatus = 'sent';
    rec.emailError = '';
    lastEmailAt = Date.now();
    saveEvents();
    return publicEvent(rec);
  }

  function stats() {
    const bytes = segments.reduce((n, s) => n + (s.bytes || 0), 0) + dirSize(ALERT_DIR);
    return {
      bytes,
      segments: segments.length,
      events: events.length,
      oldest: segments[0] ? segments[0].startedAt : null,
      newest: segments.length ? segments[segments.length - 1].endedAt : null,
      email: getEmail()
    };
  }

  function prune() {
    const days = Number((getConfig() || {}).nvrRetentionDays || 7);
    const cutoff = Date.now() - Math.max(1, days) * 86400000;
    const keepSeg = [];
    for (const seg of segments) {
      if (new Date(seg.startedAt).getTime() < cutoff) {
        rmrf(path.join(NVR_DIR, seg.file));
      } else keepSeg.push(seg);
    }
    segments = keepSeg;
    saveSegments();
    const keepEv = [];
    for (const ev of events) {
      if (new Date(ev.createdAt).getTime() < cutoff) rmrf(path.join(ALERT_DIR, ev.id));
      else keepEv.push(ev);
    }
    events = keepEv;
    saveEvents();
    pruneEmpty(VIDEO_DIR);
  }

  function getEmail() {
    const pub = mailer.publicSettings(email);
    if (google && google.publicStatus) {
      const g = google.publicStatus();
      pub.googleConnected = g.connected;
      pub.googleEmail = g.email || pub.googleEmail;
      pub.googleConfigured = g.configured;
    }
    return pub;
  }

  function applyGoogleAccount(info) {
    const addr = String((info && info.email) || '').trim();
    if (!addr) return getEmail();
    email.enabled = true;
    email.preset = 'gmail';
    email.host = 'smtp.gmail.com';
    email.port = 587;
    email.secure = false;
    email.user = addr;
    email.from = addr;
    if (!email.to) email.to = addr;
    email.googleConnected = true;
    email.googleEmail = addr;
    saveEmail();
    return getEmail();
  }

  function setEmail(body) {
    const next = mailer.applyPreset({ ...email, ...body });
    email.enabled = Boolean(next.enabled);
    email.preset = String(next.preset || 'custom');
    email.host = String(next.host || '').trim();
    email.port = Number(next.port || 587);
    email.secure = Boolean(next.secure);
    email.user = String(next.user || '').trim();
    if (typeof next.pass === 'string' && next.pass.length) email.pass = next.pass;
    email.from = String(next.from || '').trim();
    email.to = String(next.to || '').trim();
    saveEmail();
    return getEmail();
  }

  async function testEmail() {
    if (!email.to && google && google.email) {
      const addr = google.email();
      if (addr) email.to = addr;
    }
    if (!email.enabled && google && google.publicStatus && google.publicStatus().connected) {
      email.enabled = true;
      saveEmail();
    }
    await mailer.sendTest(email, google);
    return { ok: true, to: email.to };
  }

  function listEvents(limit) {
    return events.slice(0, Math.min(200, Number(limit) || 60)).map(publicEvent);
  }

  function listSegments(query) {
    const source = query && query.source;
    const day = query && query.day;
    const limit = Math.min(2000, Math.max(1, Number((query && query.limit) || 400)));
    let list = segments;
    if (source) list = list.filter((s) => s.source === source);
    if (day) list = list.filter((s) => String(s.startedAt).slice(0, 10) === day);
    return list.slice(-limit).reverse().map(publicSegment);
  }

  function deleteSegment(id) {
    const idx = segments.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    rmrf(path.join(NVR_DIR, segments[idx].file));
    segments.splice(idx, 1);
    saveSegments();
    return true;
  }

  function deleteEvent(id) {
    const idx = events.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    rmrf(path.join(ALERT_DIR, events[idx].id));
    events.splice(idx, 1);
    saveEvents();
    return true;
  }

  prune();
  setInterval(prune, 30 * 60 * 1000).unref();

  return {
    NVR_DIR,
    storeSegment,
    storeSnap,
    storeEvent,
    listEvents,
    listSegments,
    deleteEvent,
    deleteSegment,
    resend,
    stats,
    getEmail,
    setEmail,
    testEmail,
    prune,
    publicEvent,
    applyGoogleAccount
  };
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (p) => {
    for (const name of fs.readdirSync(p)) {
      const f = path.join(p, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

function pruneEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isDirectory()) {
        pruneEmpty(f);
        if (!fs.readdirSync(f).length) fs.rmdirSync(f);
      }
    } catch {
      /* ignore */
    }
  }
}

function extFrom(mime, original, fallback) {
  if (mime && /mp4/.test(mime)) return '.mp4';
  if (mime && /webm/.test(mime)) return '.webm';
  if (original && path.extname(original)) return path.extname(original);
  return fallback;
}

function stamp(iso) {
  try {
    return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  } catch {
    return Date.now().toString();
  }
}

function threatKinds(threats) {
  if (!threats || !threats.length) return [];
  const out = [];
  for (const t of threats) {
    const k = mailer.threatKind(t);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

module.exports = { createNvr };
