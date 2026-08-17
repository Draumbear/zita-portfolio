document.getElementById('year').textContent = new Date().getFullYear();

// Site-wide settings driven by the dashboard's Site & Bio tab (data/site.json):
// accent color, background color, footer social links, portfolio category
// headings, and default social-preview (Open Graph) tags. Runs on every page
// (this file is shared
// by index.html, project.html, the legacy project pages, and 404.html) so
// these apply everywhere without editing HTML/CSS by hand. Falls back
// silently to whatever's already in the static HTML if the fetch fails
// (e.g. opened from disk without a server) or a field is unset.
function darkenHex(hex, amount) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const [r, g, b] = [1, 2, 3].map(i => clamp(Math.round(parseInt(m[i], 16) * (1 - amount))));
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// Minimal inline icon set (no icon-font/CDN dependency) — currentColor so
// they pick up .social-links' link color automatically, hover included.
const SOCIAL_ICONS = {
  instagram: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.9 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V23h-4V8zM8.5 8h3.8v2.05h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V23h-4v-6.9c0-1.65-.03-3.77-2.3-3.77-2.3 0-2.65 1.8-2.65 3.65V23h-4V8z"/></svg>',
  behance: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.8 10.6c1.4-.6 2.1-1.7 2.1-3.2 0-2.7-2-3.9-4.6-3.9H0v16h5.5c2.9 0 5.4-1.4 5.4-4.4 0-1.9-1-3.1-3.1-4.5zM3 6.2h2.2c1.1 0 2 .4 2 1.6 0 1.1-.8 1.7-2 1.7H3V6.2zm2.5 10.4H3v-3.9h2.6c1.4 0 2.3.6 2.3 1.9 0 1.4-1 2-2.4 2zM24 13.4c0-3.5-2-6-5.6-6-3.5 0-5.9 2.6-5.9 6.1 0 3.6 2.3 6 6 6 2.7 0 4.6-1.2 5.4-3.5h-2.8c-.3.8-1.2 1.3-2.5 1.3-1.8 0-2.8-1-2.9-2.7h8.2c0-.4.1-.8.1-1.2zm-8.3-1.3c.2-1.4 1.1-2.3 2.6-2.3 1.4 0 2.3 1 2.4 2.3h-5zM14.5 5h7v1.7h-7z"/></svg>'
};
const SOCIAL_LABELS = { instagram: 'Instagram', linkedin: 'LinkedIn', behance: 'Behance' };

function renderSocialLinks(social) {
  const wrap = document.getElementById('socialLinks');
  if (!wrap || !social) return;
  const html = Object.keys(SOCIAL_ICONS)
    .filter(key => social[key])
    .map(key => `<a href="${social[key]}" target="_blank" rel="noopener" aria-label="${SOCIAL_LABELS[key]}" title="${SOCIAL_LABELS[key]}">${SOCIAL_ICONS[key]}</a>`)
    .join('');
  wrap.innerHTML = html;
  wrap.classList.toggle('hidden', !html);
}

fetch('data/site.json?_=' + Date.now(), { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(site => {
    if (!site) return;
    if (site.accentColor) {
      document.documentElement.style.setProperty('--accent', site.accentColor);
      document.documentElement.style.setProperty('--accent-dark', darkenHex(site.accentColor, 0.22));
    }
    if (site.backgroundColor) {
      // --cream-2 is the alternating-band/card tint used throughout — a
      // subtly darker shade of the main background, not a separate pick.
      document.documentElement.style.setProperty('--cream', site.backgroundColor);
      document.documentElement.style.setProperty('--cream-2', darkenHex(site.backgroundColor, 0.03));
    }
    renderSocialLinks(site.social);

    if (site.groupLabels) {
      const fashion = document.getElementById('groupTitleFashion');
      const personal = document.getElementById('groupTitlePersonal');
      if (fashion && site.groupLabels['fashion-technology']) fashion.textContent = site.groupLabels['fashion-technology'];
      if (personal && site.groupLabels['personal']) personal.textContent = site.groupLabels['personal'];
    }

    // Default social-preview tags — pages with their own dynamic content
    // (project.html via project-render.js) override these once loaded.
    const setMeta = (id, val) => { const el = document.getElementById(id); if (el && val) el.setAttribute('content', val); };
    if (site.heroName && site.aboutParagraphs && site.aboutParagraphs[0]) {
      setMeta('ogTitle', `${site.heroName.replace(/<br>/g, ' ')} — Portfolio`);
      setMeta('ogDescription', site.aboutParagraphs[0]);
      setMeta('metaDescription', site.aboutParagraphs[0]);
    }
    if (site.aboutPhoto && site.aboutPhoto.src) setMeta('ogImage', site.aboutPhoto.src);
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

// Small "View Project" pill that follows the cursor while hovering a
// portfolio card, instead of a static hover state. Desktop-with-mouse only
// (no persistent cursor on touch, and reduced-motion users get no motion
// effect at all). Uses event delegation on document rather than binding to
// each .card directly, because site-data.js replaces the grid's DOM after
// its own async fetch resolves — delegated listeners survive that; ones
// bound to the original elements wouldn't.
(function initCursorFollow() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const pill = document.createElement('div');
  pill.className = 'cursor-follow';
  pill.textContent = 'View Project';
  pill.setAttribute('aria-hidden', 'true');

  let active = false, appended = false, raf = null;
  let curX = 0, curY = 0, targetX = 0, targetY = 0;

  function loop() {
    curX += (targetX - curX) * 0.25;
    curY += (targetY - curY) * 0.25;
    pill.style.transform = `translate(${curX}px, ${curY}px) translate(-50%, -50%) scale(${active ? 1 : 0.6})`;
    if (active || Math.abs(targetX - curX) > 0.5 || Math.abs(targetY - curY) > 0.5) {
      raf = requestAnimationFrame(loop);
    } else {
      raf = null;
    }
  }

  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    if (!appended) { document.body.appendChild(pill); appended = true; }
    active = true;
    targetX = curX = e.clientX;
    targetY = curY = e.clientY;
    pill.classList.add('visible');
    if (!raf) raf = requestAnimationFrame(loop);
  });
  document.addEventListener('mousemove', (e) => {
    if (!active) return;
    targetX = e.clientX;
    targetY = e.clientY;
  });
  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.card');
    if (!card || (e.relatedTarget && card.contains(e.relatedTarget))) return;
    active = false;
    pill.classList.remove('visible');
    if (!raf) raf = requestAnimationFrame(loop);
  });
})();

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
