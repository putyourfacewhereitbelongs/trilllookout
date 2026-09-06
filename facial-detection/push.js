'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

function createPush(root) {
  const file = path.join(root, 'data', 'nvr', 'push.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = load(file);

  if (!state.vapid || !state.vapid.publicKey || !state.vapid.privateKey) {
    state.vapid = webpush.generateVAPIDKeys();
    save(file, state);
  }
  webpush.setVapidDetails('mailto:trill-lookout-cam@localhost', state.vapid.publicKey, state.vapid.privateKey);

  function publicKey() {
    return state.vapid.publicKey;
  }

  function subscribe(sub) {
    if (!sub || !sub.endpoint) throw new Error('Invalid push subscription');
    state.subscriptions = (state.subscriptions || []).filter((s) => s.endpoint !== sub.endpoint);
    state.subscriptions.push({
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime || null,
      keys: sub.keys || {}
    });
    if (state.subscriptions.length > 40) state.subscriptions = state.subscriptions.slice(-40);
    save(file, state);
    return { ok: true, count: state.subscriptions.length };
  }

  function unsubscribe(endpoint) {
    state.subscriptions = (state.subscriptions || []).filter((s) => s.endpoint !== endpoint);
    save(file, state);
    return { ok: true };
  }

  async function notify(event) {
    const gif = event && (event.gifUrl || event.stillUrl);
    const payload = JSON.stringify({
      title: (event && event.title) || 'Lookout',
      body: String((event && (event.description || event.caption)) || 'Activity detected').slice(0, 180),
      url: (event && event.watchUrl) || '/',
      tag: (event && event.id) || 'trill-alert',
      gif,
      image: gif,
      actions: event && event.actions
    });
    const keep = [];
    for (const sub of state.subscriptions || []) {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 60 * 30, urgency: 'high' });
        keep.push(sub);
      } catch (err) {
        const code = err && err.statusCode;
        if (code !== 404 && code !== 410) keep.push(sub);
      }
    }
    if (keep.length !== (state.subscriptions || []).length) {
      state.subscriptions = keep;
      save(file, state);
    }
  }

  return { publicKey, subscribe, unsubscribe, notify };
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return { vapid: null, subscriptions: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { vapid: raw.vapid || null, subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [] };
  } catch {
    return { vapid: null, subscriptions: [] };
  }
}

function save(file, state) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { createPush };
