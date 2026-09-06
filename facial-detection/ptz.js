'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DIRS = {
  up: 1,
  down: 1,
  left: 1,
  right: 1,
  stop: 1,
  zoomIn: 1,
  zoomOut: 1,
  home: 1
};

function guessStyle(cam) {
  const b = String((cam && cam.brand) || '').toLowerCase();
  const u = String((cam && cam.url) || '').toLowerCase();
  if (cam && cam.ptzStyle) return cam.ptzStyle;
  if (b.includes('hik')) return 'hikvision';
  if (b.includes('dahua') || b.includes('amcrest')) return 'dahua';
  if (b.includes('foscam')) return 'foscam';
  if (b.includes('reolink')) return 'reolink';
  if (b.includes('wyze') || u.includes('hi3510') || u.includes('ptzctrl')) return 'hi3510';
  if (u.includes('decoder_control')) return 'foscam';
  if (u.includes('isapi')) return 'hikvision';
  return 'auto';
}

function supportsGuess(cam) {
  const b = String((cam && cam.brand) || '').toLowerCase();
  const t = String((cam && cam.type) || '').toLowerCase();
  if (cam && cam.ptz === true) return true;
  if (cam && cam.ptz === false) return false;
  return /wyze|hik|dahua|amcrest|reolink|foscam|ptz|pan/.test(b + ' ' + t);
}

function originOf(cam) {
  try {
    const u = new URL(cam.url);
    return u.origin;
  } catch {
    return '';
  }
}

function authHeader(cam) {
  if (!cam || !cam.username) return {};
  return {
    Authorization: 'Basic ' + Buffer.from(String(cam.username) + ':' + String(cam.password || '')).toString('base64')
  };
}

function request(cam, { path, method, body, headers, timeoutMs }) {
  return new Promise((resolve) => {
    const origin = originOf(cam);
    if (!origin) return resolve({ ok: false, error: 'no camera origin' });
    let parsed;
    try {
      parsed = new URL(path.startsWith('http') ? path : origin + path);
    } catch {
      return resolve({ ok: false, error: 'bad ptz url' });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method || 'GET',
        headers: Object.assign({ 'User-Agent': 'TrillLookoutAICam/1.0', Accept: '*/*' }, authHeader(cam), headers || {}),
        timeout: timeoutMs || 2500,
        rejectUnauthorized: false
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => {
          if (chunks.length < 8) chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 400)
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

function hikXml(dir, speed) {
  const s = speed || 40;
  const pan = dir === 'left' ? -s : dir === 'right' ? s : 0;
  const tilt = dir === 'up' ? s : dir === 'down' ? -s : 0;
  const zoom = dir === 'zoomIn' ? s : dir === 'zoomOut' ? -s : 0;
  if (dir === 'stop' || dir === 'home') {
    return '<?xml version="1.0"?><PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>';
  }
  return '<?xml version="1.0"?><PTZData><pan>' + pan + '</pan><tilt>' + tilt + '</tilt><zoom>' + zoom + '</zoom></PTZData>';
}

const DAHUA = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  stop: 'Stop',
  zoomIn: 'ZoomTele',
  zoomOut: 'ZoomWide',
  home: 'Reset'
};

const FOSCAM = {
  up: 0,
  stop: 1,
  down: 2,
  left: 6,
  right: 4,
  zoomIn: 16,
  zoomOut: 18,
  home: 25
};

const HI3510 = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  stop: 'stop',
  zoomIn: 'zoomin',
  zoomOut: 'zoomout',
  home: 'home'
};

async function tryStyle(cam, style, dir) {
  if (style === 'hikvision') {
    return request(cam, {
      path: '/ISAPI/PTZCtrl/channels/1/continuous',
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body: hikXml(dir)
    });
  }
  if (style === 'dahua') {
    const code = DAHUA[dir] || 'Stop';
    const action = dir === 'stop' || dir === 'home' ? 'stop' : 'start';
    return request(cam, {
      path:
        '/cgi-bin/ptz.cgi?action=' +
        action +
        '&channel=1&code=' +
        encodeURIComponent(code) +
        '&arg1=0&arg2=2&arg3=0'
    });
  }
  if (style === 'foscam') {
    const cmd = FOSCAM[dir] != null ? FOSCAM[dir] : 1;
    return request(cam, { path: '/decoder_control.cgi?command=' + cmd });
  }
  if (style === 'hi3510') {
    const act = HI3510[dir] || 'stop';
    return request(cam, { path: '/cgi-bin/hi3510/ptzctrl.cgi?-step=0&-act=' + encodeURIComponent(act) });
  }
  if (style === 'reolink') {
    const op =
      dir === 'stop'
        ? 'Stop'
        : dir === 'zoomIn'
          ? 'ZoomInc'
          : dir === 'zoomOut'
            ? 'ZoomDec'
            : String(dir).charAt(0).toUpperCase() + String(dir).slice(1);
    const body = JSON.stringify([
      { cmd: 'PtzCtrl', action: 0, param: { channel: 0, op, speed: 32 } }
    ]);
    return request(cam, {
      path: '/cgi-bin/api.cgi?cmd=PtzCtrl',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
  }
  return { ok: false, error: 'unknown style' };
}

async function move(cam, body) {
  const dir = String((body && (body.dir || body.command || body.action)) || '').trim();
  if (!DIRS[dir]) throw new Error('Unknown pan command. Use up, down, left, right, stop, zoomIn, zoomOut.');
  if (!cam || !cam.url) throw new Error('This camera has no HTTP address for pan/tilt');
  const preferred = guessStyle(cam);
  const order =
    preferred === 'auto'
      ? ['hi3510', 'dahua', 'hikvision', 'foscam', 'reolink']
      : [preferred, 'hi3510', 'dahua', 'hikvision', 'foscam', 'reolink'].filter((v, i, a) => a.indexOf(v) === i);
  let last = { ok: false, error: 'No pan URL answered' };
  for (const style of order) {
    const r = await tryStyle(cam, style, dir);
    if (r && r.ok) return { ok: true, dir, style };
    last = r || last;
  }
  return { ok: false, dir, error: (last && last.error) || 'Pan not supported on this camera' };
}

module.exports = { move, guessStyle, supportsGuess };
