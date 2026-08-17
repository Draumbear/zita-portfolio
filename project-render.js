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

function galleryInnerHTML(images) {
  const columns = images.length <= 2 ? 2 : images.length === 3 ? 3 : 4;
  const stagger = images.length > 2 ? ' stagger' : '';
  const imgsHTML = images.map(img =>
    `<img src="${escapeHTML(img.src)}" alt="${escapeHTML(img.alt || '')}" loading="lazy" class="lightbox-img">`).join('');
  return { html: `<div class="project-gallery cols-${columns}${stagger}">${imgsHTML}</div>`, columns };
}

// A running counter (reset per band in bandsHTML) so consecutive groups
// alternate text-left/text-right instead of all facing the same way.
let groupAlternator = 0;

function groupHTML(block) {
  const items = block.items || [];
  const mediaTypes = ['picture', 'gallery', 'file'];
  const mediaItems = items.filter(i => mediaTypes.includes(i.type));
  const textItems = items.filter(i => !mediaTypes.includes(i.type));

  // Simple pairing (one media item + some text): lay it out side by side.
  if (mediaItems.length === 1 && textItems.length >= 1) {
    const media = mediaItems[0];
    const reverse = groupAlternator++ % 2 === 1;
    const textHTML = textItems.map(blockHTML).join('');
    let mediaHTML;
    if (media.type === 'gallery') mediaHTML = galleryInnerHTML(media.images || []).html;
    else if (media.type === 'file') mediaHTML = blockHTML(media);
    else mediaHTML = `<img src="${escapeHTML(media.src)}" alt="${escapeHTML(media.alt || '')}" loading="lazy" class="lightbox-img" style="cursor:zoom-in;">`;

    return `<div class="split${reverse ? ' split--reverse' : ''} reveal">
      <div class="split-text">${textHTML}</div>
      <div class="split-media">${mediaHTML}</div>
    </div>`;
  }

  // Anything richer than a simple pair: bind it visually with a bordered card.
  const inner = items.map(blockHTML).join('');
  return `<div class="content-group reveal">${inner}</div>`;
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
        <img src="${escapeHTML(block.src)}" alt="${escapeHTML(block.alt || '')}" loading="lazy" class="lightbox-img" style="width:100%; height:auto; border:1px solid var(--line); cursor:zoom-in;">
      </div>`;
    case 'gallery': {
      const { html } = galleryInnerHTML(block.images || []);
      return html.replace('class="project-gallery', 'class="project-gallery reveal');
    }
    case 'group':
      return groupHTML(block);
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

function bandNeedsWide(items) {
  return items.some(b => b.type === 'gallery' || b.type === 'group');
}

function bandsHTML(blocks) {
  const bands = groupIntoBands(blocks);
  return bands.map((band, i) => {
    groupAlternator = 0;
    const wide = bandNeedsWide(band.items);
    const content = band.items.map(blockHTML).join('');

    // A band's Title block can override the automatic alternating colours
    // with a manually picked background/text colour. Falls back to the
    // automatic cycle whenever neither is set.
    const titleBlock = band.items.find(b => b.type === 'title');
    const customBg = titleBlock && titleBlock.bgColor;
    const customText = titleBlock && titleBlock.textColor;
    const bandClass = customBg ? '' : ` band--${BAND_CYCLE[i % BAND_CYCLE.length]}`;
    const styleParts = [];
    if (customBg) styleParts.push(`background:${escapeHTML(customBg)}`);
    if (customText) styleParts.push(`color:${escapeHTML(customText)}`);
    const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

    return `<div class="band${bandClass}"${styleAttr}>
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

// Turns already-loaded project data into the page — split out from
// renderProject() so the admin dashboard's Preview button can render an
// in-progress (unsaved) draft the same way, without a data/projects/*.json
// file existing yet.
function renderProjectData(data) {
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
}

function renderProject(forcedSlug) {
  const slug = forcedSlug || new URLSearchParams(window.location.search).get('slug');
  if (!slug) { renderProjectError('Project not found'); return; }

  fetch(`data/projects/${slug}.json?_=${Date.now()}`, { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(renderProjectData)
    .catch(() => renderProjectError('Project not found'));
}
