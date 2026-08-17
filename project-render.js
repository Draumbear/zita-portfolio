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

// `block` (optional) carries the dashboard's per-gallery overrides:
// columns ('auto'|'1'..'6'), uniform (crop every photo to a consistent
// grid cell — the default, since letting each photo's native aspect ratio
// dictate its cell size is what produced the "random"-looking uneven grids),
// stagger (offset alternating photos — auto-on for 3+ photos unless
// explicitly turned off), size (constrains the gallery's overall width — the
// gallery equivalent of a standalone Picture's size, just on the whole grid
// rather than one photo; unset/'auto' keeps today's behavior of filling the
// available band width), and align (left/center/right — only visible once a
// size constraint leaves spare width to move within; defaults to center).
const GALLERY_SIZE_MAP = { xs: '420px', small: '620px', medium: '820px', large: '1040px' };
const GALLERY_ALIGN_MARGIN = { left: '0 auto 0 0', center: '0 auto', right: '0 0 0 auto' };
function galleryInnerHTML(images, block) {
  const count = images.length;
  const colsOverride = block && block.columns && block.columns !== 'auto' ? parseInt(block.columns, 10) : null;
  const columns = colsOverride || (count <= 2 ? 2 : count === 3 ? 3 : 4);
  const stagger = (block && block.stagger === false) ? false : count > 2;
  const uniform = !(block && block.uniform === false);
  const classes = `project-gallery cols-${columns}${stagger ? ' stagger' : ''}${uniform ? ' uniform' : ''}`;
  const maxW = block && block.size && GALLERY_SIZE_MAP[block.size];
  const margin = GALLERY_ALIGN_MARGIN[(block && block.align) || 'center'];
  const sizeStyle = maxW ? ` style="max-width:${maxW}; margin:${margin};"` : '';
  const imgsHTML = images.map(img =>
    `<img src="${escapeHTML(img.src)}" alt="${escapeHTML(img.alt || '')}" loading="lazy" class="lightbox-img">`).join('');
  return { html: `<div class="${classes}"${sizeStyle}>${imgsHTML}</div>`, columns };
}

// A running counter (reset per band in bandsHTML) so consecutive auto-layout
// groups alternate text-left/text-right instead of all facing the same way.
let groupAlternator = 0;

// `narrow`: true when this media is rendering in the side column of a
// split (media-left/media-right) group — roughly half the page width, so a
// gallery defaults to one column there instead of its usual auto column
// count (which never fit sensibly in that narrow a space). Explicitly
// choosing 2+ columns on the gallery itself (e.g. for a grid) still applies
// even here — this default only kicks in when she's left it on Automatic.
// Same idea for the crop-to-a-consistent-grid default: it exists to avoid
// raggedness across a multi-column grid's rows, which doesn't apply to a
// single column, so photos default to their natural aspect ratio here too
// unless she's explicitly turned cropping/offset on for that gallery.
function groupMediaHTML(media, narrow) {
  if (media.type === 'gallery') {
    const explicitColumns = media.columns && media.columns !== 'auto';
    const effectiveBlock = narrow
      ? { ...media, columns: explicitColumns ? media.columns : '1', uniform: media.uniform === true, stagger: media.stagger === true }
      : media;
    return galleryInnerHTML(media.images || [], effectiveBlock).html;
  }
  return blockHTML(media);
}

function groupHTML(block) {
  const items = block.items || [];
  const mediaTypes = ['picture', 'gallery', 'file'];
  const mediaItems = items.filter(i => mediaTypes.includes(i.type));
  const textItems = items.filter(i => !mediaTypes.includes(i.type));
  const layout = block.layout || 'auto';

  // Media with nothing beside it shouldn't be stretched into a full-width
  // bordered card, where it just sits alone on the page — render it
  // constrained/centered instead, the way a standalone block would be.
  if (mediaItems.length && textItems.length === 0) {
    return `<div class="group-media-only reveal">${mediaItems.map(m => groupMediaHTML(m)).join('')}</div>`;
  }

  // When a group has more than one separate media block (e.g. two Picture
  // blocks, not one Gallery), they can be stacked one per row (default) or
  // arranged in a 2-column grid instead.
  const mediaLayoutClass = block.mediaLayout === 'grid' ? ' grid' : '';

  const explicitSide = layout === 'media-left' || layout === 'media-right';
  const autoSide = layout === 'auto' && mediaItems.length === 1;
  if (mediaItems.length && textItems.length && (explicitSide || autoSide)) {
    const reverse = layout === 'media-left' ? true : layout === 'media-right' ? false : (groupAlternator++ % 2 === 1);
    const textHTML = textItems.map(blockHTML).join('');
    const mediaHTML = mediaItems.length === 1
      ? groupMediaHTML(mediaItems[0], true)
      : `<div class="split-media-stack${mediaLayoutClass}">${mediaItems.map(m => groupMediaHTML(m, true)).join('')}</div>`;
    return `<div class="split${reverse ? ' split--reverse' : ''} reveal">
      <div class="split-text">${textHTML}</div>
      <div class="split-media">${mediaHTML}</div>
    </div>`;
  }

  if (layout === 'media-above' || layout === 'media-below') {
    const mediaHTML = `<div class="group-media-stack${mediaLayoutClass}">${mediaItems.map(m => groupMediaHTML(m)).join('')}</div>`;
    const textHTML = textItems.map(blockHTML).join('');
    const ordered = layout === 'media-above' ? mediaHTML + textHTML : textHTML + mediaHTML;
    return `<div class="content-group reveal">${ordered}</div>`;
  }

  // Fallback (auto layout with more than one media item, or nothing else
  // matched): bind everything together in a bordered card, authored order.
  const inner = items.map(blockHTML).join('');
  return `<div class="content-group reveal">${inner}</div>`;
}

function blockHTML(block) {
  switch (block.type) {
    case 'title':
      return `<h2 class="reveal" style="text-align:${block.align || 'left'};">${escapeHTML(block.text)}</h2>`;
    case 'subtitle':
      return `<h3 class="reveal" style="text-align:${block.align || 'left'};">${escapeHTML(block.text)}</h3>`;
    case 'paragraph':
      return `<p class="reveal">${block.text || ''}</p>`;
    case 'file': {
      // With a cover image set, the file shows as an actual preview (e.g. a
      // document's cover page) instead of a generic file icon — still just a
      // download link, click anywhere on it to get the file.
      const preview = block.coverSrc
        ? `<img src="${escapeHTML(block.coverSrc)}" alt="" loading="lazy">`
        : `<span class="file-icon">📄</span>`;
      const sizeMap = block.coverSrc
        ? { xs: '130px', small: '180px', medium: '260px', large: '340px', xlarge: '480px' }
        : { xs: '150px', small: '200px', medium: '300px', large: '420px', xlarge: '600px' };
      const maxW = sizeMap[block.size] || sizeMap.medium;
      return `<a class="file-block${block.coverSrc ? ' file-block--cover' : ''} reveal" href="${escapeHTML(block.src)}" target="_blank" rel="noopener" style="max-width:${maxW};">
        ${preview}
        <span class="file-info">
          <strong>${escapeHTML(block.label || 'Download file')}</strong>
          <span>${fileExt(block.src)}</span>
        </span>
      </a>`;
    }
    case 'picture': {
      const sizeMap = { xs: '180px', small: '280px', medium: '420px', large: '600px', xlarge: '900px' };
      const maxW = sizeMap[block.size] || sizeMap.medium;
      return `<div class="reveal" style="max-width:${maxW}; margin: 0 auto 1.4rem;">
        <img src="${escapeHTML(block.src)}" alt="${escapeHTML(block.alt || '')}" loading="lazy" class="lightbox-img" style="width:100%; height:auto; border:1px solid var(--line); cursor:zoom-in;">
      </div>`;
    }
    case 'gallery': {
      const { html } = galleryInnerHTML(block.images || [], block);
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
  return items.some(b => b.type === 'gallery' || b.type === 'group' ||
    ((b.type === 'picture' || b.type === 'file') && (b.size === 'large' || b.size === 'xlarge')));
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

  // Overrides script.js's site-wide defaults with this specific project's
  // own title/description/image, so a link to this page shared on
  // iMessage/LinkedIn/Slack previews the right project, not the homepage.
  const setMeta = (id, val) => { const el = document.getElementById(id); if (el && val) el.setAttribute('content', val); };
  const blocks = data.blocks || [];
  const firstParagraph = blocks.find(b => b.type === 'paragraph' && b.text);
  const firstImage = blocks.find(b => b.type === 'picture' && b.src)
    || (blocks.find(b => b.type === 'gallery' && b.images && b.images[0]) || {}).images?.[0];
  const description = firstParagraph ? firstParagraph.text.replace(/<[^>]+>/g, '').slice(0, 200) : (data.meta || []).join(' · ');
  setMeta('ogTitle', `${data.title} — Zita Decoopman`);
  if (description) { setMeta('ogDescription', description); setMeta('metaDescription', description); }
  if (firstImage && firstImage.src) setMeta('ogImage', firstImage.src);

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
