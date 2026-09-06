/** Auto-tune Lookout for the machine it is running on. */

const KEY = 'lookout_perf';

const PROFILES = {
  high: {
    level: 'high',
    camWidth: 1280,
    camHeight: 720,
    camFps: 15,
    detectMaxWidth: 720,
    tinyInput: 416,
    tinyFirst: false,
    skipSsd: false,
    skipAgeGender: false,
    skipPersonCrops: false,
    maxPersonCrops: 3,
    minDetectMs: 180,
    drawMs: 50,
    overlayNative: false,
    skipSharpness: false,
    snapFullFallback: true,
    nvrMs: 160,
    ringEvery: 1,
    gifW: 320,
    gifFps: 5,
    gifColors: 128,
    cocoW: 400,
    cocoEvery: 1,
    moonMs: 4000,
    skipLocalVision: false,
    publishMs: 220,
    publishW: 560,
    publishQ: 0.52,
    recBps: 1200000,
    preferVp8: false,
    thumbMs: 500,
    facesMs: 5000,
    nvMax: 480,
    nvSkip: 1,
    motionW: 160,
    motionH: 90,
    motionGrid: 32
  },
  mid: {
    level: 'mid',
    camWidth: 960,
    camHeight: 540,
    camFps: 12,
    detectMaxWidth: 512,
    tinyInput: 320,
    tinyFirst: true,
    skipSsd: false,
    skipAgeGender: true,
    skipPersonCrops: false,
    maxPersonCrops: 2,
    minDetectMs: 280,
    drawMs: 80,
    overlayNative: false,
    skipSharpness: true,
    snapFullFallback: false,
    nvrMs: 220,
    ringEvery: 2,
    gifW: 240,
    gifFps: 4,
    gifColors: 96,
    cocoW: 320,
    cocoEvery: 2,
    moonMs: 7000,
    skipLocalVision: true,
    publishMs: 400,
    publishW: 480,
    publishQ: 0.48,
    recBps: 800000,
    preferVp8: true,
    thumbMs: 750,
    facesMs: 8000,
    nvMax: 320,
    nvSkip: 2,
    motionW: 128,
    motionH: 72,
    motionGrid: 16
  },
  low: {
    level: 'low',
    camWidth: 640,
    camHeight: 360,
    camFps: 10,
    detectMaxWidth: 512,
    tinyInput: 416,
    tinyFirst: true,
    skipSsd: true,
    skipAgeGender: true,
    skipPersonCrops: false,
    maxPersonCrops: 1,
    minDetectMs: 400,
    drawMs: 110,
    overlayNative: false,
    skipSharpness: true,
    snapFullFallback: false,
    nvrMs: 280,
    ringEvery: 3,
    gifW: 200,
    gifFps: 3,
    gifColors: 64,
    cocoW: 256,
    cocoEvery: 3,
    moonMs: 10000,
    skipLocalVision: true,
    publishMs: 700,
    publishW: 360,
    publishQ: 0.42,
    recBps: 500000,
    preferVp8: true,
    thumbMs: 1000,
    facesMs: 10000,
    nvMax: 240,
    nvSkip: 3,
    motionW: 96,
    motionH: 54,
    motionGrid: 12
  }
};

let cached = null;
let slowHits = 0;

function hardwareLevel() {
  try {
    if (typeof localStorage !== 'undefined') {
      const forced = String(localStorage.getItem(KEY) || '').toLowerCase();
      if (PROFILES[forced]) return forced;
    }
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const cores = Number(nav.hardwareConcurrency) || 4;
  const mem = Number(nav.deviceMemory) || 4;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  const saveData = !!(conn && conn.saveData);
  const slowNet = !!(conn && /2g/.test(String(conn.effectiveType || '')));
  let reduced = false;
  try {
    reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    reduced = false;
  }
  if (cores <= 2 || mem <= 2 || slowNet) return 'low';
  if (cores <= 4 || mem <= 4 || saveData || reduced) return 'mid';
  return 'high';
}

export function getPerf() {
  if (cached) return cached;
  cached = { ...PROFILES[hardwareLevel()] };
  return cached;
}

export function noteDetectMs(ms) {
  const p = getPerf();
  if (ms > 550) slowHits += 1;
  else if (ms < 160) slowHits = Math.max(0, slowHits - 1);
  if (slowHits >= 5 && p.level !== 'low') {
    cached = { ...PROFILES.low };
    slowHits = 0;
    try {
      sessionStorage.setItem(KEY + '_auto', 'low');
    } catch {
      /* ignore */
    }
  }
}

export function perfLabel() {
  const p = getPerf();
  if (p.level === 'low') return 'Low-power mode — lighter AI for this device';
  if (p.level === 'mid') return 'Balanced mode — tuned for this device';
  return '';
}
