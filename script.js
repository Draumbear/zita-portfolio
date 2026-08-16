document.getElementById('year').textContent = new Date().getFullYear();

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

let lightbox, lightboxImg;
function ensureLightbox() {
  if (lightbox) return;
  lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.innerHTML = '<button class="lightbox-close" aria-label="Close">&times;</button><img alt="">';
  document.body.appendChild(lightbox);
  lightboxImg = lightbox.querySelector('img');

  const closeLightbox = () => lightbox.classList.remove('open');
  lightbox.addEventListener('click', closeLightbox);
  lightboxImg.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

  // Delegated so it also covers images added after this point.
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.project-gallery img, .split-media img');
    if (!img) return;
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightbox.classList.add('open');
  });
}

window.initProjectInteractions = function initProjectInteractions() {
  document.querySelectorAll('.reveal:not([data-observed])').forEach(el => {
    el.setAttribute('data-observed', '');
    revealObserver.observe(el);
  });
  if (document.querySelector('.project-gallery img, .split-media img')) ensureLightbox();
};

window.initProjectInteractions();
