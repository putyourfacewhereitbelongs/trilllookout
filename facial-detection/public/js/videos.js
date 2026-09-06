import { mountNav } from './nav.js';
import { setupInstall } from './install.js';
mountNav('videos');
setupInstall();

const $ = (sel) => document.querySelector(sel);

const state = {
  segments: [],
  stats: null,
  openId: null
};

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data;
}

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function formatBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function durationOf(seg) {
  const a = new Date(seg.startedAt).getTime();
  const b = new Date(seg.endedAt || seg.startedAt).getTime();
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function filtered() {
  const source = $('#filterSource').value;
  const day = $('#filterDay').value;
  return state.segments.filter((s) => {
    if (source && s.source !== source) return false;
    if (day && String(s.startedAt).slice(0, 10) !== day) return false;
    return true;
  });
}

function render() {
  const list = filtered();
  $('#libCount').textContent = list.length + (list.length === 1 ? ' clip' : ' clips');
  if (state.stats) $('#libDisk').textContent = formatBytes(state.stats.bytes);
  const grid = $('#videoGrid');
  if (!list.length) {
    grid.innerHTML = '<div class="empty-inline">No recordings yet. Start live detection on the main view — Trill Lookout AI Cam saves video locally as soon as the feed is running.</div>';
    return;
  }
  grid.innerHTML = list
    .map((s) => {
      const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : '';
      const snap = s.kind === 'snap' || /\.jpe?g($|\?)/i.test(s.url || '');
      const media = snap
        ? `<img src="${escapeHtml(s.url)}" alt="snapshot">`
        : `<video src="${s.url}#t=0.4" muted playsinline preload="metadata"></video>`;
      return `<article class="video-card" data-id="${s.id}">
        ${media}
        <div class="meta">
          <h3>${escapeHtml(s.source || 'feed')} · ${snap ? 'snap' : durationOf(s)}</h3>
          <span class="muted small">${escapeHtml(when)} · ${formatBytes(s.bytes)}</span>
        </div>
      </article>`;
    })
    .join('');
}

function fillDays() {
  const days = [...new Set(state.segments.map((s) => String(s.startedAt).slice(0, 10)).filter(Boolean))];
  const sel = $('#filterDay');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All days</option>' + days.map((d) => `<option value="${d}">${d}</option>`).join('');
  if (days.includes(cur)) sel.value = cur;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openPlayer(id) {
  const seg = state.segments.find((s) => s.id === id);
  if (!seg) return;
  state.openId = id;
  $('#playerTitle').textContent = (seg.source || 'feed') + ' · ' + durationOf(seg);
  $('#playerMeta').textContent = (seg.startedAt ? new Date(seg.startedAt).toLocaleString() : '') + ' · ' + formatBytes(seg.bytes);
  const video = $('#playerVideo');
  video.src = seg.url;
  video.play().catch(() => {});
  $('#playerDownload').href = seg.url;
  $('#playerModal').classList.remove('hidden');
}

function closePlayer() {
  const video = $('#playerVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#playerModal').classList.add('hidden');
  state.openId = null;
}

async function load() {
  try {
    const [segments, stats] = await Promise.all([api('/api/nvr/segments?limit=2000'), api('/api/nvr/stats')]);
    state.segments = segments;
    state.stats = stats;
    fillDays();
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#videoGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.video-card');
  if (card) openPlayer(card.dataset.id);
});
$('#filterSource').addEventListener('change', render);
$('#filterDay').addEventListener('change', render);
$('#btnRefresh').onclick = load;
$('#playerClose').onclick = closePlayer;
$('#playerModal').addEventListener('click', (e) => {
  if (e.target.id === 'playerModal') closePlayer();
});
$('#playerDelete').onclick = async () => {
  if (!state.openId) return;
  if (!confirm('Delete this clip from local storage?')) return;
  try {
    await api('/api/nvr/segments/' + state.openId, { method: 'DELETE' });
    closePlayer();
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
};

async function openShare() {
  try {
    const data = await api('/api/share');
    const img = $('#shareQr');
    if (img && data.qr) img.src = data.qr;
    const list = $('#shareUrls');
    if (list) {
      list.innerHTML = (data.urls || []).map((u) => '<li><a href="' + u.replace(/"/g, '') + '">' + escapeHtml(u) + '</a></li>').join('');
    }
    $('#shareModal').classList.remove('hidden');
    $('#shareCopy').onclick = async () => {
      await navigator.clipboard.writeText(data.primary);
      toast('Link copied');
    };
    $('#shareNative').onclick = async () => {
      try {
        if (navigator.share) await navigator.share({ title: 'Trill Lookout AI Cam', url: data.primary });
        else {
          await navigator.clipboard.writeText(data.primary);
          toast('Link copied');
        }
      } catch (err) {
        if (err && err.name !== 'AbortError') toast(err.message, 'err');
      }
    };
  } catch (err) {
    toast(err.message, 'err');
  }
}

if ($('#btnShareApp')) $('#btnShareApp').onclick = openShare;
if ($('#shareClose')) $('#shareClose').onclick = () => $('#shareModal').classList.add('hidden');
if ($('#shareModal')) {
  $('#shareModal').addEventListener('click', (e) => {
    if (e.target.id === 'shareModal') $('#shareModal').classList.add('hidden');
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

load();
