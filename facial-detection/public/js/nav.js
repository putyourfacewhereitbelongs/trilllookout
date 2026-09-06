import { navLinks, currentNavId, appOrigin, absUrl } from './origin.js';

const ICONS = {
  live: '⌂',
  host: '◉',
  alerts: '!',
  videos: '▷',
  enroll: '+',
  cameras: '◎',
  settings: '⚙',
  share: '⎘'
};

export function mountNav(active, opts = {}) {
  const id = active || currentNavId();
  let el = document.getElementById('sidenav');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'sidenav';
    document.body.prepend(el);
  }
  el.classList.add('sidenav');
  document.body.classList.add('has-nav');

  let toggle = document.getElementById('navToggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'navToggle';
    toggle.className = 'nav-toggle btn';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Menu');
    toggle.textContent = 'Menu';
    document.body.appendChild(toggle);
    toggle.onclick = () => document.body.classList.toggle('nav-open');
  }

  const links = navLinks()
    .map((l) => {
      const on = l.id === id ? ' on' : '';
      const ico = ICONS[l.id] || '·';
      return `<a class="nav-link${on}" data-nav="${l.id}" href="${l.href}"><span class="nav-ico" aria-hidden="true">${ico}</span><span class="nav-copy"><span class="nav-label">${l.label}</span><span class="nav-hint">${l.hint}</span></span></a>`;
    })
    .join('');
  el.innerHTML = `
    <a class="nav-brand" href="${appOrigin()}/">
      <img class="nav-logo" src="/icons/icon-192.png" width="40" height="40" alt="">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <div class="brand-name">Trill Lookout AI Cam</div>
        <div class="nav-sub">Live cameras · faces · DVR</div>
      </div>
    </a>
    <nav class="nav-links">${links}</nav>
    <div class="nav-foot">
      <button type="button" class="btn tiny ghost" id="navShare">Share by QR</button>
      <div class="nav-origin" title="This origin updates when you host on a domain">${appOrigin()}</div>
    </div>`;
  const btn = el.querySelector('#navShare');
  if (btn) {
    btn.onclick = () => {
      if (opts.keepHost) {
        openHostDrawer(absUrl('/share.html'));
        return;
      }
      window.location.href = absUrl('/share.html');
    };
  }
  if (opts.keepHost) {
    el.querySelectorAll('a.nav-link, a.nav-brand').forEach((a) => {
      a.addEventListener('click', (e) => {
        const nav = a.getAttribute('data-nav');
        if (!nav || nav === 'host') return;
        if (nav === 'live') {
          e.preventDefault();
          window.open(a.href, 'lookout-live');
          return;
        }
        e.preventDefault();
        openHostDrawer(a.href);
        document.body.classList.remove('nav-open');
      });
    });
  }
  return el;
}

export function openHostDrawer(href) {
  let drawer = document.getElementById('hostDrawer');
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'hostDrawer';
    drawer.className = 'host-drawer';
    drawer.innerHTML =
      '<button type="button" class="btn tiny drawer-close" id="drawerClose">Close</button><iframe title="Lookout page" allow="camera; microphone; display-capture; fullscreen; autoplay"></iframe>';
    document.body.appendChild(drawer);
    drawer.querySelector('#drawerClose').onclick = () => drawer.classList.remove('open');
  }
  const frame = drawer.querySelector('iframe');
  frame.setAttribute('allow', 'camera; microphone; display-capture; fullscreen; autoplay');
  frame.src = href;
  drawer.classList.add('open');
}

export function bindOriginAwareAnchors(root) {
  const scope = root || document;
  scope.querySelectorAll('a[data-abs]').forEach((a) => {
    const path = a.getAttribute('data-abs') || a.getAttribute('href') || '/';
    a.href = absUrl(path);
  });
}
