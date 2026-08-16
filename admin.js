let gh = null;
let siteData = null;
let siteSha = null;        // sha of data/site.json as of last load — used to detect "someone else changed this"
let projectsIndex = [];
let currentDraft = null;   // project being edited in the editor panel
let editingSlug = null;    // slug of existing project being edited, or null for "new"

// Re-fetches data/projects-index.json fresh (never trusting the in-memory
// copy, which may be stale) and returns it. Callers should merge their
// specific change into this fresh array before writing, rather than writing
// back their own possibly-outdated copy — every project save touches this
// one shared file, so it's the highest-risk spot for one edit silently
// clobbering another that landed in between.
async function fetchFreshIndex() {
  return await gh.getJSON('data/projects-index.json') || [];
}

// Returns true if it's safe to proceed with the write. If the remote sha no
// longer matches what we loaded, asks the user whether to overwrite anyway.
async function checkNotStale(path, loadedSha, whatChanged) {
  if (!loadedSha) return true; // new file / nothing to compare against
  const current = await gh.getFile(path);
  if (!current || current.sha === loadedSha) return true;
  return confirm(
    `${whatChanged} was changed by someone else (or another tab) since you opened it.\n\n` +
    `Click OK to save your version anyway and overwrite theirs, or Cancel to stop — ` +
    `then re-open it to see the latest version before redoing your edit.`
  );
}

// ---------- helpers ----------

function toast(message, type = 'info', action) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.className = 'toast-action';
    btn.addEventListener('click', () => { action.onClick(); el.remove(); });
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  const timeout = action ? 8000 : 4200;
  const timer = setTimeout(() => el.remove(), timeout);
  el.addEventListener('click', (e) => { if (e.target === el) { clearTimeout(timer); el.remove(); } });
}

// Clones a block/draft structure for undo snapshots while preserving File
// object references (they can't survive JSON.stringify/parse).
function cloneForUndo(node) {
  if (Array.isArray(node)) return node.map(cloneForUndo);
  if (node instanceof File) return node;
  if (node && typeof node === 'object') {
    const copy = {};
    for (const k in node) copy[k] = cloneForUndo(node[k]);
    return copy;
  }
  return node;
}

function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'project';
}

function uniqueSlug(base) {
  let slug = base, n = 2;
  const taken = new Set(projectsIndex.map(p => p.slug));
  while (taken.has(slug) && slug !== editingSlug) { slug = `${base}-${n++}`; }
  return slug;
}

async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); }
  finally { btn.disabled = false; btn.textContent = original; }
}

// ---------- connect ----------

function initConnect() {
  const stored = GitHubStore.load();
  if (stored) {
    document.getElementById('ghOwner').value = stored.owner || '';
    document.getElementById('ghRepo').value = stored.repo || '';
    document.getElementById('ghBranch').value = stored.branch || 'main';
    document.getElementById('ghToken').value = stored.token || '';
    tryConnect(stored, true);
  }
}

async function tryConnect(cfg, silent) {
  const errEl = document.getElementById('connectError');
  errEl.textContent = '';
  try {
    const api = new GitHubAPI(cfg);
    await api.verify();
    gh = api;
    GitHubStore.save(cfg);
    document.getElementById('connectPanel').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    const status = document.getElementById('connStatus');
    status.textContent = `Connected — ${cfg.owner}/${cfg.repo}`;
    status.className = 'conn-status ok';
    await loadAll();
  } catch (e) {
    if (!silent) errEl.textContent = e.message;
    else GitHubStore.clear();
  }
}

document.getElementById('connectBtn').addEventListener('click', () => {
  const cfg = {
    owner: document.getElementById('ghOwner').value.trim(),
    repo: document.getElementById('ghRepo').value.trim(),
    branch: document.getElementById('ghBranch').value.trim() || 'main',
    token: document.getElementById('ghToken').value.trim()
  };
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    document.getElementById('connectError').textContent = 'Fill in username, repository, and token.';
    return;
  }
  withBusy(document.getElementById('connectBtn'), 'Connecting…', () => tryConnect(cfg, false));
});

document.getElementById('disconnectBtn').addEventListener('click', () => {
  GitHubStore.clear();
  location.reload();
});

async function loadAll() {
  await Promise.all([loadSite(), loadProjects()]);
}

// ---------- site & bio tab ----------

function markSynced(elId) {
  const el = document.getElementById(elId);
  if (el) el.textContent = 'Last synced from GitHub: ' + new Date().toLocaleTimeString();
}

async function loadSite() {
  const loaded = await gh.getJSONWithSha('data/site.json');
  siteData = loaded.data || {};
  siteSha = loaded.sha;
  markSynced('siteSyncStatus');
  const set = (id, val) => { document.getElementById(id).value = val || ''; };
  set('f-heroEyebrow', siteData.heroEyebrow);
  set('f-heroSub', siteData.heroSub);
  set('f-heroName', (siteData.heroName || '').replace(/<br>/g, '\n'));
  set('f-aboutEyebrow', siteData.aboutEyebrow);
  set('f-aboutHeading', siteData.aboutHeading);
  set('f-aboutParagraphs', (siteData.aboutParagraphs || []).join('\n\n'));
  set('f-aboutCaption', siteData.aboutCaption);
  set('f-contactName', siteData.contactName);
  set('f-contactEmail', siteData.contactEmail);

  const photoPrev = document.getElementById('aboutPhotoPreview');
  photoPrev.src = (siteData.aboutPhoto && siteData.aboutPhoto.src) || '';

  const cvLink = document.getElementById('currentCvLink');
  cvLink.innerHTML = siteData.cvUrl ? `Current file: <a href="${siteData.cvUrl}" target="_blank" rel="noopener">view</a>` : 'No CV uploaded yet.';
}

document.getElementById('saveSiteBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Saving…', async () => {
    try {
      const photoFile = document.getElementById('f-aboutPhoto').files[0];
      const cvFile = document.getElementById('f-cvFile').files[0];

      const aboutPhoto = siteData.aboutPhoto || {};
      if (photoFile) {
        aboutPhoto.src = await gh.uploadImage(photoFile, 'assets/uploads');
        aboutPhoto.alt = document.getElementById('f-contactName').value.trim() || 'Profile photo';
      }

      let cvUrl = siteData.cvUrl || '';
      if (cvFile) {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(cvFile);
        });
        const safeName = cvFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '-');
        const path = `assets/uploads/${Date.now()}-${safeName}`;
        await gh.putFile(path, { base64 }, `Upload CV: ${safeName}`);
        cvUrl = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${path}`;
      }

      const paragraphs = document.getElementById('f-aboutParagraphs').value
        .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

      const updated = {
        heroEyebrow: document.getElementById('f-heroEyebrow').value,
        heroName: document.getElementById('f-heroName').value.replace(/\n/g, '<br>'),
        heroSub: document.getElementById('f-heroSub').value,
        aboutEyebrow: document.getElementById('f-aboutEyebrow').value,
        aboutHeading: document.getElementById('f-aboutHeading').value,
        aboutPhoto,
        aboutCaption: document.getElementById('f-aboutCaption').value,
        aboutParagraphs: paragraphs,
        cvUrl,
        contactName: document.getElementById('f-contactName').value,
        contactEmail: document.getElementById('f-contactEmail').value
      };

      if (!await checkNotStale('data/site.json', siteSha, 'The site info')) {
        toast('Save cancelled — reload the Site & Bio tab to see the latest version.', 'info');
        return;
      }

      await gh.putJSON('data/site.json', updated, 'Update site info via dashboard');
      siteData = updated;
      document.getElementById('f-aboutPhoto').value = '';
      document.getElementById('f-cvFile').value = '';
      await loadSite();
      toast('Site info saved. GitHub Pages usually rebuilds within ~1 minute.', 'ok');
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    }
  });
});

// ---------- tabs ----------
// Switching to the Projects tab always re-pulls the list fresh — that's just
// a read, so it's safe even mid-session. The Site & Bio tab is a form Zita
// might be mid-typing in, so it's only refreshed via the explicit button
// (auto-refreshing it could wipe out what she just typed) — the save-time
// staleness check below is the real safety net for that one.
document.querySelectorAll('.admin-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.add('hidden'));
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'projects') loadProjects();
  });
});

document.getElementById('refreshSiteBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Refreshing…', loadSite);
});
document.getElementById('refreshProjectsBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Refreshing…', loadProjects);
});

// ---------- projects list ----------

async function loadProjects() {
  projectsIndex = await fetchFreshIndex();
  markSynced('projectsSyncStatus');
  renderProjectLists();
}

function renderProjectLists() {
  ['fashion-technology', 'personal'].forEach(group => {
    const wrap = document.getElementById('list-' + group);
    const items = projectsIndex.filter(p => p.group === group).sort((a, b) => (a.order || 0) - (b.order || 0));
    wrap.innerHTML = items.map((p, i) => `
      <div class="project-row">
        <img src="${(p.thumbnail && p.thumbnail.src) || ''}" alt="">
        <div class="pr-info">
          <strong>${p.title}${p.contentType === 'legacy' ? '<span class="badge">custom page</span>' : '<span class="badge">managed</span>'}</strong>
          <span>${p.href}</span>
        </div>
        <div class="pr-actions">
          <button class="btn-admin secondary small" data-move="up" data-slug="${p.slug}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-admin secondary small" data-move="down" data-slug="${p.slug}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-admin secondary small" data-edit="${p.slug}">Edit</button>
        </div>
      </div>
    `).join('') || '<p class="hint">No projects yet.</p>';
  });
}

document.querySelectorAll('.admin-main').forEach(main => {
  main.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openEditor(editBtn.dataset.edit); return; }

    const addBtn = e.target.closest('[data-add-project]');
    if (addBtn) { openEditor(null, addBtn.dataset.addProject); return; }

    const moveBtn = e.target.closest('[data-move]');
    if (moveBtn) { moveProject(moveBtn.dataset.slug, moveBtn.dataset.move); return; }
  });
});

async function moveProject(slug, direction) {
  const entry = projectsIndex.find(p => p.slug === slug);
  if (!entry) return;
  const siblings = projectsIndex.filter(p => p.group === entry.group).sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = siblings.findIndex(p => p.slug === slug);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return;
  const otherSlug = siblings[swapIdx].slug;
  try {
    // Apply the swap on a freshly-fetched index, not our possibly-stale
    // in-memory copy, so a concurrent edit to some other project isn't lost.
    const fresh = await fetchFreshIndex();
    const a = fresh.find(p => p.slug === slug);
    const b = fresh.find(p => p.slug === otherSlug);
    if (!a || !b) { toast('That project changed elsewhere — refreshing the list.', 'info'); await loadProjects(); return; }
    const tmp = a.order; a.order = b.order; b.order = tmp;
    await gh.putJSON('data/projects-index.json', fresh, `Reorder projects`);
    projectsIndex = fresh;
    renderProjectLists();
  } catch (e) {
    toast('Reorder failed: ' + e.message, 'err');
  }
}

// ---------- project editor ----------
// Content is a flat, ordered list of standard blocks: Title, Subtitle,
// Paragraph, File, Picture, Gallery. Styling (band colours, layout width,
// gallery columns) is applied automatically at render time — see
// project-render.js — so there is nothing to configure here beyond content.

const BLOCK_LABELS = {
  title: 'Title', subtitle: 'Subtitle', paragraph: 'Paragraph',
  file: 'File', picture: 'Picture', gallery: 'Gallery', group: 'Group'
};

function blankBlock(type) {
  if (type === 'gallery') return { type, images: [] };
  if (type === 'picture') return { type, src: '', alt: '' };
  if (type === 'file') return { type, label: '', src: '' };
  if (type === 'group') return { type, items: [] };
  return { type, text: '' };
}

// A group block nests its own items array. Both levels are edited with the
// same field/action markup — `gi` distinguishes "item i inside group's own
// list" from "top-level block i" wherever an action fires.
function dataAttrs(i, gi) {
  return gi == null ? `data-i="${i}"` : `data-i="${i}" data-gi="${gi}"`;
}
function resolveContainer(i, gi) {
  return gi == null ? currentDraft.blocks : currentDraft.blocks[i].items;
}
function resolveIndex(i, gi) {
  return gi == null ? i : gi;
}

async function openEditor(slug, groupForNew) {
  editingSlug = slug;
  const editor = document.getElementById('projectEditor');
  editor.classList.remove('hidden');
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (slug) {
    // Re-pull the index fresh so we open with the true latest card details
    // (title/thumbnail/order), not whatever was in memory from page-load.
    projectsIndex = await fetchFreshIndex();
    const entry = projectsIndex.find(p => p.slug === slug);
    if (!entry) { toast('That project no longer exists — it may have been deleted elsewhere.', 'err'); editor.classList.add('hidden'); renderProjectLists(); return; }
    currentDraft = { ...entry, thumbnailFile: null, _detailSha: null };
    if (entry.contentType !== 'legacy') {
      const loaded = await gh.getJSONWithSha(`data/projects/${slug}.json`);
      const detail = loaded.data || { blocks: [] };
      currentDraft._detailSha = loaded.sha;
      currentDraft.eyebrow = detail.eyebrow || '';
      currentDraft.metaLine = (detail.meta || []).join(' · ');
      currentDraft.blocks = detail.blocks && detail.blocks.length ? detail.blocks : [blankBlock('title')];
    }
  } else {
    currentDraft = {
      slug: null, title: '', href: '', group: groupForNew || 'fashion-technology',
      order: projectsIndex.filter(p => p.group === (groupForNew || 'fashion-technology')).length + 1,
      contentType: 'managed', thumbnail: {}, thumbnailFile: null,
      eyebrow: '', metaLine: '', blocks: [blankBlock('title')]
    };
  }
  renderEditor();
}

function renderEditor() {
  document.getElementById('editorTitle').textContent = currentDraft.slug ? `Edit "${currentDraft.title}"` : 'New project';
  document.getElementById('pe-title').value = currentDraft.title || '';
  document.getElementById('pe-group').value = currentDraft.group;
  document.getElementById('pe-eyebrow').value = currentDraft.eyebrow || '';
  document.getElementById('pe-meta').value = currentDraft.metaLine || '';
  document.getElementById('pe-thumb-preview').src = (currentDraft.thumbnail && currentDraft.thumbnail.src) || '';

  const legacy = currentDraft.contentType === 'legacy';
  document.getElementById('legacyNotice').classList.toggle('hidden', !legacy);
  document.getElementById('pe-eyebrow').closest('.admin-field').classList.toggle('hidden', legacy);
  document.getElementById('pe-meta').closest('.admin-field').classList.toggle('hidden', legacy);
  document.getElementById('pe-blocks-wrap').classList.toggle('hidden', legacy);
  document.getElementById('deleteProjectBtn').style.display = currentDraft.slug ? '' : 'none';

  if (!legacy) renderBlocks();
}

function renderBlocks() {
  const wrap = document.getElementById('pe-blocks');
  wrap.innerHTML = currentDraft.blocks.map((block, i) => blockEditorHTML(block, i)).join('');
}

function blockEditorHTML(block, i, gi) {
  const attrs = dataAttrs(i, gi);
  let fields = '';

  if (block.type === 'title' || block.type === 'subtitle') {
    fields = `<input type="text" placeholder="${BLOCK_LABELS[block.type]} text" value="${(block.text || '').replace(/"/g, '&quot;')}" data-action="text" ${attrs}>`;
  } else if (block.type === 'paragraph') {
    fields = `<textarea placeholder="Paragraph text" data-action="text" ${attrs} rows="3">${block.text || ''}</textarea>`;
  } else if (block.type === 'file') {
    fields = `
      <input type="text" placeholder="Label (e.g. Download CV)" value="${(block.label || '').replace(/"/g, '&quot;')}" data-action="label" ${attrs}>
      <input type="file" data-action="fileUpload" ${attrs}>
      ${block.src || block._pendingFile ? `<span class="hint">${block._pendingFile ? block._pendingFile.name : 'File attached'}</span>` : ''}
    `;
  } else if (block.type === 'picture') {
    fields = `
      <input type="file" accept="image/*" data-action="pictureUpload" ${attrs}>
      <input type="text" placeholder="Alt text" value="${(block.alt || '').replace(/"/g, '&quot;')}" data-action="alt" ${attrs}>
      ${block.src || block._previewSrc ? `<img src="${block._previewSrc || block.src}" alt="" style="width:70px;height:90px;object-fit:cover;border-radius:4px;">` : ''}
    `;
  } else if (block.type === 'gallery') {
    fields = `
      <input type="file" accept="image/*" multiple data-action="galleryUpload" ${attrs}>
      <div class="gallery-images">
        ${(block.images || []).map((img, imgI) => `
          <div class="gallery-image-item">
            <img src="${img._previewSrc || img.src}" alt="">
            <button data-action="removeGalleryImage" ${attrs} data-imgi="${imgI}" title="Remove">&times;</button>
          </div>
        `).join('')}
      </div>
      <p class="hint" style="margin:0.3rem 0 0;">Columns and layout are chosen automatically based on how many photos you add.</p>
    `;
  } else if (block.type === 'group') {
    const items = block.items || [];
    fields = `
      <p class="group-hint">Text + one picture, gallery or file will be laid out side by side automatically; anything more is bound together in a bordered card.</p>
      <div class="group-items">
        ${items.map((sub, subI) => blockEditorHTML(sub, i, subI)).join('') || '<p class="hint">Empty — add an item below.</p>'}
      </div>
      <select data-action="addGroupItem" data-i="${i}" style="width:auto;">
        <option value="">+ Add item to group…</option>
        <option value="subtitle">Subtitle</option>
        <option value="paragraph">Paragraph</option>
        <option value="file">File (download)</option>
        <option value="picture">Picture</option>
        <option value="gallery">Gallery</option>
      </select>
    `;
    return `
      <div class="content-item" data-i="${i}">
        <div class="content-item-fields">
          <strong style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--a-ink-soft);">Group</strong>
          ${fields}
        </div>
        <div class="content-item-actions">
          <button class="btn-admin secondary small" data-action="moveUp" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-admin secondary small" data-action="moveDown" data-i="${i}" ${i === currentDraft.blocks.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn-admin danger small" data-action="removeBlock" data-i="${i}">✕</button>
        </div>
      </div>
    `;
  }

  const container = resolveContainer(i, gi);
  const idx = resolveIndex(i, gi);
  return `
    <div class="content-item" ${attrs}>
      <div class="content-item-fields">
        <strong style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--a-ink-soft);">${BLOCK_LABELS[block.type]}</strong>
        ${fields}
      </div>
      <div class="content-item-actions">
        <button class="btn-admin secondary small" data-action="moveUp" ${attrs} ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn-admin secondary small" data-action="moveDown" ${attrs} ${idx === container.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-admin danger small" data-action="removeBlock" ${attrs}>✕</button>
      </div>
    </div>
  `;
}

document.getElementById('addBlockSelect').addEventListener('change', (e) => {
  if (!e.target.value) return;
  currentDraft.blocks.push(blankBlock(e.target.value));
  e.target.value = '';
  renderBlocks();
});

document.getElementById('pe-blocks').addEventListener('change', (e) => {
  const t = e.target;
  const action = t.dataset.action;
  if (!action) return;
  const i = +t.dataset.i;
  const gi = t.dataset.gi !== undefined ? +t.dataset.gi : null;

  if (action === 'addGroupItem' && t.value) {
    currentDraft.blocks[i].items.push(blankBlock(t.value));
    t.value = '';
    renderBlocks();
    return;
  }

  const block = resolveContainer(i, gi)[resolveIndex(i, gi)];

  if (action === 'fileUpload' && t.files[0]) {
    block._pendingFile = t.files[0];
    if (!block.label) block.label = t.files[0].name.replace(/\.[^.]+$/, '');
    renderBlocks();
  }
  if (action === 'pictureUpload' && t.files[0]) {
    block._pendingFile = t.files[0];
    block._previewSrc = URL.createObjectURL(t.files[0]);
    renderBlocks();
  }
  if (action === 'galleryUpload' && t.files.length) {
    Array.from(t.files).forEach(file => {
      block.images.push({ src: '', alt: '', _pendingFile: file, _previewSrc: URL.createObjectURL(file) });
    });
    renderBlocks();
  }
});

document.getElementById('pe-blocks').addEventListener('input', (e) => {
  const t = e.target;
  const action = t.dataset.action;
  if (!action) return;
  const i = +t.dataset.i;
  const gi = t.dataset.gi !== undefined ? +t.dataset.gi : null;
  const block = resolveContainer(i, gi)[resolveIndex(i, gi)];
  if (action === 'text') block.text = t.value;
  if (action === 'alt') block.alt = t.value;
  if (action === 'label') block.label = t.value;
});

document.getElementById('pe-blocks').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const i = +btn.dataset.i;
  const gi = btn.dataset.gi !== undefined ? +btn.dataset.gi : null;
  const imgi = btn.dataset.imgi !== undefined ? +btn.dataset.imgi : null;

  if (action === 'removeGalleryImage') {
    if (!confirm('Remove this image?')) return;
    const beforeBlocks = cloneForUndo(currentDraft.blocks);
    resolveContainer(i, gi)[resolveIndex(i, gi)].images.splice(imgi, 1);
    renderBlocks();
    toast('Image removed.', 'info', {
      label: 'Undo',
      onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); }
    });
    return;
  }

  const container = resolveContainer(i, gi);
  const idx = resolveIndex(i, gi);

  if (action === 'removeBlock') {
    const label = BLOCK_LABELS[container[idx].type] || 'block';
    if (!confirm(`Remove this ${label} block?`)) return;
    const beforeBlocks = cloneForUndo(currentDraft.blocks);
    container.splice(idx, 1);
    renderBlocks();
    toast(`${label} removed.`, 'info', {
      label: 'Undo',
      onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); }
    });
  }
  if (action === 'moveUp' && idx > 0) { swap(container, idx, idx - 1); renderBlocks(); }
  if (action === 'moveDown' && idx < container.length - 1) { swap(container, idx, idx + 1); renderBlocks(); }
});

function swap(arr, i, j) { const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }

document.getElementById('cancelEditBtn').addEventListener('click', () => {
  document.getElementById('projectEditor').classList.add('hidden');
  currentDraft = null; editingSlug = null;
});

document.getElementById('saveProjectBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Saving…', saveProject);
});

async function uploadPendingFiles(block) {
  if ((block.type === 'file' || block.type === 'picture') && block._pendingFile) {
    block.src = await gh.uploadImage(block._pendingFile, 'assets/uploads');
    delete block._pendingFile; delete block._previewSrc;
  }
  if (block.type === 'gallery') {
    for (const img of block.images) {
      if (img._pendingFile) {
        img.src = await gh.uploadImage(img._pendingFile, 'assets/uploads');
        delete img._pendingFile; delete img._previewSrc;
      }
    }
  }
}

async function saveProject() {
  try {
    currentDraft.title = document.getElementById('pe-title').value.trim();
    if (!currentDraft.title) { toast('Give the project a title first.', 'err'); return; }
    currentDraft.group = document.getElementById('pe-group').value;
    currentDraft.eyebrow = document.getElementById('pe-eyebrow').value.trim();
    currentDraft.metaLine = document.getElementById('pe-meta').value.trim();

    const thumbFile = document.getElementById('pe-thumb').files[0];
    if (thumbFile) {
      const url = await gh.uploadImage(thumbFile, 'assets/uploads');
      currentDraft.thumbnail = { src: url, alt: currentDraft.title };
    }

    const slug = currentDraft.slug || uniqueSlug(slugify(currentDraft.title));
    currentDraft.slug = slug;

    if (currentDraft.contentType !== 'legacy') {
      // If we're editing an existing project, make sure nobody else's edit
      // landed since we opened it before we overwrite the file.
      if (editingSlug) {
        const proceed = await checkNotStale(`data/projects/${slug}.json`, currentDraft._detailSha, `"${currentDraft.title}"`);
        if (!proceed) { toast('Save cancelled — reopen this project to see the latest version.', 'info'); return; }
      }

      // upload any pending files for this project's blocks (including
      // items nested inside a group block)
      for (const block of currentDraft.blocks) {
        await uploadPendingFiles(block);
        if (block.type === 'group') {
          for (const sub of block.items) await uploadPendingFiles(sub);
        }
      }

      const detail = {
        title: currentDraft.title,
        eyebrow: currentDraft.eyebrow,
        meta: currentDraft.metaLine ? currentDraft.metaLine.split('·').map(s => s.trim()).filter(Boolean) : [],
        blocks: currentDraft.blocks
      };
      await gh.putJSON(`data/projects/${slug}.json`, detail, `Update project: ${currentDraft.title}`);
      currentDraft.href = `project.html?slug=${slug}`;
    }

    const indexEntry = {
      slug,
      title: currentDraft.title,
      href: currentDraft.href,
      group: currentDraft.group,
      order: currentDraft.order || (projectsIndex.filter(p => p.group === currentDraft.group).length + 1),
      contentType: currentDraft.contentType,
      thumbnail: currentDraft.thumbnail || {}
    };
    // Merge into a freshly-fetched index rather than writing back our own
    // possibly-stale in-memory copy, so an edit made to some other project
    // in between isn't lost.
    const freshIndex = await fetchFreshIndex();
    const existingIdx = freshIndex.findIndex(p => p.slug === slug);
    if (existingIdx >= 0) freshIndex[existingIdx] = indexEntry;
    else freshIndex.push(indexEntry);

    await gh.putJSON('data/projects-index.json', freshIndex, `Save project: ${currentDraft.title}`);
    projectsIndex = freshIndex;

    toast('Project saved. GitHub Pages usually rebuilds within ~1 minute.', 'ok');
    document.getElementById('projectEditor').classList.add('hidden');
    currentDraft = null; editingSlug = null;
    renderProjectLists();
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

document.getElementById('deleteProjectBtn').addEventListener('click', async () => {
  if (!currentDraft || !currentDraft.slug) return;
  if (!confirm(`Delete "${currentDraft.title}"? This removes it from the homepage. Its page file (if custom-built) is not deleted.`)) return;
  try {
    const freshBefore = await fetchFreshIndex();
    const deletedEntry = freshBefore.find(p => p.slug === currentDraft.slug);
    const deletedDetail = currentDraft.contentType !== 'legacy'
      ? await gh.getJSON(`data/projects/${currentDraft.slug}.json`)
      : null;

    const afterDelete = freshBefore.filter(p => p.slug !== currentDraft.slug);
    if (currentDraft.contentType !== 'legacy') {
      await gh.deleteFile(`data/projects/${currentDraft.slug}.json`, `Delete project: ${currentDraft.title}`);
    }
    await gh.putJSON('data/projects-index.json', afterDelete, `Delete project: ${currentDraft.title}`);
    projectsIndex = afterDelete;

    document.getElementById('projectEditor').classList.add('hidden');
    currentDraft = null; editingSlug = null;
    renderProjectLists();

    toast('Project deleted.', 'ok', {
      label: 'Undo',
      onClick: async () => {
        try {
          if (deletedDetail) await gh.putJSON(`data/projects/${deletedEntry.slug}.json`, deletedDetail, `Restore project: ${deletedEntry.title}`);
          const freshNow = await fetchFreshIndex();
          freshNow.push(deletedEntry);
          await gh.putJSON('data/projects-index.json', freshNow, `Restore project: ${deletedEntry.title}`);
          projectsIndex = freshNow;
          renderProjectLists();
          toast('Project restored.', 'ok');
        } catch (e) {
          toast('Restore failed: ' + e.message, 'err');
        }
      }
    });
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
});

initConnect();
