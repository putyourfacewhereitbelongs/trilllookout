'use strict';

function createLiveHub() {
  const cams = new Map();
  const listWaiters = new Set();

  function ensure(id) {
    let cam = cams.get(id);
    if (!cam) {
      cam = {
        id,
        name: id,
        jpeg: null,
        ts: 0,
        width: 0,
        height: 0,
        kind: 'host',
        alive: false,
        viewers: new Set(),
        caption: '',
        faces: [],
        sceneSent: 0
      };
      cams.set(id, cam);
    }
    return cam;
  }

  function push(id, buffer, meta) {
    if (!id || !buffer || !buffer.length) return;
    const cam = ensure(id);
    const wasDead = !cam.alive || Date.now() - cam.ts > 4000;
    cam.jpeg = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    cam.ts = Date.now();
    cam.alive = true;
    if (meta) {
      if (meta.name) cam.name = String(meta.name).slice(0, 80);
      if (meta.width) cam.width = Number(meta.width) || cam.width;
      if (meta.height) cam.height = Number(meta.height) || cam.height;
      if (meta.kind) cam.kind = String(meta.kind);
      if (meta.caption != null && String(meta.caption).trim()) {
        cam.caption = String(meta.caption).slice(0, 500);
      }
      if (meta.faces) cam.faces = normalizeFaces(meta.faces);
    }
    if (wasDead) notifyList();
    maybeScene(cam);
    const part = mjpegPart(cam.jpeg);
    for (const res of cam.viewers) {
      try {
        res.write(part);
      } catch {
        cam.viewers.delete(res);
      }
    }
  }

  function dead(id) {
    const cam = cams.get(id);
    if (!cam) return;
    cam.alive = false;
    notifyList();
  }

  function remove(id) {
    const cam = cams.get(id);
    if (!cam) return;
    for (const res of cam.viewers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    cams.delete(id);
    notifyList();
  }

  function list() {
    const now = Date.now();
    return [...cams.values()].map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      alive: Boolean(c.alive && now - c.ts < 5000),
      ageMs: c.jpeg ? now - c.ts : null,
      width: c.width,
      height: c.height,
      viewers: c.viewers.size,
      caption: c.caption || '',
      faces: c.faces || [],
      watchPath: '/watch.html?cam=' + encodeURIComponent(c.id),
      mjpegPath: '/api/live/' + encodeURIComponent(c.id) + '/mjpeg',
      jpegPath: '/api/live/' + encodeURIComponent(c.id) + '/jpeg'
    }));
  }

  function jpeg(id) {
    const cam = cams.get(id);
    return cam && cam.jpeg ? cam.jpeg : null;
  }

  function mjpegStream(id, req, res) {
    const cam = ensure(id);
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=lookoutframe',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive'
    });
    cam.viewers.add(res);
    if (cam.jpeg) {
      try {
        res.write(mjpegPart(cam.jpeg));
      } catch {
        /* ignore */
      }
    }
    const ping = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    const drop = () => {
      clearInterval(ping);
      cam.viewers.delete(res);
    };
    req.on('close', drop);
    req.on('aborted', drop);
  }

  function onList(res) {
    listWaiters.add(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('event: list\ndata: ' + JSON.stringify(list()) + '\n\n');
    reqClose(res, () => listWaiters.delete(res));
  }

  function notifyList() {
    const payload = 'event: list\ndata: ' + JSON.stringify(list()) + '\n\n';
    for (const res of listWaiters) {
      try {
        res.write(payload);
      } catch {
        listWaiters.delete(res);
      }
    }
  }

  function maybeScene(cam) {
    const t = Date.now();
    if (t - (cam.sceneSent || 0) < 900) return;
    cam.sceneSent = t;
    const payload =
      'event: scene\ndata: ' +
      JSON.stringify({
        id: cam.id,
        name: cam.name,
        caption: cam.caption || '',
        faces: cam.faces || []
      }) +
      '\n\n';
    for (const res of listWaiters) {
      try {
        res.write(payload);
      } catch {
        listWaiters.delete(res);
      }
    }
  }

  function reqClose(res, fn) {
    res.req.on('close', fn);
    res.req.on('aborted', fn);
  }

  return { push, dead, remove, list, jpeg, mjpegStream, onList, ensure };
}

function normalizeFaces(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 12).map((f) => ({
    name: String((f && f.name) || '').slice(0, 80),
    personId: String((f && f.personId) || '').slice(0, 80),
    kind: String((f && f.kind) || '').slice(0, 24),
    status: String((f && f.status) || '').slice(0, 24)
  }));
}

function mjpegPart(jpeg) {
  return Buffer.concat([
    Buffer.from(
      '--lookoutframe\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n'
    ),
    jpeg,
    Buffer.from('\r\n')
  ]);
}

module.exports = { createLiveHub };
