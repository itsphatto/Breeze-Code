// Breeze Code landing page: the timeline highlight, reveal on scroll, the copy button and screenshot zoom.
document.documentElement.classList.add('js');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Always open at the top: no restored scroll position from a reload or an earlier visit, unless the link names a section.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
if (!location.hash) window.scrollTo({ top: 0, behavior: 'instant' });



/* ----- Hero window: centred on screen while pinned, easing from 92% to full size as it arrives ----- */
const pin = $('.hero-pin');
const pinShot = $('.hero-shot', pin);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function placePin() {
  if (!pin) return;
  // The window sits dead centre of the screen, never higher than the 72px that clears the top bar.
  const h = $('.frame', pinShot).offsetHeight;
  pin.style.setProperty('--pin-top', `${Math.max(72, (window.innerHeight - h) / 2)}px`);
}
function scalePin() {
  // Once the city backdrop has dropped in, the window holds still like a picture.
  if (!pin || reduceMotion.matches || pinShot.classList.contains('locked')) return;
  const top = pinShot.getBoundingClientRect().top;
  const target = parseFloat(getComputedStyle(pin).getPropertyValue('--pin-top')) || 80;
  // 0 while the window is a screen below its pinned spot, 1 once it is there.
  const t = Math.min(1, Math.max(0, 1 - (top - target) / window.innerHeight));
  pin.style.setProperty('--pin-scale', (0.92 + 0.08 * t).toFixed(4));
}
placePin();
scalePin();
window.addEventListener('resize', () => { placePin(); scalePin(); });
window.addEventListener('scroll', () => requestAnimationFrame(scalePin), { passive: true });
$('img', pinShot)?.addEventListener('load', () => { placePin(); scalePin(); });
// The window is built after this script runs, so re-centre whenever its size settles.
if (pin) new ResizeObserver(placePin).observe($('.frame', pinShot));

/* ----- City backdrop: ripples out of black across the screen once the window locks in place, then stays as a
   full-width band behind the window and scrolls on with it ----- */
const stage = $('.city-stage');
const city = $('.city');
const rings = $('.city-rings');
const warpMap = $('#ripple-map');
let cityOn = false;
let warpRaf = 0;

function warp(ms, strength) {
  // Water-like refraction that settles as the ripple finishes.
  cancelAnimationFrame(warpRaf);
  city.classList.add('warp');
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    warpMap.setAttribute('scale', (strength * (1 - p) ** 2).toFixed(1));
    if (p < 1) warpRaf = requestAnimationFrame(step);
    else city.classList.remove('warp');
  };
  warpRaf = requestAnimationFrame(step);
}

const setVars = (el, vars) => Object.entries(vars).forEach(([k, v]) => el.style.setProperty(`--${k}`, `${v}px`));

function pinState() {
  const pinned = getComputedStyle(pinShot).position === 'sticky';
  const target = pinned ? parseFloat(getComputedStyle(pin).getPropertyValue('--pin-top')) || 80 : innerHeight * 0.5;
  return { pinned, target };
}

const heroCopy = $('.hero-copy');

// Where the window's figure sits on screen, without the slide of its reveal animation.
const figTop = () => pinShot.getBoundingClientRect().top - new DOMMatrix(getComputedStyle(pinShot).transform).m42;

function placeStage() {
  // Edge to edge across the screen. Pinned, it fills the screen around the locked window; on small screens
  // (no pinning) it is a band just taller than the window, so it never covers the next section.
  const { pinned, target } = pinState();
  const frame = $('.frame', pinShot);
  const pad = 32;
  const w = innerWidth, sx = -pinShot.getBoundingClientRect().left;
  const top = figTop();
  const bottom = pinned ? innerHeight - target : frame.offsetTop + frame.offsetHeight + pad;
  const fullTop = pinned ? -target : frame.offsetTop - pad;
  // The top never rises past the hero copy: it stops a gap below the buttons and chips.
  const sy = Math.max(fullTop, heroCopy.getBoundingClientRect().bottom - top + 72);
  const h = bottom - sy;
  // The picture keeps its full height and only its top is trimmed, so it never rescales while scrolling.
  setVars(stage, { sx, sy, sw: w, sh: h, ih: bottom - fullTop });
  // The drop stays on the middle of the window as the stage's top edge moves.
  const rx = frame.offsetLeft - sx + frame.offsetWidth / 2;
  const ry = Math.min(h, Math.max(0, frame.offsetTop - sy + frame.offsetHeight / 2));
  setVars(city, { rx, ry });
  setVars(rings, { rx, ry });
  return { w, h, rx, ry };
}

function showCity() {
  cityOn = true;
  pinShot.classList.add('in', 'locked'); // the backdrop lives in the window's figure, so it must not be mid-reveal
  pin.style.setProperty('--pin-scale', '1');
  const { w, h, rx, ry } = placeStage();
  const rmax = Math.hypot(Math.max(rx, w - rx), Math.max(ry, h - ry)) * 1.04;
  setVars(city, { rmax });
  setVars(rings, { rmax });
  city.classList.add('on');
  if (!reduceMotion.matches) {
    rings.classList.add('rip-out');
    warp(1500, 70);
  }
  // Once it has spread, drop the circle so a resize can never leave a corner uncovered.
  setTimeout(() => city.classList.add('full'), reduceMotion.matches ? 0 : 1700);
}

function updateCity() {
  if (!pin || !city || cityOn) return;
  const { target } = pinState();
  if (figTop() <= target + 1) showCity();
}
updateCity();
const onCityScroll = () => (cityOn ? placeStage() : updateCity());
window.addEventListener('resize', onCityScroll);
window.addEventListener('scroll', onCityScroll, { passive: true });

/* ----- Hero snap: one scroll gesture moves straight between the headline screen and the pinned window, so the
   half-way view in between is only ever seen in passing ----- */
const pinY = () => {
  // The scroll position at which the window reaches its pinned spot.
  const top = pin.getBoundingClientRect().top + scrollY + parseFloat(getComputedStyle(pinShot).marginTop);
  return Math.ceil(top - pinState().target);
};
let snapping = false;
let snapUntil = 0; // swallows the tail of trackpad momentum after a snap

function snapTo(y) {
  snapping = true;
  const y0 = scrollY, d = y - y0;
  const ms = reduceMotion.matches ? 0 : 750;
  const ease = p => (p < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
  const t0 = performance.now();
  const step = now => {
    const p = ms ? Math.min(1, (now - t0) / ms) : 1;
    window.scrollTo({ top: y0 + d * ease(p), behavior: 'instant' });
    if (p < 1) return requestAnimationFrame(step);
    snapping = false;
    snapUntil = performance.now() + 450;
  };
  requestAnimationFrame(step);
}

// True when the gesture was turned into a snap (or must be swallowed while one runs).
function heroSnap(dir) {
  if (!pin || !pinState().pinned) return false;
  if (snapping || performance.now() < snapUntil) return true;
  const end = pinY(), y = scrollY;
  if (dir > 0 && y < end - 1) { snapTo(end); return true; }
  if (dir < 0 && y > 1 && y <= end + 1) { snapTo(0); return true; }
  return false;
}

window.addEventListener('wheel', e => {
  if (e.ctrlKey || !e.deltaY) return; // pinch zoom
  const busy = snapping || performance.now() < snapUntil;
  // Scrolling up from further down: scroll normally until a step would carry the page back into the gap.
  if (!busy && e.deltaY < 0 && scrollY > pinY() + 1 && scrollY + e.deltaY > pinY()) return;
  if (heroSnap(Math.sign(e.deltaY))) e.preventDefault();
}, { passive: false });

let touchY = null;
window.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
window.addEventListener('touchmove', e => {
  if (touchY === null) return;
  const dy = touchY - e.touches[0].clientY;
  if (Math.abs(dy) < 8) return;
  if (heroSnap(Math.sign(dy))) { e.preventDefault(); touchY = null; }
}, { passive: false });
window.addEventListener('touchend', () => { touchY = null; }, { passive: true });

window.addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  const dir = { ArrowDown: 1, PageDown: 1, ' ': e.shiftKey ? -1 : 1, ArrowUp: -1, PageUp: -1 }[e.key];
  if (dir && heroSnap(dir)) e.preventDefault();
});

/* ----- Reveal on scroll ----- */
const reveal = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    reveal.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
$$('.reveal').forEach((el, i) => {
  // Neighbours in a grid come in one after another.
  const siblings = el.parentElement ? $$(':scope > .reveal', el.parentElement) : [];
  const k = siblings.indexOf(el);
  if (k > 0) el.style.transitionDelay = `${Math.min(k, 6) * 70}ms`;
  reveal.observe(el);
});

/* ----- Download backdrop ----- */
// The photo wipes in once a good part of the section is on screen, not as soon as its edge appears.
const downloadBg = $('.download-bg');
if (downloadBg) {
  const wipe = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    downloadBg.classList.add('in');
    wipe.disconnect();
  }, { threshold: 0.35 });
  wipe.observe(downloadBg);
}

// The footer's height is shared with the CSS so the download section can fill the screen above it.
const footerEl = $('.footer');
if (footerEl) {
  const shareFooterHeight = () => document.documentElement.style.setProperty('--footer-h', `${footerEl.offsetHeight}px`);
  shareFooterHeight();
  new ResizeObserver(shareFooterHeight).observe(footerEl);
}

/* ----- Latest release ----- */
// The version and installer size under the download button follow the newest GitHub release, and the download
// buttons point straight at its installer. The numbers and the releases-page links written in the page stay if
// GitHub can't be reached.
if ($('[data-release]') || $('[data-download]')) {
  fetch('https://api.github.com/repos/itsphatto/BreezeCode/releases/latest')
    .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(rel => {
      const exe = (rel.assets || []).find(a => a.name.endsWith('.exe'));
      $$('[data-release="version"]').forEach(el => { if (rel.tag_name) el.textContent = rel.tag_name; });
      $$('[data-release="size"]').forEach(el => { if (exe) el.textContent = `${Math.round(exe.size / 1048576)} MB`; });
      $$('[data-download]').forEach(el => { if (exe) el.href = exe.browser_download_url; });
    })
    .catch(() => {});
}

/* ----- Live memory readouts ----- */
// Each readout drifts to a new figure within its range, counting there, like a resource monitor.
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
$$('[data-mem]').forEach(el => {
  const [lo, hi] = el.dataset.mem.split('-').map(Number);
  let now = Math.round((lo + hi) / 2);
  const show = v => { el.textContent = `(${v.toLocaleString('en-US')} MB)`; };
  show(now);
  if (calm) return;
  const step = () => {
    const from = now, to = lo + Math.round(Math.random() * (hi - lo)), t0 = performance.now();
    const tick = t => {
      const p = Math.min((t - t0) / 900, 1);
      now = Math.round(from + (to - from) * (1 - (1 - p) ** 3));
      show(now);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(step, 1400 + Math.random() * 800);
  };
  step();
});

/* ----- Screenshot zoom ----- */
const zoom = $('#zoom');
const zoomImg = $('#zoom-img') || $('img', zoom);
const closeZoom = () => {
  if (zoom?.open) zoom.close();
};

$$('[data-zoom]').forEach(img => {
  img.tabIndex = 0;
  img.setAttribute('role', 'button');
  img.setAttribute('aria-haspopup', 'dialog');
  img.setAttribute('aria-label', `Enlarge screenshot: ${img.alt || 'Breeze Code preview'}`);
  const open = () => {
    if (zoomImg) {
      zoomImg.src = img.dataset.full || img.currentSrc || img.src; // crops open as the whole window
      zoomImg.alt = img.alt || 'Breeze Code preview';
    }
    zoom.showModal();
  };
  img.addEventListener('click', open);
  img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
});

$('.zoom-close', zoom)?.addEventListener('click', closeZoom);
zoom?.addEventListener('click', e => { if (e.target === zoom) closeZoom(); });

