/* Trill Lookout AI Cam service worker */
const CACHE = 'trill-lookout-cam-v16';
const PRECACHE = [
  '/',
  '/index.html',
  '/host.html',
  '/go.html',
  '/videos.html',
  '/watch.html',
  '/enroll.html',
  '/settings.html',
  '/camera.html',
  '/share.html',
  '/css/style.css',
  '/css/shell.css',
  '/js/app.js',
  '/js/engine.js',
  '/js/nvr.js',
  '/js/gifenc.js',
  '/js/vision.js',
  '/js/threat.js',
  '/js/videos.js',
  '/js/nav.js',
  '/js/origin.js',
  '/js/ding.js',
  '/js/watch.js',
  '/js/tutorial.js',
  '/js/settings-page.js',
  '/js/enroll-page.js',
  '/js/live-client.js',
  '/js/detect-worker.js',
  '/js/night-vision.js',
  '/js/persist.js',
  '/js/install.js',
  '/js/share-page.js',
  '/js/moondream.js',
  '/js/moondream-worker.js',
  '/js/perf.js',
  '/sounds/alert.wav',
  '/manifest.json',
  '/face-api.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/vendor/tf.min.js',
  '/vendor/coco-ssd.min.js',
  '/models/age_gender_model-shard1',
  '/models/age_gender_model-weights_manifest.json',
  '/models/coco-ssd/model.json',
  '/models/coco-ssd/group1-shard1of5',
  '/models/coco-ssd/group1-shard2of5',
  '/models/coco-ssd/group1-shard3of5',
  '/models/coco-ssd/group1-shard4of5',
  '/models/coco-ssd/group1-shard5of5',
  '/models/face_landmark_68_model-shard1',
  '/models/face_landmark_68_model-weights_manifest.json',
  '/models/face_recognition_model-shard1',
  '/models/face_recognition_model-shard2',
  '/models/face_recognition_model-weights_manifest.json',
  '/models/ssd_mobilenetv1_model-shard1',
  '/models/ssd_mobilenetv1_model-shard2',
  '/models/ssd_mobilenetv1_model-weights_manifest.json',
  '/models/tiny_face_detector_model-shard1',
  '/models/tiny_face_detector_model-weights_manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(PRECACHE).catch(async () => {
          for (const url of PRECACHE) {
            try {
              await cache.add(url);
            } catch {
              /* keep going so a missing file does not block the rest */
            }
          }
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/nvr/') || url.pathname.startsWith('/media/')) return;
  const htmlNav =
    req.mode === 'navigate' ||
    req.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    /\.html$/i.test(url.pathname);

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && /\/api\/live\/.+\/jpeg$/.test(url.pathname)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (htmlNav) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/watch.html') || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Lookout', body: 'Activity detected', url: '/' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch {
    try {
      data.body = event.data.text();
    } catch {
      /* ignore */
    }
  }
  const gif = data.gif || data.image || '';
  const image = gif ? new URL(gif, self.location.origin).href : undefined;
  event.waitUntil(
    self.registration.showNotification(data.title || 'Lookout', {
      body: data.body || 'Activity detected',
      icon: image || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      image,
      tag: data.tag || 'trill-alert',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || '/', gif: image },
      actions: Array.isArray(data.actions) && data.actions.length
        ? data.actions
        : [
            { action: 'view', title: 'View' },
            { action: 'mute', title: 'Mute' }
          ]
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();
  if (action === 'mute') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const c of clients) c.postMessage({ type: 'lookout-mute', minutes: 30 });
      })
    );
    return;
  }
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url && 'focus' in c) {
          try {
            c.navigate(url);
          } catch {
            /* ignore */
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
