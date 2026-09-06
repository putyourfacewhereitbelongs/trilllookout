import { mountNav } from './nav.js';
import { mjpegSrc, jpegSrc } from './live-client.js';
import { playAlertDing } from './ding.js';
import { rememberHostOrigin, saveWatchCams, isMuted, muteUntil, setRole } from './persist.js';
import { setupInstall, requestKeepAlive, showPermissionCoach, subscribePush } from './install.js';
import { getPerf } from './perf.js';

mountNav('live');
setupInstall();
rememberHostOrigin();
setRole('viewer');

const wall = document.getElementById('wall');
const dock = document.getElementById('alertDock');
const params = new URLSearchParams(location.search);
let focusId = params.get('cam') || '';
let lastAlertId = '';
let lastList = [];
let lastKey = '';
let book = [];
let pulseTimer = 0;
let knownUnk = null;
const captions = new Map();

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function homePath() {
  return location.pathname.endsWith('watch.html') ? '/watch.html' : '/';
}

function clockTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function whenLabel(iso) {
  if (!iso) return 'Not seen yet';
  const t = clockTime(iso);
  const ago = timeAgo(iso);
  return t ? t + ' · ' + ago : ago;
}

function camBook(id) {
  return book.find((c) => c.id === id) || null;
}

function canPtz(cam) {
  if (!cam) return false;
  const rec = camBook(cam.id);
  if (rec && rec.ptz === false) return false;
  if (rec && rec.ptz) return true;
  const brand = String((rec && rec.brand) || cam.brand || cam.kind || '').toLowerCase();
  return /wyze|hik|dahua|amcrest|reolink|foscam|ptz|pan/.test(brand);
}

function applyFocus() {
  const focusing = Boolean(focusId);
  document.body.classList.toggle('watch-focus', focusing);
  wall.classList.toggle('solo', focusing);
  const allBtn = document.getElementById('btnAllCams');
  if (allBtn) allBtn.classList.toggle('hidden', !focusing);
  const pad = document.getElementById('ptzPad');
  const cam = lastList.find((c) => c.id === focusId);
  if (pad) pad.classList.toggle('hidden', !(focusing && canPtz(cam)));
}

function setTileCaption(id, text) {
  const tile = wall.querySelector('[data-id="' + id + '"]');
  if (!tile) return;
  let cap = tile.querySelector('.cam-caption');
  if (!text) {
    if (cap) cap.textContent = '';
    return;
  }
  if (!cap) {
    cap = document.createElement('p');
    cap.className = 'cam-caption';
    tile.appendChild(cap);
  }
  cap.textContent = text;
}

function paintLiveScene() {
  const el = document.getElementById('liveScene');
  if (!el) return;
  const parts = lastList
    .filter((c) => c.alive)
    .map((c) => {
      const text = captions.get(c.id) || c.caption || '';
      if (!text) return '';
      return (c.name || 'Camera') + ': ' + text;
    })
    .filter(Boolean);
  if (parts.length) {
    el.textContent = parts.join('  ·  ');
    return;
  }
  const alive = lastList.filter((c) => c.alive);
  el.textContent = alive.length
    ? 'Watching ' + alive.length + ' live camera' + (alive.length === 1 ? '' : 's') + '. Scene analysis appears when the host is running.'
    : 'Start a camera on the Host page to see what is happening.';
}

function buildTiles(list) {
  const alive = list.filter((c) => c.alive);
  const show = list.length ? list : [];
  document.getElementById('watchSub').textContent = alive.length
    ? alive.length + ' camera' + (alive.length === 1 ? '' : 's') + ' live — tap one to fill the screen'
    : 'No live cameras yet. On the Host page, start a screen or device camera.';
  if (!show.length) {
    wall.innerHTML =
      '<div class="watch-empty"><div class="empty-card reveal-card"><img class="empty-logo" src="/icons/icon-192.png" alt=""><h1>No live cameras yet</h1><p>This is Home — live cameras, faces, and DVR clips show here. Open <strong>Host</strong> in the menu to start a camera on this device.</p><div class="empty-actions"><a class="btn primary" href="/host.html">Open Host</a><a class="btn" href="/enroll.html">Enroll a face</a></div></div></div>';
    paintLiveScene();
    return;
  }
  wall.innerHTML = show
    .map((c) => {
      const dead = c.alive ? '' : ' dead';
      const hero = focusId === c.id ? ' hero' : '';
      const cap = captions.get(c.id) || c.caption || '';
      const faces = (c.faces || [])
        .map((f) => f.name)
        .filter(Boolean)
        .join(', ');
      return `<article class="cam-tile${hero}${dead}" data-id="${c.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(
        c.name || 'camera'
      )} fullscreen">
        <div class="cam-frame">
          <div class="bezel"><span><i class="recdot"></i>${escapeHtml(c.name || 'Camera')}</span><span class="sig">${
            c.alive ? 'LIVE' : 'NO SIGNAL'
          }</span></div>
          <img class="live" alt="${escapeHtml(c.name || 'Camera')}" src="${c.alive ? jpegSrc(c.id) : ''}" />
        </div>
        <p class="cam-caption">${escapeHtml(cap || faces)}</p>
      </article>`;
    })
    .join('');
  wall.querySelectorAll('.cam-tile').forEach((tile) => {
    const open = () => {
      const id = tile.dataset.id;
      if (!id) return;
      focusId = id;
      try {
        history.replaceState(null, '', homePath() + '?cam=' + encodeURIComponent(id));
      } catch {
        /* ignore */
      }
      wall.querySelectorAll('.cam-tile').forEach((t) => t.classList.toggle('hero', t.dataset.id === id));
      applyFocus();
      const img = tile.querySelector('img.live');
      if (img) img.src = mjpegSrc(id);
    };
    tile.onclick = open;
    tile.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    };
  });
  paintLiveScene();
}

function renderCams(list) {
  lastList = Array.isArray(list) ? list : [];
  lastList.forEach((c) => {
    if (c.caption) captions.set(c.id, c.caption);
  });
  saveWatchCams(lastList.map((c) => c.id));
  const key = lastList.map((c) => c.id).join('|');
  if (key !== lastKey) {
    lastKey = key;
    buildTiles(lastList);
  } else {
    lastList.forEach((c) => {
      const tile = wall.querySelector('[data-id="' + c.id + '"]');
      if (!tile) return;
      tile.classList.toggle('dead', !c.alive);
      const sig = tile.querySelector('.sig');
      if (sig) sig.textContent = c.alive ? 'LIVE' : 'NO SIGNAL';
      setTileCaption(c.id, captions.get(c.id) || c.caption || '');
    });
    const sub = document.getElementById('watchSub');
    const alive = lastList.filter((c) => c.alive);
    if (sub && lastList.length) {
      sub.textContent = alive.length
        ? alive.length + ' camera' + (alive.length === 1 ? '' : 's') + ' live — tap one to fill the screen'
        : 'No live cameras yet. On the Host page, start a screen or device camera.';
    }
    paintLiveScene();
  }
  applyFocus();
}

function pulseThumbs() {
  lastList.forEach((c) => {
    if (!c.alive) return;
    const tile = wall.querySelector('[data-id="' + c.id + '"]');
    if (!tile) return;
    const img = tile.querySelector('img.live');
    if (!img) return;
    if (focusId === c.id) {
      if (!/mjpeg/.test(img.src)) img.src = mjpegSrc(c.id);
      return;
    }
    const n = new Image();
    n.onload = () => {
      img.src = n.src;
    };
    n.src = jpegSrc(c.id);
  });
}

function renderSightings(rows, people) {
  const el = document.getElementById('sightingList');
  if (!el) return;
  const liveFaces = [];
  lastList.forEach((c) => {
    (c.faces || []).forEach((f) => {
      if (!f.name) return;
      liveFaces.push({
        name: f.name,
        personId: f.personId,
        kind: f.kind,
        status: f.status,
        source: c.name || c.id,
        at: new Date().toISOString(),
        live: true
      });
    });
  });
  const merged = [...liveFaces, ...(rows || [])];
  const seen = new Set();
  const unique = [];
  for (const r of merged) {
    const key = (r.personId || r.name) + '@' + (r.source || '');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
    if (unique.length >= 12) break;
  }
  if (!unique.length) {
    el.innerHTML = '<div class="empty-inline">When a known or unknown face is recognized, the name and time show here.</div>';
    return;
  }
  el.innerHTML = unique
    .map((r) => {
      const person = (people || []).find((p) => p.id === r.personId);
      const thumb = person && person.photos && person.photos[0] && person.photos[0].url;
      const status = r.status === 'known' ? 'Recognized' : r.status === 'unknown' ? 'Unknown' : r.status || 'Seen';
      return `<article class="person-card known-home">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : `<img alt="">`}
        <div class="meta">
          <h3>${escapeHtml(r.name || 'Unknown')}</h3>
          <span class="muted small">${escapeHtml(status)} · ${escapeHtml(whenLabel(r.at))} · ${escapeHtml(
            r.source || 'camera'
          )}</span>
        </div>
      </article>`;
    })
    .join('');
}

function showUnknownPop(u) {
  const pop = document.getElementById('gifPop');
  const img = document.getElementById('gifPopImg');
  if (!pop || !img) return;
  const photos = u.photos || [];
  const src = (photos[0] && photos[0].url) || (u.images && u.images[0]) || '';
  if (src) img.src = src;
  document.getElementById('gifPopTitle').textContent = 'Unknown person — add a name';
  document.getElementById('gifPopBody').textContent =
    (u.photoCount || (u.images && u.images.length) || 1) +
    ' photo' +
    ((u.photoCount || 1) === 1 ? '' : 's') +
    ' captured ' +
    whenLabel(u.lastSeen || u.firstSeen) +
    '. Tap the photo on Home to add a name.';
  pop.classList.remove('hidden');
  pop.classList.add('show');
  clearTimeout(pop._hide);
  pop._hide = setTimeout(() => pop.classList.add('hidden'), 45000);
}

function renderHomeFaces(people, unknowns) {
  const peopleEl = document.getElementById('peopleList');
  const unknownEl = document.getElementById('unknownList');
  if (peopleEl) {
    if (!people.length) {
      peopleEl.innerHTML = '<div class="empty-inline">No known faces yet. Use Enroll face to add a name and photos.</div>';
    } else {
      peopleEl.innerHTML = people
        .map((p) => {
          const photos = p.photos || [];
          const gallery = photos
            .map((ph) => `<img src="${escapeHtml(ph.url || '')}" alt="${escapeHtml(p.name || '')}">`)
            .join('');
          const seen = p.lastSeenAt ? 'Last seen ' + whenLabel(p.lastSeenAt) : 'Not seen on camera yet';
          const src = p.lastSeenSource ? ' · ' + p.lastSeenSource : '';
          return `<article class="person-card known-home">
            <div class="gallery">${gallery || '<img alt="">'}</div>
            <div class="meta"><h3>${escapeHtml(p.name || 'Person')}</h3>
            <span class="muted small">${escapeHtml(seen + src)}</span></div>
          </article>`;
        })
        .join('');
    }
  }
  if (unknownEl) {
    if (!unknowns.length) {
      unknownEl.innerHTML =
        '<div class="empty-inline">No unknown faces yet. When someone new appears on a live camera, Lookout takes several face photos here. Tap a photo to add a name.</div>';
    } else {
      unknownEl.innerHTML = unknowns
        .map((u) => {
          const photos = u.photos && u.photos.length ? u.photos : (u.images || []).map((url) => ({ url, createdAt: u.lastSeen }));
          const gallery = photos
            .map(
              (ph) =>
                `<button type="button" class="unk-shot" data-kind="person" data-id="${escapeHtml(u.id)}" data-photo="${escapeHtml(
                  ph.url || ph
                )}" aria-label="Name this person">
                  <img src="${escapeHtml(ph.url || ph)}" alt="unknown face">
                  <figcaption>${escapeHtml(whenLabel(ph.createdAt || u.lastSeen || u.firstSeen))}</figcaption>
                </button>`
            )
            .join('');
          const n = u.photoCount || photos.length;
          return `<article class="unknown-card" data-id="${u.id}" data-kind="person">
            <div class="gallery">${gallery || '<img alt="">'}</div>
            <div class="meta">
              <h3>Unknown · ${n} photo${n === 1 ? '' : 's'} · seen ${u.seenCount || 1}×</h3>
              <span class="muted small">Tap a photo to add a name · First ${escapeHtml(whenLabel(u.firstSeen))} · Last ${escapeHtml(
                whenLabel(u.lastSeen)
              )}</span>
            </div>
          </article>`;
        })
        .join('');
      bindNameShots(unknownEl);
    }
  }
  if (knownUnk) {
    for (const u of unknowns) {
      if (!knownUnk.has(u.id)) {
        showUnknownPop(u);
        if (!isMuted()) playAlertDing();
        break;
      }
    }
  }
  knownUnk = new Set(unknowns.map((u) => u.id));
}

function renderHomeAnimals(animals, unknowns) {
  const knownEl = document.getElementById('animalList');
  const unknownEl = document.getElementById('unknownAnimalList');
  if (knownEl) {
    if (!animals.length) {
      knownEl.innerHTML = '<div class="empty-inline">No named animals yet. Tap an unknown animal photo to add a name.</div>';
    } else {
      knownEl.innerHTML = animals
        .map((a) => {
          const photos = a.photos || [];
          const gallery = photos
            .map((ph) => `<img src="${escapeHtml(ph.url || '')}" alt="${escapeHtml(a.name || '')}">`)
            .join('');
          return `<article class="person-card known-home">
            <div class="gallery">${gallery || '<img alt="">'}</div>
            <div class="meta"><h3>${escapeHtml(a.name || 'Animal')}</h3>
            <span class="muted small">${escapeHtml(a.species || 'animal')}</span></div>
          </article>`;
        })
        .join('');
    }
  }
  if (unknownEl) {
    if (!unknowns.length) {
      unknownEl.innerHTML =
        '<div class="empty-inline">No unknown animals yet. When a cat, dog, or other animal appears, Lookout takes photos here. Tap a photo to add a name.</div>';
    } else {
      unknownEl.innerHTML = unknowns
        .map((u) => {
          const photos = u.photos && u.photos.length ? u.photos : (u.images || []).map((url) => ({ url, createdAt: u.lastSeen }));
          const gallery = photos
            .map(
              (ph) =>
                `<button type="button" class="unk-shot" data-kind="animal" data-id="${escapeHtml(u.id)}" data-photo="${escapeHtml(
                  ph.url || ph
                )}" aria-label="Name this ${escapeHtml(u.species || 'animal')}">
                  <img src="${escapeHtml(ph.url || ph)}" alt="unknown ${escapeHtml(u.species || 'animal')}">
                  <figcaption>${escapeHtml(whenLabel(ph.createdAt || u.lastSeen || u.firstSeen))}</figcaption>
                </button>`
            )
            .join('');
          const n = u.photoCount || photos.length;
          const kind = u.species || 'animal';
          return `<article class="unknown-card" data-id="${u.id}" data-kind="animal">
            <div class="gallery">${gallery || '<img alt="">'}</div>
            <div class="meta">
              <h3>Unknown ${escapeHtml(kind)} · ${n} photo${n === 1 ? '' : 's'} · seen ${u.seenCount || 1}×</h3>
              <span class="muted small">Tap a photo to add a name · Last ${escapeHtml(whenLabel(u.lastSeen))}</span>
            </div>
          </article>`;
        })
        .join('');
      bindNameShots(unknownEl);
    }
  }
}

let nameTarget = null;

function bindNameShots(root) {
  if (!root) return;
  root.querySelectorAll('.unk-shot').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNameModal({
        kind: btn.dataset.kind || 'person',
        id: btn.dataset.id,
        photo: btn.dataset.photo,
        species: (btn.closest('.unknown-card') && btn.closest('.unknown-card').querySelector('h3')
          ? btn.closest('.unknown-card').querySelector('h3').textContent
          : '') || ''
      });
    };
  });
}

function openNameModal({ kind, id, photo }) {
  nameTarget = { kind, id };
  const modal = document.getElementById('nameModal');
  const img = document.getElementById('nameModalImg');
  const title = document.getElementById('nameModalTitle');
  const input = document.getElementById('nameModalInput');
  if (!modal || !input) return;
  if (img) {
    img.src = photo || '';
    img.classList.toggle('hidden', !photo);
  }
  if (title) title.textContent = kind === 'animal' ? 'Name this animal' : 'Name this person';
  input.value = '';
  input.placeholder = kind === 'animal' ? 'For example, Luna' : 'For example, Maya';
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeNameModal() {
  const modal = document.getElementById('nameModal');
  if (modal) modal.classList.add('hidden');
  nameTarget = null;
}

async function saveNameModal() {
  const input = document.getElementById('nameModalInput');
  const name = (input && input.value.trim()) || '';
  if (!name) return toast('Type a name first', 'err');
  if (!nameTarget || !nameTarget.id) return;
  const kind = nameTarget.kind;
  const id = nameTarget.id;
  try {
    const path = kind === 'animal' ? '/api/unknown-animals/' + id + '/identify' : '/api/unknowns/' + id + '/identify';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not name');
    const saved = (data.person && data.person.name) || (data.animal && data.animal.name) || name;
    toast('Named ' + saved);
    closeNameModal();
    refreshFaces();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function refreshFaces() {
  try {
    const [peopleRes, unkRes, sightRes, animalRes, unkAnimalRes] = await Promise.all([
      fetch('/api/people'),
      fetch('/api/unknowns'),
      fetch('/api/sightings?limit=24'),
      fetch('/api/animals'),
      fetch('/api/unknown-animals')
    ]);
    const people = peopleRes.ok ? await peopleRes.json() : [];
    const unknowns = unkRes.ok ? await unkRes.json() : [];
    const sightings = sightRes.ok ? await sightRes.json() : [];
    const animals = animalRes.ok ? await animalRes.json() : [];
    const unknownAnimals = unkAnimalRes.ok ? await unkAnimalRes.json() : [];
    const ppl = Array.isArray(people) ? people : [];
    renderHomeFaces(ppl, Array.isArray(unknowns) ? unknowns : []);
    renderHomeAnimals(Array.isArray(animals) ? animals : [], Array.isArray(unknownAnimals) ? unknownAnimals : []);
    renderSightings(Array.isArray(sightings) ? sightings : [], ppl);
  } catch {
    /* ignore */
  }
}

async function refreshList() {
  try {
    const res = await fetch('/api/live');
    const list = await res.json();
    renderCams(Array.isArray(list) ? list : []);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function osNotifyGif(ev) {
  if (isMuted()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const gif = ev && (ev.gifUrl || ev.stillUrl);
  const image = gif ? (gif.startsWith('http') ? gif : location.origin + gif) : undefined;
  const title = (ev && ev.title) || 'Alert';
  const body = (ev && (ev.caption || ev.description)) || 'Activity detected';
  if (navigator.serviceWorker) {
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

function showGifPop(ev) {
  const pop = document.getElementById('gifPop');
  const img = document.getElementById('gifPopImg');
  if (!pop || !img) return;
  const gif = ev.gifUrl || ev.stillUrl || '';
  if (gif) img.src = gif + (gif.includes('?') ? '&' : '?') + 'r=' + Date.now();
  document.getElementById('gifPopTitle').textContent = ev.title || 'Alert';
  document.getElementById('gifPopBody').textContent = ev.caption || ev.description || '';
  pop.classList.remove('hidden');
  pop.classList.add('show');
  clearTimeout(pop._hide);
  pop._hide = setTimeout(() => pop.classList.add('hidden'), 45000);
  osNotifyGif(ev);
}

function renderDvr(events) {
  const grid = document.getElementById('dvrGrid');
  if (!grid) return;
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    grid.innerHTML = '<div class="empty-inline">No DVR GIFs yet. When a person, animal, or threat is detected, Lookout records a looping clip here.</div>';
    return;
  }
  grid.innerHTML = list
    .map((ev) => {
      const gif = ev.gifUrl || ev.stillUrl || '';
      const kind =
        (ev.threatKind && ev.threatKind[0]) ||
        (ev.threats && ev.threats[0] && (ev.threats[0].type || ev.threats[0])) ||
        '';
      return `<article class="dvr-card" data-id="${escapeHtml(ev.id || '')}">
        ${gif ? `<img src="${escapeHtml(gif)}" alt="${escapeHtml(ev.title || 'DVR clip')}">` : ''}
        <div class="meta">${kind ? `<span class="kind">${escapeHtml(String(kind).replace(/_/g, ' '))}</span>` : ''}${escapeHtml(
          ev.title || 'Alert'
        )}
        <div class="muted small">${escapeHtml(whenLabel(ev.createdAt))}</div></div>
      </article>`;
    })
    .join('');
  grid.querySelectorAll('.dvr-card').forEach((card) => {
    card.onclick = () => {
      const ev = list.find((e) => e.id === card.dataset.id);
      if (ev) showGifPop(ev);
    };
  });
}

async function refreshAlerts() {
  try {
    const res = await fetch('/api/nvr/events?limit=12');
    const events = await res.json();
    if (!Array.isArray(events) || !events.length) {
      dock.innerHTML =
        '<div class="muted small">Alerts with looping GIFs appear here when a person, animal, or labeled threat is detected.</div>';
      renderDvr([]);
      return;
    }
    renderDvr(events);
    if (events[0].id !== lastAlertId) {
      if (lastAlertId && !isMuted()) playAlertDing();
      lastAlertId = events[0].id;
      showGifPop(events[0]);
    }
    dock.innerHTML = events
      .map((ev) => {
        const kind =
          (ev.threatKind && ev.threatKind[0]) ||
          (ev.threats && ev.threats[0] && (ev.threats[0].type || ev.threats[0])) ||
          '';
        const gif = ev.gifUrl || ev.stillUrl || '';
        return `<article class="alert-chip" data-id="${ev.id}">
          ${gif ? `<img src="${gif}" alt="alert gif">` : ''}
          <div class="meta">${kind ? `<span class="kind">${escapeHtml(String(kind).replace(/_/g, ' '))}</span>` : ''}
          ${escapeHtml(ev.title || 'Alert')}</div>
        </article>`;
      })
      .join('');
  } catch {
    /* ignore */
  }
}

const es = new EventSource('/api/live/events');
es.addEventListener('list', (e) => {
  try {
    renderCams(JSON.parse(e.data));
  } catch {
    /* ignore */
  }
});
es.addEventListener('scene', (e) => {
  try {
    const s = JSON.parse(e.data);
    if (!s || !s.id) return;
    if (s.caption) captions.set(s.id, s.caption);
    const cam = lastList.find((c) => c.id === s.id);
    if (cam) {
      cam.caption = s.caption || cam.caption;
      cam.faces = s.faces || cam.faces;
    }
    setTileCaption(s.id, s.caption || '');
    paintLiveScene();
  } catch {
    /* ignore */
  }
});
es.onerror = () => {
  setTimeout(refreshList, 2000);
};

if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'lookout-mute') muteUntil((ev.data.minutes || 30) * 60 * 1000);
  });
}

const allBtn = document.getElementById('btnAllCams');
if (allBtn) {
  allBtn.onclick = () => {
    focusId = '';
    history.replaceState(null, '', homePath());
    wall.querySelectorAll('.cam-tile').forEach((t) => t.classList.remove('hero'));
    applyFocus();
    lastList.forEach((c) => {
      const img = wall.querySelector('[data-id="' + c.id + '"] img.live');
      if (img && c.alive) img.src = jpegSrc(c.id);
    });
  };
}

const gifClose = document.getElementById('gifPopClose');
const gifPop = document.getElementById('gifPop');
if (gifClose && gifPop) {
  gifClose.onclick = () => gifPop.classList.add('hidden');
  let sx = 0;
  gifPop.addEventListener(
    'touchstart',
    (e) => {
      sx = e.changedTouches[0].clientX;
    },
    { passive: true }
  );
  gifPop.addEventListener(
    'touchend',
    (e) => {
      if (Math.abs(e.changedTouches[0].clientX - sx) > 80) gifPop.classList.add('hidden');
    },
    { passive: true }
  );
}

async function ptz(dir) {
  const rec = camBook(focusId) || { id: focusId };
  try {
    const res = await fetch('/api/cameras/' + encodeURIComponent(rec.id) + '/ptz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Pan not available');
  } catch (err) {
    if (dir !== 'stop') toast(err.message || 'This camera cannot pan', 'err');
  }
}

const pad = document.getElementById('ptzPad');
if (pad) {
  pad.querySelectorAll('[data-ptz]').forEach((btn) => {
    const dir = btn.getAttribute('data-ptz');
    const start = (e) => {
      e.preventDefault();
      ptz(dir);
    };
    const stop = (e) => {
      e.preventDefault();
      if (dir !== 'stop') ptz('stop');
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('click', (e) => e.preventDefault());
  });
}

fetch('/api/cameras')
  .then((r) => r.json())
  .then((list) => {
    book = Array.isArray(list) ? list : [];
    applyFocus();
  })
  .catch(() => {});

refreshList();
refreshAlerts();
refreshFaces();
setInterval(refreshAlerts, getPerf().level === 'low' ? 7000 : 4000);
setInterval(refreshList, getPerf().level === 'low' ? 12000 : 8000);
setInterval(refreshFaces, getPerf().facesMs || 5000);
pulseTimer = setInterval(pulseThumbs, getPerf().thumbMs || 500);
showPermissionCoach();
requestKeepAlive().then(() => subscribePush()).catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

if (location.hash === '#unknowns') {
  const box = document.getElementById('unknowns');
  if (box) setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
}
if (location.hash === '#alerts') {
  if (dock) setTimeout(() => dock.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
}
