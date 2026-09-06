const STEPS = [
  {
    title: 'Host computer',
    body: 'This machine is the host. Click “Use this screen as a camera” (or this device’s camera). Detection, DVR, and alerts run here. Other phones and PCs only need the Live cameras page.'
  },
  {
    title: 'Live cameras page',
    body: 'Open Live cameras from the sidebar — it looks like a real camera wall, not a shared screen. Share that link over LAN or your domain. URLs always match whatever origin you opened.'
  },
  {
    title: 'People and animals record',
    body: 'Video is saved when a person or animal is in view, and again if a fall, theft, or fight is labeled. Motion alone does not start a recording.'
  },
  {
    title: 'Alerts + GIF + ding',
    body: 'A unique trill chime plays (not the system notification sound). The Alerts dock shows a 10-second GIF of what happened, with the threat type labeled.'
  },
  {
    title: 'Email from Gmail',
    body: 'In Settings, paste a Google OAuth client once, then Connect Google. Alerts email a GIF plus a still and a written scene analysis from that Gmail.'
  },
  {
    title: 'IP and Wyze cameras',
    body: 'Settings → Cameras can scan the LAN. Test a link — if the PIP preview opens, Save appears. Use HTTP snapshot or MJPEG URLs (not raw RTSP).'
  },
  {
    title: 'Enroll a face',
    body: 'Enroll face uses this device’s camera. Take a few photos, add a name and profile notes, then save. Known people are labeled live on the host.'
  },
  {
    title: 'Snap and record',
    body: 'On the host, Snap saves a still to the DVR. Record starts a manual clip. Both land in Videos on this machine.'
  }
];

export function startTutorial({ force } = {}) {
  if (!force && localStorage.getItem('lookout_tutorial_done')) return;
  show(0);
}

export function replayTutorial() {
  localStorage.removeItem('lookout_tutorial_done');
  startTutorial({ force: true });
}

function show(index) {
  let overlay = document.getElementById('tutorialOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tutorialOverlay';
    overlay.className = 'tutorial-overlay';
    document.body.appendChild(overlay);
  }
  const step = STEPS[index];
  if (!step) {
    overlay.remove();
    localStorage.setItem('lookout_tutorial_done', '1');
    return;
  }
  overlay.innerHTML = `<div class="tutorial-card">
    <p class="muted small">Tutorial ${index + 1} / ${STEPS.length}</p>
    <h2>${step.title}</h2>
    <p>${step.body}</p>
    <div class="row-btns">
      <button type="button" class="btn ghost" data-act="skip">Skip</button>
      <button type="button" class="btn" data-act="back" ${index === 0 ? 'disabled' : ''}>Back</button>
      <button type="button" class="btn primary" data-act="next">${index === STEPS.length - 1 ? 'Done' : 'Next'}</button>
    </div>
  </div>`;
  overlay.onclick = (e) => {
    if (e.target === overlay) return;
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'skip') {
      localStorage.setItem('lookout_tutorial_done', '1');
      overlay.remove();
    } else if (act === 'next') show(index + 1);
    else if (act === 'back') show(Math.max(0, index - 1));
  };
}
