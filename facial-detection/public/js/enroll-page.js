import { mountNav } from './nav.js';
import { describeImage } from './engine.js';
import { setupInstall } from './install.js';
import { getPerf } from './perf.js';

mountNav('enroll');
setupInstall();

const video = document.getElementById('enrollCam');
const shotsEl = document.getElementById('shots');
const shots = [];
let stream = null;
let useEnv = false;

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function startCam() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: useEnv ? { ideal: 'environment' } : { ideal: 'user' },
      width: { ideal: getPerf().camWidth || 1280 },
      height: { ideal: getPerf().camHeight || 720 },
      frameRate: { ideal: getPerf().camFps || 15, max: 24 }
    }
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
}

document.getElementById('btnStartCam').onclick = () => startCam().catch((e) => toast(e.message, 'err'));
document.getElementById('btnFlip').onclick = () => {
  useEnv = !useEnv;
  startCam().catch((e) => toast(e.message, 'err'));
};
document.getElementById('btnTake').onclick = () => {
  if (!video.videoWidth) return toast('Start the camera first', 'err');
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  c.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], 'enroll-' + shots.length + '.jpg', { type: 'image/jpeg' });
    shots.push(file);
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    shotsEl.appendChild(img);
  }, 'image/jpeg', 0.92);
};

document.getElementById('enrollSave').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const name = String(fd.get('name') || '').trim();
  if (!name) return toast('Name is required', 'err');
  if (!shots.length) return toast('Take at least one photo', 'err');
  try {
    if (window.faceapi) {
      const loads = [
        faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models')
      ];
      if (!getPerf().skipSsd) loads.unshift(faceapi.nets.ssdMobilenetv1.loadFromUri('/models'));
      await Promise.all(loads);
    }
    const personRes = await fetch('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        notes: fd.get('notes') || '',
        relationship: fd.get('relationship') || '',
        phone: fd.get('phone') || ''
      })
    });
    const person = await personRes.json();
    if (!personRes.ok) throw new Error(person.error || 'Could not create person');
    const descriptors = [];
    const kept = [];
    for (const file of shots) {
      let desc = null;
      try {
        desc = await describeImage(file);
      } catch {
        desc = null;
      }
      if (!desc) {
        toast('No face in one shot — skipped', 'err');
        continue;
      }
      descriptors.push(desc.descriptor);
      kept.push(file);
    }
    if (!kept.length) throw new Error('No usable faces in those photos');
    const body = new FormData();
    kept.forEach((f) => body.append('photos', f));
    body.append('descriptors', JSON.stringify(descriptors));
    const up = await fetch('/api/people/' + person.id + '/photos', { method: 'POST', body });
    const data = await up.json();
    if (!up.ok) throw new Error(data.error || 'Upload failed');
    toast('Saved ' + name);
    e.target.reset();
    shots.length = 0;
    shotsEl.innerHTML = '';
  } catch (err) {
    toast(err.message, 'err');
  }
};

if (document.getElementById('animalSave')) {
  document.getElementById('animalSave').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    if (!name) return toast('Name is required', 'err');
    try {
      const body = new FormData();
      body.append('name', name);
      body.append('species', fd.get('species') || 'cat');
      if (shots.length) body.append('photos', shots[shots.length - 1]);
      const res = await fetch('/api/animals', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save animal');
      toast('Named ' + name);
      e.target.reset();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

startCam().catch(() => {});
