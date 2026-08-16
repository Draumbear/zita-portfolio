// Generic renderer for dashboard-created project pages.
// Reads ?slug=<slug> from the URL, fetches data/projects/<slug>.json,
// and turns a flat list of standard blocks (title, subtitle, paragraph,
// file, picture, gallery) into the same alternating-band, gallery,
// reveal and lightbox markup the hand-built pages use — automatically,
// with no styling decisions required from whoever wrote the content.

const BAND_CYCLE = ['a', 'b', 'tint', 'dark'];

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function fileExt(src) {
  const clean = (src || '').split('?')[0];
  const m = clean.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toUpperCase() : 'FILE';
}

function blockHTML(block) {
  switch (block.type) {
    case 'title':
      return `<h2 class="reveal">${escapeHTML(block.text)}</h2>`;
    case 'subtitle':
      return `<h3 class="reveal">${escapeHTML(block.text)}</h3>`;
    case 'paragraph':
      return `<p class="reveal">${block.text || ''}</p>`;
    case 'file':
      return `<a class="file-block reveal" href="${escapeHTML(block.src)}" target="_blank" rel="noopener">
        <span class="file-icon">📄</span>
        <span class="file-info">
          <strong>${escapeHTML(block.label || 'Download file')}</strong>
          <span>${fileExt(block.src)}</span>
        </span>
      </a>`;
    case 'picture':
      return `<div class="reveal" style="max-width:600px; margin: 0 auto 1.4rem;">
        <img src="${escapeHTML(block.src)}" alt="${escapeHTML(block.alt || '')}" loading="lazy" style="width:100%; height:auto; border:1px solid var(--line); cursor:zoom-in;">
      </div>`;
    case 'gallery': {
      const images = block.images || [];
      const columns = images.length <= 2 ? 2 : images.length === 3 ? 3 : 4;
      const stagger = images.length > 2 ? ' stagger' : '';
      const imgsHTML = images.map(img =>
        `<img src="${escapeHTML(img.src)}" alt="${escapeHTML(img.alt || '')}" loading="lazy">`).join('');
      return `<div class="project-gallery cols-${columns}${stagger} reveal">${imgsHTML}</div>`;
    }
    default:
      return '';
  }
}

// Groups a flat block list into bands: a new band starts at each "title"
// block (after the first), cycling background colour automatically.
function groupIntoBands(blocks) {
  const bands = [];
  let current = null;
  blocks.forEach(block => {
    if (block.type === 'title' && current && current.items.length) {
      bands.push(current);
      current = null;
    }
    if (!current) current = { items: [] };
    current.items.push(block);
  });
  if (current && current.items.length) bands.push(current);
  return bands;
}

function bandsHTML(blocks) {
  const bands = groupIntoBands(blocks);
  return bands.map((band, i) => {
    const bg = BAND_CYCLE[i % BAND_CYCLE.length];
    const wide = band.items.some(b => b.type === 'gallery');
    const content = band.items.map(blockHTML).join('');
    return `<div class="band band--${bg}">
      <div class="band-inner${wide ? ' wide' : ''}">${content}</div>
    </div>`;
  }).join('');
}

function renderProjectError(message) {
  const hero = document.getElementById('projectHero');
  const body = document.getElementById('projectBody');
  if (hero) hero.innerHTML = `<h1>${escapeHTML(message)}</h1>`;
  if (body) body.innerHTML = '';
}

function renderProject(forcedSlug) {
  const slug = forcedSlug || new URLSearchParams(window.location.search).get('slug');
  if (!slug) { renderProjectError('Project not found'); return; }

  fetch(`data/projects/${slug}.json`)
    .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(data => {
      document.title = `${data.title} — Zita Decoopman`;

      const eyebrow = document.getElementById('projectEyebrow');
      const title = document.getElementById('projectTitle');
      const meta = document.getElementById('projectMeta');
      if (eyebrow) eyebrow.textContent = data.eyebrow || '';
      if (title) title.textContent = data.title || '';
      if (meta) meta.innerHTML = (data.meta || []).map(m => `<span>${escapeHTML(m)}</span>`).join('');

      const body = document.getElementById('projectBody');
      if (body) body.innerHTML = bandsHTML(data.blocks || []);

      if (window.initProjectInteractions) window.initProjectInteractions();
    })
    .catch(() => renderProjectError('Project not found'));
}
