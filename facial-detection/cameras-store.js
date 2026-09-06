'use strict';

const fs = require('fs');
const path = require('path');

function createCamerasStore(root, uid, now) {
  const file = path.join(root, 'data', 'nvr', 'cameras.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cameras = load(file);

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cameras, null, 2));
    fs.renameSync(tmp, file);
  }

  function publicCam(c) {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      brand: c.brand || '',
      url: c.url || '',
      username: c.username || '',
      hasPassword: Boolean(c.password),
      enabled: c.enabled !== false,
      ptz: c.ptz != null ? Boolean(c.ptz) : guessPtz(c.brand, c.type),
      ptzStyle: c.ptzStyle || '',
      createdAt: c.createdAt,
      watchPath: '/watch.html?cam=' + encodeURIComponent(c.id),
      streamPath: '/api/cameras/' + encodeURIComponent(c.id) + '/stream'
    };
  }

  function list() {
    return cameras.map(publicCam);
  }

  function get(id) {
    return cameras.find((c) => c.id === id) || null;
  }

  function add(body) {
    const url = String((body && body.url) || '').trim();
    const type = String((body && body.type) || guessType(url, body && body.brand)).slice(0, 24);
    if (/^rtsp:/i.test(url)) {
      throw new Error(
        'RTSP cannot play in the browser. Use the camera HTTP snapshot or MJPEG URL (Wyze: snapshot.jpg from the LAN web UI or a bridge).'
      );
    }
    if (type !== 'device' && type !== 'host' && !url) throw new Error('Camera URL is required');
    if (url && !/^https?:\/\//i.test(url) && type !== 'device' && type !== 'host') {
      throw new Error('Use an http:// or https:// camera URL');
    }
    const cam = {
      id: uid(),
      name: String((body && body.name) || 'Camera').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Camera',
      type,
      brand: String((body && body.brand) || '').slice(0, 40),
      url,
      username: String((body && body.username) || '').slice(0, 80),
      password: String((body && body.password) || '').slice(0, 120),
      enabled: body && body.enabled === false ? false : true,
      ptz: body && body.ptz != null ? Boolean(body.ptz) : guessPtz(body && body.brand, type),
      ptzStyle: String((body && body.ptzStyle) || '').slice(0, 24),
      createdAt: now()
    };
    cameras.push(cam);
    save();
    return publicCam(cam);
  }

  function update(id, body) {
    const cam = get(id);
    if (!cam) return null;
    if (body.name != null) cam.name = String(body.name).replace(/\s+/g, ' ').trim().slice(0, 80) || cam.name;
    if (body.url != null) cam.url = String(body.url).trim();
    if (body.type != null) cam.type = String(body.type).slice(0, 24);
    if (body.brand != null) cam.brand = String(body.brand).slice(0, 40);
    if (body.username != null) cam.username = String(body.username).slice(0, 80);
    if (typeof body.password === 'string' && body.password) cam.password = body.password.slice(0, 120);
    if (body.enabled != null) cam.enabled = Boolean(body.enabled);
    if (body.ptz != null) cam.ptz = Boolean(body.ptz);
    if (body.ptzStyle != null) cam.ptzStyle = String(body.ptzStyle).slice(0, 24);
    save();
    return publicCam(cam);
  }

  function remove(id) {
    const idx = cameras.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    cameras.splice(idx, 1);
    save();
    return true;
  }

  return { list, get, add, update, remove, publicCam };
}

function guessPtz(brand, type) {
  const b = String(brand || '').toLowerCase() + ' ' + String(type || '').toLowerCase();
  return /wyze|hik|dahua|amcrest|reolink|foscam|ptz|pan/.test(b);
}

function guessType(url, brand) {
  const b = String(brand || '').toLowerCase();
  if (b.includes('wyze')) return 'wyze';
  const u = String(url || '').toLowerCase();
  if (u.includes('mjpg') || u.includes('mjpeg') || u.includes('video.cgi')) return 'mjpeg';
  if (u.endsWith('.m3u8')) return 'hls';
  if (u.includes('snapshot') || u.includes('jpg') || u.includes('image')) return 'snapshot';
  return 'mjpeg';
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

module.exports = { createCamerasStore };
