export function bindIpCameras({ toast, api, onSaved } = {}) {
  const form = document.getElementById('camForm');
  if (!form) return;

  async function loadCams() {
    const el = document.getElementById('savedCams');
    if (!el) return;
    try {
      const list = await api('/api/cameras');
      if (!list.length) {
        el.innerHTML = '<p class="muted small">No saved IP cameras yet.</p>';
        return;
      }
      el.innerHTML = list
        .map(
          (c) => `<article class="person-card" data-id="${c.id}">
          <div class="meta"><h3>${escapeHtml(c.name)}</h3><span class="muted small">${escapeHtml(
            (c.brand || c.type || '') + ' · ' + (c.url || '')
          )}</span></div>
          <div class="tools"><button class="icon-btn" data-del="${c.id}" type="button">✕</button></div>
        </article>`
        )
        .join('');
    } catch (err) {
      el.innerHTML = '<p class="muted small">' + escapeHtml(err.message || 'Could not load cameras') + '</p>';
    }
  }

  const scanBtn = document.getElementById('btnScan');
  if (scanBtn) {
    scanBtn.onclick = async () => {
      const st = document.getElementById('scanStatus');
      if (st) st.textContent = 'Scanning LAN for HTTP cameras… this can take up to a minute.';
      try {
        const data = await api('/api/cameras/scan', { method: 'POST' });
        if (st) st.textContent = 'Found ' + (data.cameras || []).length + ' camera host(s).';
        const box = document.getElementById('scanResults');
        if (!box) return;
        box.innerHTML =
          (data.cameras || [])
            .map((c) =>
              (c.streams || [])
                .map(
                  (s) =>
                    `<button type="button" class="btn tiny" data-fill="${encodeURIComponent(s.url)}">${escapeHtml(
                      c.host
                    )} · ${escapeHtml(s.kind)}</button>`
                )
                .join(' ')
            )
            .join(' ') ||
          '<p class="muted small">No MJPEG/JPEG cameras answered. Paste a snapshot URL from the Wyze/IP camera web page.</p>';
        box.querySelectorAll('[data-fill]').forEach((b) => {
          b.onclick = () => {
            const urlEl = document.querySelector('#camForm [name=url]');
            if (urlEl) urlEl.value = decodeURIComponent(b.dataset.fill);
          };
        });
      } catch (err) {
        if (st) st.textContent = err.message;
      }
    };
  }

  let testPassed = false;
  const testBtn = document.getElementById('btnTestCam');
  if (testBtn) {
    testBtn.onclick = async () => {
      const url = form.url.value.trim();
      try {
        const result = await api('/api/cameras/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, username: form.username.value, password: form.password.value })
        });
        if (!result.ok) throw new Error(result.error || 'Test failed');
        const pip = document.getElementById('pipBox');
        const img = document.getElementById('pipImg');
        if (img) img.src = result.preview || url;
        if (pip) pip.classList.remove('hidden');
        testPassed = true;
        const save = document.getElementById('btnSaveCam');
        if (save) save.classList.remove('hidden');
        toast('PIP opened — you can save this camera');
      } catch (err) {
        testPassed = false;
        const save = document.getElementById('btnSaveCam');
        if (save) save.classList.add('hidden');
        toast(err.message, 'err');
      }
    };
  }

  const pipClose = document.getElementById('pipClose');
  if (pipClose) pipClose.onclick = () => document.getElementById('pipBox').classList.add('hidden');

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!testPassed) return toast('Test the link until the PIP picture appears, then save', 'err');
    try {
      await api('/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(form))
      });
      toast('Camera saved');
      form.reset();
      testPassed = false;
      const save = document.getElementById('btnSaveCam');
      if (save) save.classList.add('hidden');
      await loadCams();
      if (onSaved) await onSaved();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const saved = document.getElementById('savedCams');
  if (saved) {
    saved.onclick = async (e) => {
      const id = e.target.dataset.del;
      if (!id) return;
      try {
        await api('/api/cameras/' + id, { method: 'DELETE' });
        await loadCams();
        if (onSaved) await onSaved();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  loadCams().catch((err) => toast(err.message, 'err'));
}

function payload(form) {
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
  }
  return body;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
