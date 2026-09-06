let audio;
let unlocked = false;

export function unlockDing() {
  if (unlocked) return;
  unlocked = true;
  try {
    const a = getAudio();
    a.volume = 0.01;
    a.play().then(() => {
      a.pause();
      a.currentTime = 0;
      a.volume = 0.86;
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function getAudio() {
  if (!audio) {
    audio = new Audio('/sounds/alert.wav');
    audio.preload = 'auto';
    audio.volume = 0.86;
  }
  return audio;
}

/** Distinct two-peak “trill” chime — not the OS / browser notification ding. */
export function playAlertDing() {
  try {
    const a = getAudio();
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => synthDing());
  } catch {
    synthDing();
  }
}

export function playFaultBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 420;
    g.gain.value = 0.04;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.frequency.value = 310;
    }, 90);
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, 220);
  } catch {
    /* ignore */
  }
}

function synthDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    tone(ctx, master, 1174.7, now, 0.09);
    tone(ctx, master, 1568.0, now + 0.12, 0.09);
    tone(ctx, master, 2349.3, now + 0.24, 0.16);
    tone(ctx, master, 880.0, now + 0.46, 0.2);
    setTimeout(() => ctx.close(), 900);
  } catch {
    /* ignore */
  }
}

function tone(ctx, dest, freq, start, dur) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.9, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g);
  g.connect(dest);
  o.start(start);
  o.stop(start + dur + 0.02);
}

document.addEventListener('pointerdown', unlockDing, { once: true });
document.addEventListener('keydown', unlockDing, { once: true });
