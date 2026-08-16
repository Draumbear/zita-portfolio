// Renders index.html's editable content (bio, photo, CV, portfolio grid)
// from data/site.json and data/projects-index.json. If the fetch fails
// (e.g. opened directly from disk without a server) the static HTML
// already in the page is left as-is, so the page still works.

function cardHTML(project) {
  const img = project.thumbnail || {};
  return `
    <a class="card" href="${project.href}">
      <div class="card-img">
        <img src="${img.src || ''}" alt="${img.alt || project.title}" loading="lazy">
      </div>
      <h4>${project.title}</h4>
    </a>`;
}

fetch('data/site.json?_=' + Date.now(), { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(site => {
    if (!site) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.textContent = val; };

    set('heroEyebrow', site.heroEyebrow);
    set('heroSub', site.heroSub);
    set('aboutEyebrow', site.aboutEyebrow);
    set('aboutHeading', site.aboutHeading);
    set('aboutCaption', site.aboutCaption);
    set('contactName', site.contactName);

    if (site.heroName) {
      const heroName = document.getElementById('heroName');
      if (heroName) heroName.innerHTML = site.heroName.replace(/\n/g, '<br>');
    }

    if (site.aboutPhoto && site.aboutPhoto.src) {
      const img = document.getElementById('aboutPhoto');
      if (img) { img.src = site.aboutPhoto.src; img.alt = site.aboutPhoto.alt || ''; }
    }

    if (Array.isArray(site.aboutParagraphs)) {
      const wrap = document.getElementById('aboutParagraphs');
      if (wrap) wrap.innerHTML = site.aboutParagraphs.map(p => `<p>${p}</p>`).join('');
    }

    if (site.cvUrl) {
      const cv = document.getElementById('cvLink');
      if (cv) cv.href = site.cvUrl;
    }

    if (site.contactEmail) {
      const email = document.getElementById('contactEmail');
      if (email) { email.textContent = site.contactEmail; email.href = 'mailto:' + site.contactEmail; }
    }
  })
  .catch(() => {});

fetch('data/projects-index.json?_=' + Date.now(), { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(projects => {
    if (!Array.isArray(projects)) return;

    const groups = { 'fashion-technology': [], personal: [] };
    projects.forEach(p => { if (groups[p.group]) groups[p.group].push(p); });

    Object.keys(groups).forEach(key => {
      const el = document.getElementById('grid-' + key);
      if (!el || !groups[key].length) return;
      groups[key].sort((a, b) => (a.order || 0) - (b.order || 0));
      el.innerHTML = groups[key].map(cardHTML).join('');
    });
  })
  .catch(() => {});
