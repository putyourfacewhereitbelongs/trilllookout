'use strict';

const nodemailer = require('nodemailer');
const fs = require('fs');

function publicSettings(s) {
  s = s || {};
  return {
    enabled: Boolean(s.enabled),
    preset: s.preset || 'gmail',
    host: s.host || '',
    port: Number(s.port || 587),
    secure: Boolean(s.secure),
    user: s.user || '',
    passSet: Boolean(s.pass),
    from: s.from || '',
    to: s.to || '',
    googleConnected: Boolean(s.googleConnected || (s.oauth && s.oauth.refreshToken)),
    googleEmail: s.googleEmail || (s.oauth && s.oauth.email) || ''
  };
}

function applyPreset(body) {
  const next = { ...body };
  if (next.preset === 'gmail') {
    next.host = next.host || 'smtp.gmail.com';
    next.port = next.port || 587;
    next.secure = false;
  } else if (next.preset === 'outlook') {
    next.host = next.host || 'smtp.office365.com';
    next.port = next.port || 587;
    next.secure = false;
  }
  return next;
}

async function makeTransport(settings, google) {
  if (google && typeof google.credentialsForMail === 'function') {
    const creds = google.credentialsForMail();
    if (creds && creds.refreshToken) {
      const accessToken = await google.accessToken();
      const user = creds.user || (google.email && google.email()) || settings.user;
      if (!user) throw new Error('Google is connected but no Gmail address was returned. Disconnect and Connect Google again.');
      return nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          accessToken
        }
      });
    }
  }
  if (!settings || !settings.host || !settings.user || !settings.pass) {
    throw new Error('Connect Google (Settings) or enter SMTP host, username, and password');
  }
  return nodemailer.createTransport({
    host: settings.host,
    port: Number(settings.port || 587),
    secure: Boolean(settings.secure) || Number(settings.port) === 465,
    auth: { user: settings.user, pass: settings.pass }
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function threatKind(t) {
  const type = String(typeof t === 'string' ? t : (t && (t.type || t.label)) || '').toLowerCase();
  if (type.includes('fall')) return 'Fall';
  if (type.includes('theft')) return 'Theft';
  if (type.includes('fight')) return 'Fight';
  if (type.includes('violence') || type.includes('slap') || type.includes('strike')) return 'Violence';
  if (!type) return '';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function threatLine(event) {
  const threats = event.threats || [];
  if (!threats.length) return 'none';
  const labels = threats.map(threatKind).filter(Boolean);
  return labels.length ? labels.join(', ') : 'none';
}

function fromAddress(settings, google) {
  return (
    (settings && settings.from) ||
    (settings && settings.user) ||
    (google && google.email && google.email()) ||
    (settings && settings.googleEmail) ||
    undefined
  );
}

function toAddress(settings, google) {
  return (settings && settings.to) || (google && google.email && google.email()) || (settings && settings.googleEmail) || '';
}

async function sendAlert(settings, event, files, google) {
  if (!settings || !settings.enabled) throw new Error('Email alerts are turned off — enable them in Settings after Connect Google.');
  const to = toAddress(settings, google);
  if (!to) throw new Error('Pick a notification email address');
  const transport = await makeTransport(settings, google);
  const from = fromAddress(settings, google);
  if (!from) throw new Error('No From address. Connect Google or fill From.');
  const title = event.title || 'Trill Lookout Cam alert';
  const description = event.description || 'Activity was detected.';
  const when = event.createdAt ? new Date(event.createdAt).toLocaleString() : new Date().toLocaleString();
  const people = (event.people || []).join(', ') || 'none identified';
  const animals = (event.animals || []).join(', ') || 'none';
  const objects = (event.objects || []).join(', ') || 'none';
  const threats = threatLine(event);
  const watch = event.watchUrl || '';
  const attachments = [];
  if (files.gif && fs.existsSync(files.gif)) {
    attachments.push({ filename: 'clip.gif', path: files.gif, cid: 'lookoutgif' });
  }
  if (files.still && fs.existsSync(files.still)) {
    attachments.push({ filename: 'still.jpg', path: files.still, cid: 'lookoutstill' });
  }
  const html =
    '<div style="font-family:Georgia,serif;max-width:560px;color:#1b1e24">' +
    '<p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#5b8cff;margin:0 0 8px">Trill Lookout Cam</p>' +
    '<h1 style="font-size:22px;margin:0 0 12px">' +
    escapeHtml(title) +
    '</h1>' +
    (threats !== 'none'
      ? '<p style="display:inline-block;background:#ff6bb5;color:#fff;padding:4px 10px;border-radius:999px;font-size:12px;letter-spacing:.08em">' +
        escapeHtml(threats.toUpperCase()) +
        '</p>'
      : '') +
    '<p style="font-size:15px;line-height:1.55;margin:12px 0 14px">' +
    escapeHtml(description) +
    '</p>' +
    (files.gif
      ? '<p style="margin:0 0 14px"><img src="cid:lookoutgif" alt="10 second GIF" style="max-width:100%;border-radius:8px" /></p>'
      : files.still
        ? '<p style="margin:0 0 14px"><img src="cid:lookoutstill" alt="Still" style="max-width:100%;border-radius:8px" /></p>'
        : '') +
    '<table style="font-size:13px;color:#4b5563;border-collapse:collapse">' +
    '<tr><td style="padding:3px 12px 3px 0">When</td><td>' +
    escapeHtml(when) +
    '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0">Camera</td><td>' +
    escapeHtml(event.source || '') +
    '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0">Threat</td><td>' +
    escapeHtml(threats) +
    '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0">People</td><td>' +
    escapeHtml(people) +
    '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0">Animals</td><td>' +
    escapeHtml(animals) +
    '</td></tr>' +
    '<tr><td style="padding:3px 12px 3px 0">Also in scene</td><td>' +
    escapeHtml(objects) +
    '</td></tr>' +
    '</table>' +
    (watch ? '<p style="margin:16px 0 0"><a href="' + escapeHtml(watch) + '">Open this camera</a></p>' : '') +
    '<p style="font-size:12px;color:#9ca3af;margin:18px 0 0">A 10-second GIF is shown above and attached. Full video is on this Trill Lookout Cam DVR.</p>' +
    '</div>';

  await transport.sendMail({
    from,
    to,
    subject: title,
    text:
      description +
      '\n\nThreat: ' +
      threats +
      '\nPeople: ' +
      people +
      '\nAnimals: ' +
      animals +
      '\nAlso in scene: ' +
      objects +
      '\nWhen: ' +
      when +
      '\nCamera: ' +
      (event.source || '') +
      (watch ? '\nWatch: ' + watch : ''),
    html,
    attachments
  });
}

async function sendTest(settings, google) {
  const to = toAddress(settings, google);
  if (!to) throw new Error('Pick a notification email address (or Connect Google)');
  const transport = await makeTransport(settings, google);
  const from = fromAddress(settings, google);
  if (!from) throw new Error('No From address. Connect Google or fill From.');
  try {
    await transport.verify();
  } catch (err) {
    throw new Error('Mail server rejected the login: ' + (err.message || err));
  }
  await transport.sendMail({
    from,
    to,
    subject: 'Trill Lookout Cam — test alert',
    text: 'This is a test from Trill Lookout Cam. Real alerts include a 10-second GIF, a still, and a scene analysis.',
    html:
      '<p>This is a test from <strong>Trill Lookout Cam</strong>.</p><p>Real alerts include an inline 10-second GIF, the threat type (Fall / Theft / Fight), and a description of people and animals.</p>'
  });
}

module.exports = { publicSettings, applyPreset, sendAlert, sendTest, makeTransport, threatKind };
