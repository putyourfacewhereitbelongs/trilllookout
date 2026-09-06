'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'openid'].join(' ');

function createGoogleOAuth(root) {
  const file = path.join(root, 'data', 'nvr', 'google.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = load(file);
  if (!state.clientId && process.env.GOOGLE_CLIENT_ID) {
    state.clientId = String(process.env.GOOGLE_CLIENT_ID).trim();
    if (process.env.GOOGLE_CLIENT_SECRET) state.clientSecret = String(process.env.GOOGLE_CLIENT_SECRET).trim();
  }

  function save() {
    atomic(file, {
      clientId: state.clientId || '',
      clientSecret: state.clientSecret || '',
      refreshToken: state.refreshToken || '',
      accessToken: state.accessToken || '',
      expiresAt: state.expiresAt || 0,
      email: state.email || ''
    });
  }

  function publicStatus() {
    return {
      configured: Boolean(state.clientId && state.clientSecret),
      connected: Boolean(state.refreshToken),
      email: state.email || '',
      clientIdSet: Boolean(state.clientId)
    };
  }

  function setClient({ clientId, clientSecret }) {
    if (clientId != null) state.clientId = String(clientId).trim();
    if (clientSecret != null && String(clientSecret).trim()) state.clientSecret = String(clientSecret).trim();
    save();
    return publicStatus();
  }

  function authUrl(redirectUri) {
    if (!state.clientId || !state.clientSecret) {
      throw new Error('Set a Google OAuth client ID and secret first (Settings → paste both, Save client, then Connect Google). Redirect URI must be exactly: ' + redirectUri);
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    state.pendingNonce = nonce;
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', state.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', nonce);
    return u.toString();
  }

  async function handleCallback(code, redirectUri) {
    if (!code) throw new Error('Missing Google auth code');
    const body = new URLSearchParams({
      code,
      client_id: state.clientId,
      client_secret: state.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
    if (data.refresh_token) state.refreshToken = data.refresh_token;
    state.accessToken = data.access_token || '';
    state.expiresAt = Date.now() + Number(data.expires_in || 3500) * 1000;
    const email = await fetchEmail(state.accessToken);
    if (email) state.email = email;
    save();
    return { email: state.email, connected: true };
  }

  async function accessToken() {
    if (!state.refreshToken) throw new Error('Google is not connected');
    if (state.accessToken && Date.now() < Number(state.expiresAt || 0) - 30000) return state.accessToken;
    const body = new URLSearchParams({
      client_id: state.clientId,
      client_secret: state.clientSecret,
      refresh_token: state.refreshToken,
      grant_type: 'refresh_token'
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Google token refresh failed');
    state.accessToken = data.access_token;
    state.expiresAt = Date.now() + Number(data.expires_in || 3500) * 1000;
    save();
    return state.accessToken;
  }

  function credentialsForMail() {
    if (!state.refreshToken) return null;
    return {
      type: 'OAuth2',
      user: state.email,
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      refreshToken: state.refreshToken
    };
  }

  function disconnect() {
    state.refreshToken = '';
    state.accessToken = '';
    state.expiresAt = 0;
    state.email = '';
    save();
    return publicStatus();
  }

  function email() {
    return state.email || '';
  }

  return { publicStatus, setClient, authUrl, handleCallback, accessToken, credentialsForMail, disconnect, email };
}

async function fetchEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    const data = await res.json();
    return data.email || '';
  } catch {
    return '';
  }
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function atomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { createGoogleOAuth };
