document.getElementById('year').textContent = new Date().getFullYear();

// Site-wide accent color, set from the dashboard (data/site.json's
// accentColor). Runs on every page (this file is shared by index.html,
// project.html, and the legacy project pages) so a color picked once in
// the Site & Bio tab applies everywhere without editing CSS by hand.
// Falls back silently to styles.css's built-in --accent if unset or the
// fetch fails (e.g. opened from disk without a server).
function darkenHex(hex, amount) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const [r, g, b] = [1, 2, 3].map(i => clamp(Math.round(parseInt(m[i], 16) * (1 - amount))));
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
fetch('data/site.json?_=' + Date.now(), { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(site => {
    if (site && site.accentColor) {
      document.documentElement.style.setProperty('--accent', site.accentColor);
      document.documentElement.style.setProperty('--accent-dark', darkenHex(site.accentColor, 0.22));
    }
  })
  .catch(() => {});

// Graceful fallback for images blocked by the original host's hotlink protection
// (delegated so it also covers cards added dynamically by site-data.js)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG') {
    const wrap = img.closest('.card-img, .about-img');
    if (wrap) wrap.classList.add('img-fallback');
  }
}, true);

const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => navLinks.classList.remove('open'));
});

document.querySelectorAll('a[href="#top"]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// Highlight active nav link on scroll
const sections = document.querySelectorAll('main section[id], .hero');
const navA = document.querySelectorAll('.nav-links a');

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.id || 'top';
      navA.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + id);
      });
    }
  });
}, { rootMargin: '-40% 0px -55% 0px' });

document.querySelectorAll('section[id]').forEach(s => observer.observe(s));

// Contact form (static demo — no backend)
const form = document.getElementById('contactForm');
const note = document.getElementById('formNote');

if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    note.textContent = "Thanks for reaching out! This form isn't wired up to a server yet — feel free to email zita.decoopman@gmail.com directly.";
    form.reset();
  });
}

// Scroll-reveal + lightbox for project pages.
// Exposed as window.initProjectInteractions() so pages that inject their
// content dynamically (see project-render.js) can (re)run this after
// the markup lands in the DOM. Safe to call more than once.
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });

// Images the lightbox can select from — a picture, a gallery photo, or a
// group's media image counts, whichever page built the markup (rendered by
// project-render.js, or hand-authored on the older custom pages).
const LIGHTBOX_IMG_SELECTOR = '.lightbox-img, .project-gallery img, .split-media img';

let lightbox, lightboxImg, lightboxPrevBtn, lightboxNextBtn, lightboxCounter;
let lightboxImages = [];
let lightboxIndex = 0;

function showLightboxImage(idx) {
  lightboxIndex = (idx + lightboxImages.length) % lightboxImages.length;
  const img = lightboxImages[lightboxIndex];
  lightboxImg.src = img.src;
  lightboxImg.alt = img.alt;
  const multi = lightboxImages.length > 1;
  lightboxPrevBtn.style.display = multi ? '' : 'none';
  lightboxNextBtn.style.display = multi ? '' : 'none';
  lightboxCounter.textContent = multi ? `${lightboxIndex + 1} / ${lightboxImages.length}` : '';
}

function ensureLightbox() {
  if (lightbox) return;
  lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.innerHTML = `
    <button class="lightbox-close" aria-label="Close">&times;</button>
    <button class="lightbox-nav lightbox-prev" aria-label="Previous photo">&#8249;</button>
    <img alt="">
    <button class="lightbox-nav lightbox-next" aria-label="Next photo">&#8250;</button>
    <span class="lightbox-counter"></span>
  `;
  document.body.appendChild(lightbox);
  lightboxImg = lightbox.querySelector('img');
  lightboxPrevBtn = lightbox.querySelector('.lightbox-prev');
  lightboxNextBtn = lightbox.querySelector('.lightbox-next');
  lightboxCounter = lightbox.querySelector('.lightbox-counter');

  const closeLightbox = () => lightbox.classList.remove('open');
  const goPrev = () => showLightboxImage(lightboxIndex - 1);
  const goNext = () => showLightboxImage(lightboxIndex + 1);

  lightbox.addEventListener('click', closeLightbox);
  [lightboxImg, lightboxPrevBtn, lightboxNextBtn, lightboxCounter].forEach(el => el.addEventListener('click', (e) => e.stopPropagation()));
  lightboxPrevBtn.addEventListener('click', goPrev);
  lightboxNextBtn.addEventListener('click', goNext);
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') goPrev();
    if (e.key === 'ArrowRight') goNext();
  });

  // Swipe left/right to navigate on touch devices.
  let touchStartX = null;
  lightbox.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) (dx < 0 ? goNext : goPrev)();
    touchStartX = null;
  }, { passive: true });

  // Delegated so it also covers images added after this point.
  document.addEventListener('click', (e) => {
    const img = e.target.closest(LIGHTBOX_IMG_SELECTOR);
    if (!img) return;
    // "That section" = the enclosing band (the colored block between Title
    // blocks) — swiping/clicking through moves among photos grouped there,
    // not every photo on the whole project page.
    const scope = img.closest('.band') || document;
    lightboxImages = Array.from(scope.querySelectorAll(LIGHTBOX_IMG_SELECTOR));
    showLightboxImage(lightboxImages.indexOf(img));
    lightbox.classList.add('open');
  });
}

window.initProjectInteractions = function initProjectInteractions() {
  document.querySelectorAll('.reveal:not([data-observed])').forEach(el => {
    el.setAttribute('data-observed', '');
    revealObserver.observe(el);
  });
  if (document.querySelector(LIGHTBOX_IMG_SELECTOR)) ensureLightbox();
};

window.initProjectInteractions();
