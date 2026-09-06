'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');

const PORTS = [80, 81, 88, 443, 554, 8000, 8080, 8081, 8443, 8554, 8888, 5000, 37777];
const PATHS = [
  '/snapshot.jpg',
  '/snapshot.cgi',
  '/cgi-bin/snapshot.cgi',
  '/jpg/image.jpg',
  '/image.jpg',
  '/axis-cgi/jpg/image.cgi',
  '/cgi-bin/mjpg/video.cgi',
  '/mjpg/video.mjpg',
  '/video.mjpg',
  '/mjpeg',
  '/video',
  '/stream',
  '/live.jpg',
  '/ISAPI/Streaming/channels/101/picture'
];

function lanPrefixes() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.internal) continue;
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      const parts = n.address.split('.');
      if (parts.length !== 4) continue;
      out.push({ prefix: parts.slice(0, 3).join('.'), self: n.address });
    }
  }
  return out;
}

function probe(url, timeoutMs, auth) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, error: 'bad url' });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = { Accept: 'image/*, video/*, multipart/x-mixed-replace, */*;q=0.1', 'User-Agent': 'TrillLookoutCam/1.2' };
    if (auth && auth.username) {
      headers.Authorization = 'Basic ' + Buffer.from(auth.username + ':' + (auth.password || '')).toString('base64');
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: timeoutMs || 900,
        rejectUnauthorized: false
      },
      (res) => {
        const ctype = String(res.headers['content-type'] || '').toLowerCase();
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (chunks.length < 8 && size < 256 * 1024) chunks.push(c);
          if (size > 64 * 1024) {
            res.destroy();
          }
        });
        res.on('end', () => finish());
        res.on('error', () => finish());
        const timer = setTimeout(() => {
          res.destroy();
          finish();
        }, 700);
        let done = false;
        function finish() {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          const kind = classify(ctype, buf);
          resolve({
            ok: kind === 'jpeg' || kind === 'mjpeg' || kind === 'hls',
            status: res.statusCode,
            contentType: ctype,
            kind,
            bytes: size,
            preview: kind === 'jpeg' ? 'data:image/jpeg;base64,' + buf.toString('base64') : null
          });
        }
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

function classify(ctype, buf) {
  if (ctype.includes('multipart') || ctype.includes('mjpeg') || ctype.includes('x-mixed-replace')) return 'mjpeg';
  if (ctype.includes('mpegurl') || ctype.includes('m3u8')) return 'hls';
  if (ctype.includes('image/jpeg') || ctype.includes('image/jpg')) return 'jpeg';
  if (buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return 'other';
}

async function testLink(url, auth) {
  if (/^rtsp:/i.test(url)) {
    return {
      ok: false,
      error: 'RTSP is not playable in the browser. Paste an HTTP snapshot or MJPEG URL for this camera.'
    };
  }
  const result = await probe(url, 2500, auth);
  if (result.ok) return result;
  return { ok: false, error: result.error || 'Not a camera JPEG/MJPEG stream (' + (result.contentType || result.status || 'no response') + ')' };
}

async function scanLan({ limit = 64 } = {}) {
  const prefixes = lanPrefixes();
  const jobs = [];
  for (const { prefix, self } of prefixes) {
    for (let i = 1; i <= 254; i++) {
      const ip = prefix + '.' + i;
      if (ip === self) continue;
      for (const port of PORTS) {
        if (port === 554 || port === 8554) continue;
        const proto = port === 443 || port === 8443 ? 'https' : 'http';
        jobs.push({ ip, port, proto });
      }
    }
  }
  const found = [];
  const seenHost = new Set();
  let cursor = 0;
  const workers = Math.min(48, jobs.length || 1);
  async function worker() {
    while (cursor < jobs.length && found.length < limit) {
      const job = jobs[cursor++];
      const origin = job.proto + '://' + job.ip + (job.port === 80 || job.port === 443 ? '' : ':' + job.port);
      if (seenHost.has(origin)) continue;
      const hit = await probeOpen(origin);
      if (!hit) continue;
      seenHost.add(origin);
      const paths = [];
      for (const p of PATHS) {
        const r = await probe(origin + p, 800);
        if (r.ok) {
          paths.push({ url: origin + p, kind: r.kind, preview: r.preview || null });
          if (paths.length >= 3) break;
        }
      }
      found.push({
        host: job.ip,
        port: job.port,
        origin,
        streams: paths
      });
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { scanned: jobs.length, cameras: found.filter((c) => c.streams.length) };
}

function probeOpen(origin) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(origin + '/');
    } catch {
      return resolve(false);
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: '/',
        method: 'HEAD',
        timeout: 500,
        rejectUnauthorized: false
      },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function proxyCamera(cam, req, res) {
  if (!cam || !cam.url) {
    res.status(404).json({ error: 'Camera has no URL' });
    return;
  }
  if (/^rtsp:/i.test(cam.url)) {
    res.status(400).json({ error: 'RTSP cannot be proxied without a browser-playable HTTP snapshot/MJPEG URL' });
    return;
  }
  let parsed;
  try {
    parsed = new URL(cam.url);
  } catch {
    res.status(400).json({ error: 'Bad camera URL' });
    return;
  }
  const lib = parsed.protocol === 'https:' ? https : http;
  const headers = { Accept: req.headers.accept || '*/*', 'User-Agent': 'TrillLookoutCam/1.2' };
  if (cam.username) {
    headers.Authorization = 'Basic ' + Buffer.from(cam.username + ':' + (cam.password || '')).toString('base64');
  }
  const up = lib.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false,
      timeout: 12000
    },
    (upRes) => {
      const ctype = upRes.headers['content-type'] || 'image/jpeg';
      res.writeHead(upRes.statusCode || 200, {
        'Content-Type': ctype,
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*'
      });
      upRes.pipe(res);
    }
  );
  up.on('timeout', () => {
    up.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Camera timed out' });
  });
  up.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: err.message || 'Camera proxy failed' });
  });
  req.on('close', () => up.destroy());
  up.end();
}

module.exports = { scanLan, testLink, proxyCamera, lanPrefixes };
