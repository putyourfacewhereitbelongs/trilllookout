const CAPTURE_KEY = 'lookout_capture';
const HOST_KEY = 'lookout_host_origin';
const CAMS_KEY = 'lookout_watch_cams';
const MUTE_KEY = 'lookout_mute_until';
const ROLE_KEY = 'lookout_role';
const DEVICE_ID_KEY = 'lookout_device_cam_id';
const DEVICE_NAME_KEY = 'lookout_device_cam_name';
const DEVICE_PUB_KEY = 'lookout_device_publish';

export function saveCapture(partial) {
  const cur = loadCapture();
  try {
    localStorage.setItem(CAPTURE_KEY, JSON.stringify({ ...cur, ...partial, updated: Date.now() }));
  } catch {
    /* quota */
  }
}

export function loadCapture() {
  try {
    return JSON.parse(localStorage.getItem(CAPTURE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function rememberHostOrigin() {
  try {
    if (!localStorage.getItem(HOST_KEY)) localStorage.setItem(HOST_KEY, location.origin);
    localStorage.setItem(HOST_KEY, location.origin);
  } catch {
    /* ignore */
  }
}

export function hostOrigin() {
  try {
    return localStorage.getItem(HOST_KEY) || location.origin;
  } catch {
    return location.origin;
  }
}

export function saveWatchCams(ids) {
  try {
    localStorage.setItem(CAMS_KEY, JSON.stringify(ids || []));
  } catch {
    /* ignore */
  }
}

export function loadWatchCams() {
  try {
    const v = JSON.parse(localStorage.getItem(CAMS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function muteUntil(ms) {
  try {
    localStorage.setItem(MUTE_KEY, String(Date.now() + (ms || 30 * 60 * 1000)));
  } catch {
    /* ignore */
  }
}

export function isMuted() {
  try {
    return Date.now() < Number(localStorage.getItem(MUTE_KEY) || 0);
  } catch {
    return false;
  }
}

export function setRole(role) {
  try {
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    /* ignore */
  }
}

export function getRole() {
  try {
    return localStorage.getItem(ROLE_KEY) || '';
  } catch {
    return '';
  }
}

export function deviceCamId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = 'device-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : String(Date.now()));
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return 'device-' + String(Date.now());
  }
}

export function deviceCamName() {
  try {
    const saved = localStorage.getItem(DEVICE_NAME_KEY);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const plat = (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent || '')) || 'Device';
  return String(plat).slice(0, 28) + ' camera';
}

export function setDeviceCamName(name) {
  try {
    if (name) localStorage.setItem(DEVICE_NAME_KEY, String(name).slice(0, 80));
  } catch {
    /* ignore */
  }
}

export function setDevicePublishing(on) {
  try {
    localStorage.setItem(DEVICE_PUB_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function shouldDevicePublish() {
  try {
    return localStorage.getItem(DEVICE_PUB_KEY) === '1';
  } catch {
    return false;
  }
}
