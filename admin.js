let gh = null;
let siteData = null;
let siteSha = null;        // sha of data/site.json as of last load — used to detect "someone else changed this"
let projectsIndex = [];
let currentDraft = null;   // project being edited in the editor panel
let editingSlug = null;    // slug of existing project being edited, or null for "new"
let projectSaveInFlight = false; // true while saveProject() is uploading/committing — guards
                                  // against Cancel/Delete/switching-project reassigning or
                                  // clearing currentDraft out from under the in-flight save
let siteDirty = false;    // true if the Site & Bio form has unsaved edits
let projectDirty = false; // true if the open project editor has unsaved edits

window.addEventListener('beforeunload', (e) => {
  if (siteDirty || projectDirty || projectSaveInFlight) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Ctrl/Cmd+S saves whichever thing is actually open — the project editor if
// it's open, else the Site & Bio form if that tab is active — instead of
// triggering the browser's own "Save Page As".
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey)) return;
  if (!gh) return;
  e.preventDefault();
  if (!document.getElementById('projectEditor').classList.contains('hidden')) {
    document.getElementById('saveProjectBtn').click();
  } else if (!document.getElementById('tab-site').classList.contains('hidden')) {
    document.getElementById('saveSiteBtn').click();
  } else {
    toast('Nothing to save on this tab.', 'info');
  }
});

// ---------- autosave (local recovery only — never sent anywhere) ----------
// Saves just enough of the in-progress form to recover from a crashed tab or
// accidental close. Deliberately does NOT persist File objects (photo/CV/image
// picks) — those can't survive localStorage, so a restored draft may need
// unsaved picture selections re-added; text and block structure do recover.

const AUTOSAVE_SITE_KEY = 'zita-admin-autosave-site';
const AUTOSAVE_PROJECT_KEY = 'zita-admin-autosave-project';

function readAutosave(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeAutosave(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ...data, savedAt: Date.now() })); } catch { /* storage full/unavailable — autosave is best-effort */ }
}
function clearAutosave(key) {
  localStorage.removeItem(key);
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Strips non-serializable per-block state (pending File objects, blob: preview
// URLs) so the block tree can round-trip through localStorage.
function serializableBlocks(blocks) {
  return (blocks || []).map(b => {
    const copy = { ...b };
    delete copy._pendingFile; delete copy._previewSrc;
    delete copy._pendingCoverFile; delete copy._coverPreviewSrc;
    if (copy.images) copy.images = copy.images.map(img => { const c = { ...img }; delete c._pendingFile; delete c._previewSrc; return c; });
    if (copy.items) copy.items = serializableBlocks(copy.items);
    return copy;
  });
}

// All repo-hosted image/file paths a project currently references (thumbnail +
// every block, recursing into groups). Used to spot uploads that fell out of
// use — a replaced thumbnail, a removed picture block, a deleted gallery photo
// — so the old file can be deleted from the repo in the same save commit
// instead of sitting there orphaned forever.
function collectReferencedPaths(project) {
  const paths = new Set();
  const add = (url) => { const p = gh.pathFromRawUrl(url); if (p) paths.add(p); };
  if (project.thumbnail) add(project.thumbnail.src);
  const walk = (blocks) => {
    for (const b of blocks || []) {
      if ((b.type === 'file' || b.type === 'picture') && b.src) add(b.src);
      if (b.type === 'file' && b.coverSrc) add(b.coverSrc);
      if (b.type === 'gallery') (b.images || []).forEach(img => add(img.src));
      if (b.type === 'group') walk(b.items);
    }
  };
  walk(project.blocks);
  return paths;
}

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

function toastContainer() {
  let el = document.getElementById('toastContainer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toastContainer';
    el.className = 'toast-container';
    document.body.appendChild(el);
  }
  return el;
}

// Toasts land in a shared fixed-position container and stack via normal flow
// (newest closest to the corner) — appending each one to document.body with
// its own fixed position, as before, made simultaneous toasts (e.g. an Undo
// toast still showing when another action toasts) render exactly on top of
// each other instead of stacking.
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
  toastContainer().appendChild(el);
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
  const setLabel = (text) => { btn.textContent = text; };
  try { await fn(setLabel); }
  finally { btn.disabled = false; btn.textContent = original; }
}

// Persistent (not auto-dismissing-in-4s) indicator that GitHub Pages is
// republishing after a save. Editing in the dashboard is available again
// immediately (the save button already re-enabled) — this just tracks the
// separate, slower step of the *live* site catching up.
function showBuildStatus() {
  const prev = document.getElementById('buildStatus');
  if (prev) prev.remove();

  const el = document.createElement('div');
  el.id = 'buildStatus';
  el.className = 'build-status';
  el.innerHTML = `
    <div class="build-status-bar"><div class="build-status-fill"></div></div>
    <span class="build-status-label">Saved — your live site is rebuilding…</span>
  `;
  document.body.appendChild(el);

  const fill = el.querySelector('.build-status-fill');
  const label = el.querySelector('.build-status-label');
  const duration = 60000;
  const start = Date.now();

  // setInterval (not requestAnimationFrame) so this keeps advancing even in a
  // backgrounded tab — the whole point is to check it after switching away
  // to look at the live site.
  const timer = setInterval(() => {
    if (!document.body.contains(el)) { clearInterval(timer); return; }
    const pct = Math.min(100, ((Date.now() - start) / duration) * 100);
    fill.style.width = pct + '%';
    if (pct >= 100) {
      clearInterval(timer);
      label.textContent = 'Should be live now — refresh the site to check.';
      el.classList.add('done');
      setTimeout(() => el.remove(), 6000);
    }
  }, 500);
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
    const liveLink = document.getElementById('viewLiveLink');
    // GitHub Pages' default project-site URL. If the repo publishes to a custom
    // domain via a CNAME file, this link will still work (Pages redirects) —
    // it just won't be the prettiest URL.
    liveLink.href = `https://${cfg.owner}.github.io/${cfg.repo}/`;
    liveLink.classList.remove('hidden');
    await loadAll();
    checkSiteAutosave();
    await checkProjectAutosave();
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
  siteDirty = false;
}

const autosaveSite = debounce(() => {
  writeAutosave(AUTOSAVE_SITE_KEY, {
    heroEyebrow: document.getElementById('f-heroEyebrow').value,
    heroName: document.getElementById('f-heroName').value,
    heroSub: document.getElementById('f-heroSub').value,
    aboutEyebrow: document.getElementById('f-aboutEyebrow').value,
    aboutHeading: document.getElementById('f-aboutHeading').value,
    aboutParagraphs: document.getElementById('f-aboutParagraphs').value,
    aboutCaption: document.getElementById('f-aboutCaption').value,
    contactName: document.getElementById('f-contactName').value,
    contactEmail: document.getElementById('f-contactEmail').value
  });
}, 800);

document.querySelectorAll('#tab-site input[type="text"], #tab-site input[type="email"], #tab-site textarea').forEach(el => {
  el.addEventListener('input', () => { siteDirty = true; autosaveSite(); });
});
// File selections can't be autosaved (Files don't survive localStorage) but
// still count as unsaved work for the beforeunload warning.
document.getElementById('f-aboutPhoto').addEventListener('change', () => { siteDirty = true; });
document.getElementById('f-cvFile').addEventListener('change', () => { siteDirty = true; });

function checkSiteAutosave() {
  const draft = readAutosave(AUTOSAVE_SITE_KEY);
  if (!draft) return;
  const when = new Date(draft.savedAt).toLocaleString();
  if (!confirm(`Found unsaved Site & Bio changes from ${when} (likely a closed tab or crash). Restore them into the form?`)) {
    clearAutosave(AUTOSAVE_SITE_KEY);
    return;
  }
  const set = (id, val) => { document.getElementById(id).value = val || ''; };
  set('f-heroEyebrow', draft.heroEyebrow);
  set('f-heroName', draft.heroName);
  set('f-heroSub', draft.heroSub);
  set('f-aboutEyebrow', draft.aboutEyebrow);
  set('f-aboutHeading', draft.aboutHeading);
  set('f-aboutParagraphs', draft.aboutParagraphs);
  set('f-aboutCaption', draft.aboutCaption);
  set('f-contactName', draft.contactName);
  set('f-contactEmail', draft.contactEmail);
  siteDirty = true;
  toast('Draft restored — review and click Save changes.', 'info');
}

document.getElementById('saveSiteBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Saving…', async (setLabel) => {
    try {
      const photoFile = document.getElementById('f-aboutPhoto').files[0];
      const cvFile = document.getElementById('f-cvFile').files[0];
      const files = []; // batched into a single commit alongside data/site.json below

      const aboutPhoto = siteData.aboutPhoto || {};
      const oldPhotoSrc = aboutPhoto.src; // captured before any overwrite, for orphan cleanup below
      if (photoFile) {
        setLabel('Optimizing photo…');
        const prepared = await gh.prepareUpload(photoFile, 'assets/uploads');
        files.push({ path: prepared.path, content: prepared.content });
        aboutPhoto.src = prepared.url;
        aboutPhoto.alt = document.getElementById('f-contactName').value.trim() || 'Profile photo';
        const oldPath = gh.pathFromRawUrl(oldPhotoSrc);
        if (oldPath) files.push({ path: oldPath, delete: true });
      }

      const oldCvUrl = siteData.cvUrl || '';
      let cvUrl = oldCvUrl;
      if (cvFile) {
        setLabel('Preparing CV…');
        const prepared = await gh.prepareUpload(cvFile, 'assets/uploads', { optimize: false });
        files.push({ path: prepared.path, content: prepared.content });
        cvUrl = prepared.url;
        const oldPath = gh.pathFromRawUrl(oldCvUrl);
        if (oldPath) files.push({ path: oldPath, delete: true });
      }

      setLabel('Saving…');
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

      files.push({ path: 'data/site.json', content: JSON.stringify(updated, null, 2) });
      await gh.commitBatch(files, 'Update site info via dashboard');
      siteData = updated;
      document.getElementById('f-aboutPhoto').value = '';
      document.getElementById('f-cvFile').value = '';
      await loadSite();
      clearAutosave(AUTOSAVE_SITE_KEY);
      toast('Site info saved.', 'ok');
      showBuildStatus();
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
    if (btn.dataset.tab === 'media') loadMedia();
  });
});

document.getElementById('refreshSiteBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Refreshing…', loadSite);
});
document.getElementById('refreshProjectsBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Refreshing…', loadProjects);
});
document.getElementById('refreshMediaBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Refreshing…', loadMedia);
});

// ---------- media library ----------
// Every file under assets/uploads, cross-referenced against site.json and
// every managed project's detail JSON so Zita can see what's actually in use
// vs safe to delete, download a picture to move it, then re-upload it in the
// right spot (see the note in admin.html about legacy custom pages not being
// scanned — their hard-coded images can't be detected this way).

let mediaFiles = [];
let mediaUsage = new Map(); // repo-relative path -> [location labels]
let externalMedia = [];     // [{ url, usedBy: [location labels] }] — images the site uses that were never uploaded through here (e.g. still hotlinked from the old Wix site)

async function buildSiteWideUsageMap() {
  const usage = new Map();
  const external = new Map();
  const addUsage = (url, label) => {
    if (!url) return;
    const path = gh.pathFromRawUrl(url);
    const bucket = path ? usage : external;
    const key = path || url;
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(label);
  };

  const site = await gh.getJSON('data/site.json') || {};
  if (site.aboutPhoto) addUsage(site.aboutPhoto.src, 'Site & Bio — profile photo');
  addUsage(site.cvUrl, 'Site & Bio — CV');

  const index = await fetchFreshIndex();
  for (const entry of index) {
    if (entry.thumbnail) addUsage(entry.thumbnail.src, `"${entry.title}" — thumbnail`);
    if (entry.contentType === 'legacy') continue;
    const detail = await gh.getJSON(`data/projects/${entry.slug}.json`);
    if (!detail) continue;
    const walk = (blocks) => {
      for (const b of blocks || []) {
        if ((b.type === 'file' || b.type === 'picture') && b.src) addUsage(b.src, `"${entry.title}"`);
        if (b.type === 'file' && b.coverSrc) addUsage(b.coverSrc, `"${entry.title}" — file cover`);
        if (b.type === 'gallery') (b.images || []).forEach(img => addUsage(img.src, `"${entry.title}" — gallery`));
        if (b.type === 'group') walk(b.items);
      }
    };
    walk(detail.blocks);
  }
  return { usage, external };
}

async function loadMedia() {
  const [files, { usage, external }] = await Promise.all([
    gh.listFolder('assets/uploads'),
    buildSiteWideUsageMap()
  ]);
  // Filenames are "<timestamp>-<seq>-name", so a plain descending sort puts
  // the most recently uploaded files first.
  mediaFiles = files.sort((a, b) => b.name.localeCompare(a.name));
  mediaUsage = usage;
  externalMedia = Array.from(external.entries()).map(([url, usedBy]) => ({ url, usedBy }));
  markSynced('mediaSyncStatus');
  renderMediaGrid();
}

function isImagePath(name) {
  return /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(name);
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function renderMediaGrid() {
  const grid = document.getElementById('mediaGrid');
  if (!mediaFiles.length && !externalMedia.length) { grid.innerHTML = '<p class="hint">No uploads yet.</p>'; return; }

  const repoCards = mediaFiles.map(f => {
    const usedBy = mediaUsage.get(f.path);
    const preview = isImagePath(f.name)
      ? `<img src="${gh.rawUrl(f.path)}" alt="">`
      : `<div class="media-file-icon">📄<span>${(f.name.split('.').pop() || 'file').toUpperCase()}</span></div>`;
    return `
      <div class="media-item">
        ${preview}
        <div class="media-meta">
          <span class="media-name" title="${f.name}">${f.name}</span>
          <span class="media-size">${formatBytes(f.size)}</span>
          <span class="media-usage ${usedBy ? 'in-use' : 'unused'}">${usedBy ? usedBy.join(', ') : 'Not used anywhere'}</span>
        </div>
        <div class="media-actions">
          <button class="btn-admin secondary small" data-media-download="${f.path}">Download</button>
          <button class="btn-admin danger small" data-media-delete="${f.path}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Images the site references but that were never uploaded through here —
  // e.g. still hotlinked from the old Wix site. Shown separately: there's
  // nothing here to delete (we don't own the file) and a forced download
  // can't be guaranteed to work cross-origin, so this links to the original
  // instead — open it, then save/re-upload manually to bring it in properly.
  const externalCards = externalMedia.map(m => `
    <div class="media-item media-item--external">
      <img src="${m.url}" alt="" loading="lazy">
      <div class="media-meta">
        <span class="media-name" title="${m.url}">External image</span>
        <span class="media-size">Not hosted in this repo</span>
        <span class="media-usage in-use">${m.usedBy.join(', ')}</span>
      </div>
      <div class="media-actions">
        <a class="btn-admin secondary small" href="${m.url}" target="_blank" rel="noopener" style="flex:1; text-align:center;">View original</a>
      </div>
    </div>
  `).join('');

  grid.innerHTML = `
    ${mediaFiles.length ? `<h3 class="media-section-heading">Uploaded through this dashboard (${mediaFiles.length})</h3><div class="media-grid">${repoCards}</div>` : ''}
    ${externalMedia.length ? `<h3 class="media-section-heading">Still hosted elsewhere (${externalMedia.length}) — download from "View original" and re-upload here to bring these into the dashboard</h3><div class="media-grid">${externalCards}</div>` : ''}
  `;
}

document.getElementById('mediaGrid').addEventListener('click', (e) => {
  const dlBtn = e.target.closest('[data-media-download]');
  if (dlBtn) {
    const path = dlBtn.dataset.mediaDownload;
    withBusy(dlBtn, 'Downloading…', async () => {
      try {
        const res = await fetch(gh.rawUrl(path));
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        toast('Download failed: ' + err.message, 'err');
      }
    });
    return;
  }

  const delBtn = e.target.closest('[data-media-delete]');
  if (delBtn) {
    const path = delBtn.dataset.mediaDelete;
    const usedBy = mediaUsage.get(path);
    const name = path.split('/').pop();
    const msg = usedBy
      ? `"${name}" is currently used by: ${usedBy.join(', ')}.\n\nDeleting it will break that image on the live site. Delete anyway?`
      : `Delete "${name}"? Download it first if you might need it again — this can't be undone from here.`;
    if (!confirm(msg)) return;
    withBusy(delBtn, 'Deleting…', async () => {
      try {
        await gh.commitBatch([{ path, delete: true }], `Delete unused upload: ${name}`);
        await loadMedia();
        toast('Deleted.', 'ok');
      } catch (err) {
        toast('Delete failed: ' + err.message, 'err');
      }
    });
  }
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
          ${p.contentType !== 'legacy' ? `<button class="btn-admin secondary small" data-duplicate="${p.slug}" title="Duplicate as a starting point for a new project">⧉ Duplicate</button>` : ''}
        </div>
      </div>
    `).join('') || '<p class="hint">No projects yet.</p>';
  });
}

document.querySelectorAll('.admin-main').forEach(main => {
  main.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      if (projectSaveInFlight) { toast('Still saving the current project — one second.', 'info'); return; }
      if (projectDirty && !confirm('Discard unsaved changes to the project you\'re currently editing?')) return;
      clearAutosave(AUTOSAVE_PROJECT_KEY);
      openEditor(editBtn.dataset.edit); return;
    }

    const addBtn = e.target.closest('[data-add-project]');
    if (addBtn) {
      if (projectSaveInFlight) { toast('Still saving the current project — one second.', 'info'); return; }
      if (projectDirty && !confirm('Discard unsaved changes to the project you\'re currently editing?')) return;
      clearAutosave(AUTOSAVE_PROJECT_KEY);
      openEditor(null, addBtn.dataset.addProject); return;
    }

    const moveBtn = e.target.closest('[data-move]');
    if (moveBtn) { moveProject(moveBtn.dataset.slug, moveBtn.dataset.move); return; }

    const dupBtn = e.target.closest('[data-duplicate]');
    if (dupBtn) {
      if (projectSaveInFlight) { toast('Still saving the current project — one second.', 'info'); return; }
      if (projectDirty && !confirm('Discard unsaved changes to the project you\'re currently editing?')) return;
      clearAutosave(AUTOSAVE_PROJECT_KEY);
      duplicateProject(dupBtn.dataset.duplicate);
      return;
    }
  });
});

// Copies a project's text/structure as a starting point for a new one.
// Pictures, gallery photos, and files are deliberately NOT copied — reusing
// the same uploaded file across two independent projects would make the
// orphan-cleanup in saveProject() (which deletes a file when ONE project
// stops referencing it) unsafe for the other project still using it. Cheaper
// and safer to just ask her to re-add images to the copy.
async function duplicateProject(slug) {
  try {
    projectsIndex = await fetchFreshIndex();
    const entry = projectsIndex.find(p => p.slug === slug);
    if (!entry || entry.contentType === 'legacy') {
      toast('That project can\'t be duplicated this way.', 'info');
      return;
    }
    const detail = await gh.getJSON(`data/projects/${slug}.json`) || { blocks: [] };

    editingSlug = null;
    currentDraft = {
      slug: null, title: `${entry.title} copy`, href: '', group: entry.group,
      order: projectsIndex.filter(p => p.group === entry.group).length + 1,
      contentType: 'managed', thumbnail: {}, thumbnailFile: null,
      eyebrow: detail.eyebrow || '', metaLine: (detail.meta || []).join(' · '),
      blocks: stripImagesForDuplicate(detail.blocks && detail.blocks.length ? detail.blocks : [blankBlock('title')])
    };
    currentDraft._originalPaths = new Set();
    projectDirty = true;

    document.getElementById('projectEditor').classList.remove('hidden');
    document.getElementById('projectEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderEditor();
    toast('Duplicated as a new draft — pictures, gallery photos, files, and the thumbnail need to be re-added.', 'info');
  } catch (e) {
    toast('Duplicate failed: ' + e.message, 'err');
  }
}

function stripImagesForDuplicate(blocks) {
  return (blocks || []).map(b => {
    const copy = { ...b };
    if (copy.type === 'picture' || copy.type === 'file') copy.src = '';
    if (copy.type === 'file') copy.coverSrc = '';
    if (copy.type === 'gallery') copy.images = [];
    if (copy.type === 'group') copy.items = stripImagesForDuplicate(copy.items);
    return copy;
  });
}

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
  // Snapshot of every repo-hosted file this project references right now, so
  // saveProject() can tell which uploads fell out of use (replaced/removed)
  // and delete them instead of leaving them orphaned in the repo.
  currentDraft._originalPaths = collectReferencedPaths(currentDraft);
  projectDirty = false;
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
  document.getElementById('previewProjectBtn').classList.toggle('hidden', legacy);
  document.getElementById('previewMobileBtn').classList.toggle('hidden', legacy);
  document.getElementById('groupSelectionControls').classList.toggle('hidden', legacy);
  document.getElementById('deleteProjectBtn').style.display = currentDraft.slug ? '' : 'none';

  if (!legacy) renderBlocks();
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// A Title block starts a new colored section on the live page (see
// project-render.js's band grouping) — this divider makes that boundary
// visible while scrolling a long block list, which is otherwise a single
// flat list with no indication of where one section ends and the next
// begins until you actually read each Title block's text.
function sectionDividerHTML(titleBlock) {
  const swatch = titleBlock.bgColor
    ? `<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${escapeHTML(titleBlock.bgColor)}; border:1px solid var(--a-line); margin-right:0.4rem; flex-shrink:0;"></span>`
    : '';
  const label = titleBlock.text ? `"${escapeHTML(titleBlock.text)}"` : '(untitled section)';
  return `<div class="section-divider">${swatch}New section — ${label}</div>`;
}

// Indices into currentDraft.blocks that are checked for the "select blocks,
// then Make Group" flow. Index-based, so it's cleared on every renderBlocks()
// call EXCEPT the one triggered by toggling a checkbox itself — otherwise a
// reorder/add/remove elsewhere in the list (which does call renderBlocks())
// would silently desync the selection from what's actually checked.
let selectedBlockIndices = new Set();

function updateGroupSelectionBar() {
  const countEl = document.getElementById('groupSelectionCount');
  const btn = document.getElementById('makeGroupBtn');
  if (!countEl || !btn) return;
  const n = selectedBlockIndices.size;
  countEl.textContent = n > 0 ? `${n} block${n === 1 ? '' : 's'} selected.` : 'Select 2+ blocks below to group them.';
  btn.disabled = n < 2;
}

function renderBlocks() {
  selectedBlockIndices.clear();
  const wrap = document.getElementById('pe-blocks');
  wrap.innerHTML = currentDraft.blocks.map((block, i) => {
    const divider = block.type === 'title' && i > 0 ? sectionDividerHTML(block) : '';
    return divider + blockEditorHTML(block, i);
  }).join('');
  updateGroupSelectionBar();
}

// WCAG relative-luminance contrast ratio between two hex colors, so the
// section color pickers can warn about a background/text combo that would
// be genuinely hard to read (e.g. near-white on white) before she saves it.
function hexToRgb(hex) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function relLuminance([r, g, b]) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrastRatio(hex1, hex2) {
  const l1 = relLuminance(hexToRgb(hex1));
  const l2 = relLuminance(hexToRgb(hex2));
  const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Small visual diagram (a two-tone box) per option, so picking a group's
// text/media arrangement or a gallery's column count is "click the picture
// that looks right" instead of parsing a sentence in a <select>.
function layoutPickerHTML(action, attrs, options, current) {
  return `<div class="layout-picker">
    ${options.map(o => `
      <button type="button" class="layout-option${o.value === current ? ' active' : ''}" data-action="${action}" data-value="${o.value}" ${attrs} title="${o.label}">
        ${o.icon}
        <span class="layout-option-label">${o.label}</span>
      </button>
    `).join('')}
  </div>`;
}
function groupLayoutIcon(kind) {
  const media = '<span class="li-media"></span>';
  const text = '<span class="li-text"></span>';
  if (kind === 'media-right') return `<span class="layout-icon">${text}${media}</span>`;
  if (kind === 'media-left') return `<span class="layout-icon">${media}${text}</span>`;
  if (kind === 'media-above') return `<span class="layout-icon vertical">${media}${text}</span>`;
  if (kind === 'media-below') return `<span class="layout-icon vertical">${text}${media}</span>`;
  return `<span class="layout-icon"><span class="li-media" style="flex:0.4;"></span><span class="li-text" style="flex:0.6;"></span></span>`; // auto
}
function galleryColumnsIcon(value) {
  const n = value === 'auto' ? 3 : parseInt(value, 10);
  const cell = value === 'auto' ? 'li-text' : 'li-media';
  return `<span class="layout-icon">${Array.from({ length: n }).map(() => `<span class="${cell}"></span>`).join('')}</span>`;
}
const BLOCK_SIZE_LABELS = { xs: 'XS', small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'XL' };
function blockSizeIcon(size) {
  const d = { xs: '6px', small: '10px', medium: '15px', large: '20px', xlarge: '25px' }[size];
  return `<span class="layout-icon size-icon"><span class="li-media" style="width:${d}; height:${d};"></span></span>`;
}
function blockSizePickerHTML(block, attrs) {
  const current = block.size || 'medium';
  const options = ['xs', 'small', 'medium', 'large', 'xlarge'].map(v => ({
    value: v, label: BLOCK_SIZE_LABELS[v], icon: blockSizeIcon(v)
  }));
  return `<label class="hint" style="display:block; margin-top:0.4rem;">Size on the page</label>${layoutPickerHTML('blockSize', attrs, options, current)}`;
}
function alignIcon(align) {
  // The three bars have different widths on purpose — align-items is what
  // actually staggers their edges to look like left/center/right-aligned
  // text; justify-content on the outer box alone (the previous version)
  // only nudges the whole bars-block a couple pixels and all three options
  // end up looking identical.
  const alignItems = { left: 'flex-start', center: 'center', right: 'flex-end' }[align];
  return `<span class="layout-icon align-icon">
    <span class="align-bars" style="align-items:${alignItems};">
      <span class="li-media" style="width:24px;"></span>
      <span class="li-media" style="width:16px;"></span>
      <span class="li-media" style="width:20px;"></span>
    </span>
  </span>`;
}
function alignPickerHTML(block, attrs) {
  const current = block.align || 'left';
  const options = ['left', 'center', 'right'].map(v => ({
    value: v, label: v[0].toUpperCase() + v.slice(1), icon: alignIcon(v)
  }));
  return `<label class="hint" style="display:block; margin-top:0.4rem;">Alignment</label>${layoutPickerHTML('blockAlign', attrs, options, current)}`;
}
function mediaLayoutIcon(kind) {
  if (kind === 'grid') return `<span class="layout-icon"><span class="li-media"></span><span class="li-media"></span><span class="li-media"></span><span class="li-media"></span></span>`;
  return `<span class="layout-icon vertical"><span class="li-media"></span><span class="li-media"></span></span>`;
}

// Checkbox for the "select blocks, then Make Group" flow — only top-level
// blocks are selectable (gi == null); Title/Group blocks can't be grouped so
// their checkbox is disabled rather than letting them be selected and
// rejected afterward.
function selectCheckboxHTML(i, gi, type) {
  if (gi != null) return '';
  const disallowed = type === 'title' || type === 'group';
  const checked = selectedBlockIndices.has(i) ? 'checked' : '';
  return `<input type="checkbox" class="select-block-checkbox" data-action="selectBlock" data-i="${i}" ${checked} ${disallowed ? 'disabled' : ''} title="${disallowed ? "Can't go in a group" : 'Select to group with other blocks'}">`;
}

function blockEditorHTML(block, i, gi) {
  const attrs = dataAttrs(i, gi);
  let fields = '';

  if (block.type === 'title') {
    const hasCustom = block.bgColor || block.textColor;
    const effectiveBg = block.bgColor || '#fdfbe8';
    const effectiveText = block.textColor || '#17152e';
    const lowContrast = hasCustom && contrastRatio(effectiveBg, effectiveText) < 3;
    fields = `
      <input type="text" placeholder="Title text" value="${(block.text || '').replace(/"/g, '&quot;')}" data-action="text" ${attrs}>
      <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-top:0.3rem;">
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; color:var(--a-ink-soft);">
          Section background
          <input type="color" value="${block.bgColor || '#fdfbe8'}" data-action="bgColor" ${attrs}>
        </label>
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; color:var(--a-ink-soft);">
          Section text
          <input type="color" value="${block.textColor || '#17152e'}" data-action="textColor" ${attrs}>
        </label>
        ${hasCustom ? `<button type="button" class="btn-admin secondary small" data-action="resetSectionColor" ${attrs}>Reset to automatic</button>` : ''}
      </div>
      <p class="hint" style="margin:0.2rem 0 0;">${hasCustom ? 'Custom colors — this section starts a new title, so this also colors everything until the next one.' : 'This title starts a new section — leave the colors as-is to use the automatic alternating pattern, or set your own above.'}</p>
      ${lowContrast ? `<p class="hint" style="color:var(--a-danger); margin:0.2rem 0 0;">⚠ Low contrast — this text may be hard to read on this background.</p>` : ''}
      ${alignPickerHTML(block, attrs)}
    `;
  } else if (block.type === 'subtitle') {
    fields = `
      <input type="text" placeholder="Subtitle text" value="${(block.text || '').replace(/"/g, '&quot;')}" data-action="text" ${attrs}>
      ${alignPickerHTML(block, attrs)}
    `;
  } else if (block.type === 'paragraph') {
    fields = `<textarea placeholder="Paragraph text" data-action="text" ${attrs} rows="3">${block.text || ''}</textarea>`;
  } else if (block.type === 'file') {
    const coverPreview = block._coverPreviewSrc || block.coverSrc;
    fields = `
      <input type="text" placeholder="Label (e.g. Download CV)" value="${(block.label || '').replace(/"/g, '&quot;')}" data-action="label" ${attrs}>
      <input type="file" data-action="fileUpload" ${attrs}>
      ${block.src || block._pendingFile ? `<span class="hint">${block._pendingFile ? block._pendingFile.name : 'File attached'}</span>` : ''}
      <label class="hint" style="display:block; margin-top:0.3rem;">Cover image (optional — shown as a preview instead of a generic file icon)</label>
      <input type="file" accept="image/*" data-action="fileCoverUpload" ${attrs}>
      ${coverPreview ? `<img src="${coverPreview}" alt="" style="width:70px;height:90px;object-fit:cover;border-radius:4px;margin-top:0.3rem;">` : ''}
      ${coverPreview ? `<button type="button" class="btn-admin secondary small" data-action="removeFileCover" ${attrs} style="margin-top:0.3rem; width:fit-content;">Remove cover image</button>` : ''}
      ${blockSizePickerHTML(block, attrs)}
    `;
  } else if (block.type === 'picture') {
    fields = `
      <input type="file" accept="image/*" data-action="pictureUpload" ${attrs}>
      <input type="text" placeholder="Alt text" value="${(block.alt || '').replace(/"/g, '&quot;')}" data-action="alt" ${attrs}>
      ${block.src || block._previewSrc ? `<img src="${block._previewSrc || block.src}" alt="" class="picture-drag-thumb" draggable="true" ${attrs} style="width:70px;height:90px;object-fit:cover;border-radius:4px;">` : ''}
      ${block.src || block._previewSrc ? `<p class="hint" style="margin:0.2rem 0 0;">Drag this photo into a Gallery block to move it there.</p>` : ''}
      ${blockSizePickerHTML(block, attrs)}
    `;
  } else if (block.type === 'gallery') {
    const currentCols = block.columns && block.columns !== 'auto' ? block.columns : 'auto';
    const columnsOptions = ['auto', '2', '3', '4'].map(v => ({
      value: v, label: v === 'auto' ? 'Auto' : v, icon: galleryColumnsIcon(v)
    }));
    fields = `
      <input type="file" accept="image/*" multiple data-action="galleryUpload" ${attrs}>
      <label class="hint" style="display:block; margin-top:0.4rem;">Columns</label>
      ${layoutPickerHTML('galleryColumns', attrs, columnsOptions, currentCols)}
      <div style="display:flex; gap:1.2rem; flex-wrap:wrap; align-items:center; margin-top:0.5rem;">
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; color:var(--a-ink-soft);">
          <input type="checkbox" data-action="galleryUniform" ${attrs} ${block.uniform === false ? '' : 'checked'}>
          Crop photos to a consistent grid
        </label>
        <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; color:var(--a-ink-soft);">
          <input type="checkbox" data-action="galleryStagger" ${attrs} ${block.stagger === false ? '' : 'checked'}>
          Offset alternating photos
        </label>
      </div>
      <div class="gallery-images" ${attrs}>
        ${(block.images || []).map((img, imgI) => `
          <div class="gallery-image-item" ${attrs} data-imgi="${imgI}" draggable="true">
            <img src="${img._previewSrc || img.src}" alt="">
            <input type="text" class="gallery-alt-input" placeholder="Alt text" value="${(img.alt || '').replace(/"/g, '&quot;')}" data-action="galleryAlt" ${attrs} data-imgi="${imgI}">
            <button data-action="removeGalleryImage" ${attrs} data-imgi="${imgI}" title="Remove">&times;</button>
          </div>
        `).join('')}
      </div>
      <p class="hint" style="margin:0.3rem 0 0;">Drag photos to reorder — or drag one into a different Gallery block to move it there. Used as the side media in a "text left/right" group, this always stacks to one column and ignores the crop/offset settings above (they don't apply with only one column) unless you explicitly turn them on.</p>
    `;
  } else if (block.type === 'group') {
    const items = block.items || [];
    const currentLayout = block.layout || 'auto';
    const layoutOptions = [
      { value: 'auto', label: 'Auto', icon: groupLayoutIcon('auto') },
      { value: 'media-right', label: 'Media right', icon: groupLayoutIcon('media-right') },
      { value: 'media-left', label: 'Media left', icon: groupLayoutIcon('media-left') },
      { value: 'media-above', label: 'Media above', icon: groupLayoutIcon('media-above') },
      { value: 'media-below', label: 'Media below', icon: groupLayoutIcon('media-below') }
    ];
    const mediaCount = items.filter(it => ['picture', 'gallery', 'file'].includes(it.type)).length;
    const mediaLayoutOptions = [
      { value: 'stack', label: 'Stacked', icon: mediaLayoutIcon('stack') },
      { value: 'grid', label: 'Grid', icon: mediaLayoutIcon('grid') }
    ];
    fields = `
      <label class="hint" style="display:block; margin-bottom:0.3rem;">Layout</label>
      ${layoutPickerHTML('groupLayout', attrs, layoutOptions, currentLayout)}
      ${mediaCount > 1 ? `<label class="hint" style="display:block; margin:0.5rem 0 0.3rem;">Multiple media arrangement</label>${layoutPickerHTML('groupMediaLayout', attrs, mediaLayoutOptions, block.mediaLayout || 'stack')}` : ''}
      <p class="group-hint">Text + one picture, gallery or file will be laid out side by side automatically; anything more is bound together in a bordered card — pick a layout above to control this yourself. Media with no text next to it is centered on its own instead of stretched into a card. Drag an existing block here (by its ⋮⋮ handle) to move it into this group.</p>
      <div class="group-items" data-i="${i}">
        ${items.map((sub, subI) => blockEditorHTML(sub, i, subI)).join('') || '<p class="hint">Empty — drag a block here, or add one below.</p>'}
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
        <span class="drag-handle" draggable="true" title="Drag to reorder">&#8942;&#8942;</span>
        <div class="content-item-fields">
          <strong style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--a-ink-soft);">Group</strong>
          ${fields}
        </div>
        <div class="content-item-actions">
          ${selectCheckboxHTML(i, gi, 'group')}
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
      <span class="drag-handle" draggable="true" title="Drag to reorder">&#8942;&#8942;</span>
      <div class="content-item-fields">
        <strong style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--a-ink-soft);">${BLOCK_LABELS[block.type]}</strong>
        ${fields}
      </div>
      <div class="content-item-actions">
        ${selectCheckboxHTML(i, gi, block.type)}
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

// Bundles the currently-checked top-level blocks into a new Group block, in
// their existing relative order, inserted where the first selected one was —
// the more direct alternative to dragging them in one at a time.
document.getElementById('makeGroupBtn').addEventListener('click', () => {
  if (selectedBlockIndices.size < 2) return;
  const indices = Array.from(selectedBlockIndices).sort((a, b) => a - b);
  const GROUP_ALLOWED_TYPES = ['subtitle', 'paragraph', 'file', 'picture', 'gallery'];
  const invalidIdx = indices.find(idx => !GROUP_ALLOWED_TYPES.includes(currentDraft.blocks[idx].type));
  if (invalidIdx !== undefined) {
    toast(`A ${(BLOCK_LABELS[currentDraft.blocks[invalidIdx].type] || 'this').toLowerCase()} block can't go in a group.`, 'err');
    return;
  }

  const beforeBlocks = cloneForUndo(currentDraft.blocks);
  const insertAt = indices[0];
  const grouped = indices.map(idx => currentDraft.blocks[idx]);
  for (let k = indices.length - 1; k >= 0; k--) currentDraft.blocks.splice(indices[k], 1);
  currentDraft.blocks.splice(insertAt, 0, { type: 'group', items: grouped });

  renderBlocks();
  projectDirty = true; autosaveProject();
  toast(`Grouped ${grouped.length} blocks.`, 'ok', {
    label: 'Undo',
    onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); projectDirty = true; autosaveProject(); }
  });
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

  // Deliberately doesn't call renderBlocks() — see selectedBlockIndices'
  // comment for why a full re-render would clear the selection it's tracking.
  if (action === 'selectBlock') {
    if (t.checked) selectedBlockIndices.add(i); else selectedBlockIndices.delete(i);
    updateGroupSelectionBar();
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
  if (action === 'fileCoverUpload' && t.files[0]) {
    block._pendingCoverFile = t.files[0];
    block._coverPreviewSrc = URL.createObjectURL(t.files[0]);
    renderBlocks();
  }
  if (action === 'bgColor') { block.bgColor = t.value; renderBlocks(); }
  if (action === 'textColor') { block.textColor = t.value; renderBlocks(); }
  if (action === 'galleryUniform') { block.uniform = t.checked; renderBlocks(); }
  if (action === 'galleryStagger') { block.stagger = t.checked; renderBlocks(); }
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
  if (action === 'galleryAlt') block.images[+t.dataset.imgi].alt = t.value;
  // bgColor/textColor deliberately NOT handled here — a color <input> fires
  // 'input' continuously while dragging inside the picker, and renderBlocks()
  // would replace the DOM mid-drag and close the picker. Handled on 'change'
  // (fires once, when the picker closes) instead — see below.
});

document.getElementById('pe-blocks').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const i = +btn.dataset.i;
  const gi = btn.dataset.gi !== undefined ? +btn.dataset.gi : null;
  const imgi = btn.dataset.imgi !== undefined ? +btn.dataset.imgi : null;

  if (action === 'resetSectionColor') {
    const block = resolveContainer(i, gi)[resolveIndex(i, gi)];
    delete block.bgColor; delete block.textColor;
    renderBlocks();
    projectDirty = true; autosaveProject();
    return;
  }

  if (action === 'removeFileCover') {
    const block = resolveContainer(i, gi)[resolveIndex(i, gi)];
    delete block.coverSrc; delete block._pendingCoverFile; delete block._coverPreviewSrc;
    renderBlocks();
    projectDirty = true; autosaveProject();
    return;
  }

  if (action === 'groupLayout' || action === 'galleryColumns' || action === 'blockSize' || action === 'blockAlign' || action === 'groupMediaLayout') {
    const block = resolveContainer(i, gi)[resolveIndex(i, gi)];
    if (action === 'groupLayout') block.layout = btn.dataset.value;
    else if (action === 'galleryColumns') block.columns = btn.dataset.value;
    else if (action === 'blockSize') block.size = btn.dataset.value;
    else if (action === 'blockAlign') block.align = btn.dataset.value;
    else block.mediaLayout = btn.dataset.value;
    renderBlocks();
    projectDirty = true; autosaveProject();
    return;
  }

  if (action === 'removeGalleryImage') {
    if (!confirm('Remove this image?')) return;
    const beforeBlocks = cloneForUndo(currentDraft.blocks);
    resolveContainer(i, gi)[resolveIndex(i, gi)].images.splice(imgi, 1);
    renderBlocks();
    projectDirty = true; autosaveProject();
    toast('Image removed.', 'info', {
      label: 'Undo',
      onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); projectDirty = true; autosaveProject(); }
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
    projectDirty = true; autosaveProject();
    toast(`${label} removed.`, 'info', {
      label: 'Undo',
      onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); projectDirty = true; autosaveProject(); }
    });
  }
  if (action === 'moveUp' && idx > 0) { swap(container, idx, idx - 1); renderBlocks(); projectDirty = true; autosaveProject(); }
  if (action === 'moveDown' && idx < container.length - 1) { swap(container, idx, idx + 1); renderBlocks(); projectDirty = true; autosaveProject(); }
});

// ---- drag-and-drop reordering (blocks, incl. group items, and gallery photos) ----
// The up/down buttons above remain as the reliable fallback (native HTML5 DnD
// has no touch-device equivalent) — this is purely an added convenience.
let dragState = null; // { kind: 'block'|'gallery', i, gi, imgi? }

function readDragAddr(el) {
  const gi = el.dataset.gi !== undefined && el.dataset.gi !== '' ? +el.dataset.gi : null;
  return { i: +el.dataset.i, gi };
}

document.getElementById('pe-blocks').addEventListener('dragstart', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (handle) {
    const item = handle.closest('.content-item');
    dragState = { kind: 'block', ...readDragAddr(item) };
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    return;
  }
  const pictureThumb = e.target.closest('.picture-drag-thumb');
  if (pictureThumb) {
    dragState = { kind: 'picture', ...readDragAddr(pictureThumb) };
    pictureThumb.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    return;
  }
  const galleryItem = e.target.closest('.gallery-image-item');
  if (galleryItem) {
    dragState = { kind: 'gallery', ...readDragAddr(galleryItem), imgi: +galleryItem.dataset.imgi };
    galleryItem.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }
});

document.getElementById('pe-blocks').addEventListener('dragover', (e) => {
  if (!dragState) return;
  // '.gallery-images'/'.group-items' (the containers themselves) are included
  // so dropping into empty space — an empty gallery, or a group with nothing
  // in it yet — still works, not just dropping precisely onto an existing item.
  const selector = dragState.kind === 'block' ? '.content-item, .group-items' : '.gallery-image-item, .gallery-images';
  const target = e.target.closest(selector);
  if (!target) return;
  e.preventDefault(); // required to allow a drop here
  if (!target.classList.contains('drag-over')) {
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    target.classList.add('drag-over');
  }
});

document.getElementById('pe-blocks').addEventListener('drop', (e) => {
  if (!dragState) return;
  e.preventDefault();
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

  if (dragState.kind === 'block') {
    const target = e.target.closest('.content-item, .group-items');
    if (!target) return;
    const srcContainer = resolveContainer(dragState.i, dragState.gi);
    const srcIdx = resolveIndex(dragState.i, dragState.gi);
    const movedType = srcContainer[srcIdx].type;

    // Dropped directly on a group's item area (including an empty group) —
    // append into that group. Otherwise resolve the target the normal way;
    // targetGi != null means the drop landed on an item that's itself inside
    // a group, so this move also lands inside that same group.
    let targetContainer, targetIdx, targetIsGroupItems;
    if (target.classList.contains('group-items')) {
      targetContainer = currentDraft.blocks[+target.dataset.i].items;
      targetIdx = targetContainer.length;
      targetIsGroupItems = true;
    } else {
      const { i: targetI, gi: targetGi } = readDragAddr(target);
      targetContainer = resolveContainer(targetI, targetGi);
      targetIdx = resolveIndex(targetI, targetGi);
      targetIsGroupItems = targetGi != null;
    }

    // Matches what the group's own "+ Add item to group" dropdown offers —
    // a group can't contain a Title or another Group.
    if (targetIsGroupItems && !['subtitle', 'paragraph', 'file', 'picture', 'gallery'].includes(movedType)) {
      toast(`A ${(BLOCK_LABELS[movedType] || 'this').toLowerCase()} block can't go inside a group.`, 'err');
      return;
    }

    if (srcContainer === targetContainer && srcIdx === targetIdx) return;
    const [moved] = srcContainer.splice(srcIdx, 1);
    targetContainer.splice(targetIdx, 0, moved);
  } else if (dragState.kind === 'picture') {
    // Moves a standalone Picture block's image into a Gallery block — the
    // picture block itself is removed (its image now lives in the gallery
    // instead), with an Undo toast since that's a bit more destructive than
    // a plain reorder.
    const target = e.target.closest('.gallery-image-item, .gallery-images');
    if (!target) return;
    const { i: targetI, gi: targetGi } = readDragAddr(target);
    const targetGallery = resolveContainer(targetI, targetGi)[resolveIndex(targetI, targetGi)];
    const targetImgi = target.classList.contains('gallery-images') ? targetGallery.images.length : +target.dataset.imgi;

    const srcContainer = resolveContainer(dragState.i, dragState.gi);
    const srcIdx = resolveIndex(dragState.i, dragState.gi);
    const pictureBlock = srcContainer[srcIdx];
    const beforeBlocks = cloneForUndo(currentDraft.blocks);

    const newImage = { src: pictureBlock.src || '', alt: pictureBlock.alt || '' };
    if (pictureBlock._pendingFile) newImage._pendingFile = pictureBlock._pendingFile;
    if (pictureBlock._previewSrc) newImage._previewSrc = pictureBlock._previewSrc;
    targetGallery.images.splice(targetImgi, 0, newImage);
    srcContainer.splice(srcIdx, 1);

    toast('Picture moved into the gallery.', 'info', {
      label: 'Undo',
      onClick: () => { currentDraft.blocks = beforeBlocks; renderBlocks(); projectDirty = true; autosaveProject(); }
    });
  } else {
    // Dropping on another photo inserts at that photo's position; dropping on
    // empty gallery space (including an empty gallery) appends to the end —
    // either way this also allows moving a photo into a DIFFERENT Gallery
    // block, not just reordering within the one it started in.
    const target = e.target.closest('.gallery-image-item, .gallery-images');
    if (!target) return;
    const { i: targetI, gi: targetGi } = readDragAddr(target);
    const targetGallery = resolveContainer(targetI, targetGi)[resolveIndex(targetI, targetGi)];
    const targetImgi = target.classList.contains('gallery-images') ? targetGallery.images.length : +target.dataset.imgi;

    const srcGallery = resolveContainer(dragState.i, dragState.gi)[resolveIndex(dragState.i, dragState.gi)];
    if (srcGallery === targetGallery && targetImgi === dragState.imgi) return;
    const [moved] = srcGallery.images.splice(dragState.imgi, 1);
    targetGallery.images.splice(targetImgi, 0, moved);
  }
  renderBlocks();
  projectDirty = true; autosaveProject();
});

document.getElementById('pe-blocks').addEventListener('dragend', () => {
  document.querySelectorAll('.dragging, .drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
  dragState = null;
});

function swap(arr, i, j) { const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }

const autosaveProject = debounce(() => {
  if (!currentDraft || currentDraft.contentType === 'legacy') return;
  writeAutosave(AUTOSAVE_PROJECT_KEY, {
    slug: currentDraft.slug,
    editingSlug,
    group: document.getElementById('pe-group').value,
    title: document.getElementById('pe-title').value,
    eyebrow: document.getElementById('pe-eyebrow').value,
    metaLine: document.getElementById('pe-meta').value,
    blocks: serializableBlocks(currentDraft.blocks)
  });
}, 800);

// Delegated across the whole editor panel so every text field, select, and
// file input marks the project dirty and schedules an autosave, without
// needing a listener on each dynamically-rendered control. Block-editing
// buttons (remove/move) are NOT covered here — several of those are gated
// behind a confirm() the user can cancel, and a click still bubbles here even
// when its own handler bails out early, so marking dirty on click alone would
// false-positive on a cancelled removal. Those mark dirty explicitly at their
// actual mutation point instead (see the #pe-blocks click handler below).
const projectEditorEl = document.getElementById('projectEditor');
projectEditorEl.addEventListener('input', () => { projectDirty = true; autosaveProject(); });
projectEditorEl.addEventListener('change', () => { projectDirty = true; autosaveProject(); });

async function checkProjectAutosave() {
  const stored = readAutosave(AUTOSAVE_PROJECT_KEY);
  if (!stored) return;
  const when = new Date(stored.savedAt).toLocaleString();
  const label = stored.title || '(untitled project)';
  if (!confirm(`Found an unsaved project draft "${label}" from ${when}. Resume editing it?\n\n(Any picture or file you'd selected but hadn't saved yet will need to be re-added.)`)) {
    clearAutosave(AUTOSAVE_PROJECT_KEY);
    return;
  }

  // The Projects tab starts hidden (Site & Bio is the default active tab),
  // so without switching to it first, openEditor() below would open the
  // editor "behind" a hidden tab — invisible until she happened to click
  // over to Projects herself with no clue the recovery even happened.
  document.querySelector('.admin-tabs [data-tab="projects"]').click();

  // Open against the true server baseline first (this also sets up
  // _originalPaths correctly for orphan cleanup), then overlay the recovered
  // in-progress edits on top of it.
  if (stored.editingSlug) await openEditor(stored.editingSlug);
  else await openEditor(null, stored.group);
  if (!currentDraft) return; // project vanished server-side; openEditor already reported it

  if (stored.group) currentDraft.group = stored.group;
  currentDraft.title = stored.title || currentDraft.title;
  currentDraft.eyebrow = stored.eyebrow || '';
  currentDraft.metaLine = stored.metaLine || '';
  if (stored.blocks && stored.blocks.length) currentDraft.blocks = stored.blocks;
  renderEditor();
  projectDirty = true;
  toast('Draft restored — review and save when ready.', 'info');
}

document.getElementById('cancelEditBtn').addEventListener('click', () => {
  if (projectSaveInFlight) { toast('Still saving — one second.', 'info'); return; }
  // Always confirms now, not just when dirty — the action bar being fixed
  // on screen makes this a lot easier to hit by accident than it used to be.
  const msg = projectDirty ? 'Discard unsaved changes to this project?' : 'Close this project?';
  if (!confirm(msg)) return;
  clearAutosave(AUTOSAVE_PROJECT_KEY);
  projectDirty = false;
  document.getElementById('projectEditor').classList.add('hidden');
  currentDraft = null; editingSlug = null;
});

document.getElementById('saveProjectBtn').addEventListener('click', (e) => {
  withBusy(e.target, 'Saving…', saveProject);
});

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Renders exactly what saveProject() would upload for still-unsaved picture
// selections — same WebP pass — as data: URLs, so the preview page (a
// separate tab/window) can show them without anything actually being
// committed to the repo yet.
async function buildPreviewBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    const copy = { ...b };
    if ((copy.type === 'picture' || copy.type === 'file') && copy._pendingFile) {
      copy.src = await fileToDataURL(await toWebP(copy._pendingFile));
    }
    if (copy.type === 'file' && copy._pendingCoverFile) {
      copy.coverSrc = await fileToDataURL(await toWebP(copy._pendingCoverFile));
    }
    if (copy.type === 'gallery') {
      copy.images = [];
      for (const img of (b.images || [])) {
        const imgCopy = { ...img };
        if (imgCopy._pendingFile) imgCopy.src = await fileToDataURL(await toWebP(imgCopy._pendingFile));
        delete imgCopy._pendingFile; delete imgCopy._previewSrc;
        copy.images.push(imgCopy);
      }
    }
    if (copy.type === 'group') copy.items = await buildPreviewBlocks(copy.items);
    delete copy._pendingFile; delete copy._previewSrc;
    delete copy._pendingCoverFile; delete copy._coverPreviewSrc;
    out.push(copy);
  }
  return out;
}

async function storePreviewDraft() {
  const title = document.getElementById('pe-title').value.trim() || currentDraft.title || 'Untitled';
  const eyebrow = document.getElementById('pe-eyebrow').value.trim();
  const metaLine = document.getElementById('pe-meta').value.trim();
  const previewData = {
    title, eyebrow,
    meta: metaLine ? metaLine.split('·').map(s => s.trim()).filter(Boolean) : [],
    blocks: await buildPreviewBlocks(currentDraft.blocks)
  };
  sessionStorage.setItem('zita-preview-draft', JSON.stringify(previewData));
}

document.getElementById('previewProjectBtn').addEventListener('click', async (e) => {
  if (!currentDraft || currentDraft.contentType === 'legacy') return;
  withBusy(e.target, 'Preparing preview…', async () => {
    try {
      await storePreviewDraft();
      window.open('project.html?preview=1', '_blank');
    } catch (e2) {
      toast('Could not open preview: ' + e2.message, 'err');
    }
  });
});

document.getElementById('previewMobileBtn').addEventListener('click', async (e) => {
  if (!currentDraft || currentDraft.contentType === 'legacy') return;
  withBusy(e.target, 'Preparing preview…', async () => {
    try {
      await storePreviewDraft();
      // A real popup window (not a tab) sized like a phone, so the page's own
      // responsive CSS renders the mobile layout instead of the desktop one.
      window.open('project.html?preview=1', 'zita-mobile-preview', 'width=390,height=844,menubar=no,toolbar=no,location=no,status=no');
    } catch (e2) {
      toast('Could not open preview: ' + e2.message, 'err');
    }
  });
});

function makeUploadReporter(setLabel, total) {
  let done = 0;
  return () => {
    done++;
    if (setLabel) setLabel(total > 1 ? `Uploading image ${done}/${total}…` : 'Uploading image…');
  };
}

// onStep(), if given, is called right before each individual upload starts —
// used to report "uploading N/M" progress on the save button. Pushes each
// prepared file into `files` (for a single batched commit) rather than
// uploading it immediately — the resulting raw.githubusercontent.com URL is
// deterministic from the path, so block.src can be set right away.
async function preparePendingFiles(block, files, onStep) {
  if ((block.type === 'file' || block.type === 'picture') && block._pendingFile) {
    if (onStep) onStep();
    const prepared = await gh.prepareUpload(block._pendingFile, 'assets/uploads', { optimize: block.type === 'picture' });
    files.push({ path: prepared.path, content: prepared.content });
    block.src = prepared.url;
    delete block._pendingFile; delete block._previewSrc;
  }
  if (block.type === 'file' && block._pendingCoverFile) {
    if (onStep) onStep();
    const prepared = await gh.prepareUpload(block._pendingCoverFile, 'assets/uploads', { optimize: true });
    files.push({ path: prepared.path, content: prepared.content });
    block.coverSrc = prepared.url;
    delete block._pendingCoverFile; delete block._coverPreviewSrc;
  }
  if (block.type === 'gallery') {
    for (const img of block.images) {
      if (img._pendingFile) {
        if (onStep) onStep();
        const prepared = await gh.prepareUpload(img._pendingFile, 'assets/uploads');
        files.push({ path: prepared.path, content: prepared.content });
        img.src = prepared.url;
        delete img._pendingFile; delete img._previewSrc;
      }
    }
  }
}

function countPendingFiles(blocks) {
  let n = 0;
  for (const block of blocks) {
    if ((block.type === 'file' || block.type === 'picture') && block._pendingFile) n++;
    if (block.type === 'file' && block._pendingCoverFile) n++;
    if (block.type === 'gallery') n += (block.images || []).filter(img => img._pendingFile).length;
    if (block.type === 'group') n += countPendingFiles(block.items || []);
  }
  return n;
}

// Screen readers rely on alt text — counts pictures/gallery photos missing it
// so saveProject() can give a gentle (non-blocking) heads-up before publishing.
function countMissingAlt(blocks) {
  let n = 0;
  for (const block of blocks || []) {
    if (block.type === 'picture' && !(block.alt || '').trim()) n++;
    if (block.type === 'gallery') n += (block.images || []).filter(img => !(img.alt || '').trim()).length;
    if (block.type === 'group') n += countMissingAlt(block.items || []);
  }
  return n;
}

async function saveProject(setLabel) {
  projectSaveInFlight = true;
  document.getElementById('projectEditor').classList.add('pe-saving');
  const draft = currentDraft; // keep working against this project even if currentDraft is later reassigned
  try {
    currentDraft.title = document.getElementById('pe-title').value.trim();
    if (!currentDraft.title) { toast('Give the project a title first.', 'err'); return; }
    currentDraft.group = document.getElementById('pe-group').value;
    currentDraft.eyebrow = document.getElementById('pe-eyebrow').value.trim();
    currentDraft.metaLine = document.getElementById('pe-meta').value.trim();

    const missingAlt = countMissingAlt(currentDraft.blocks);
    if (missingAlt > 0) {
      const noun = missingAlt === 1 ? 'photo is' : 'photos are';
      if (!confirm(`${missingAlt} ${noun} missing alt text (used by screen readers to describe images). Save anyway?`)) return;
    }

    const files = []; // batched into a single commit alongside the JSON writes below
    const thumbFile = document.getElementById('pe-thumb').files[0];
    const totalUploads = (thumbFile ? 1 : 0) + countPendingFiles(currentDraft.blocks || []);
    const reportStep = makeUploadReporter(setLabel, totalUploads);

    if (thumbFile) {
      reportStep();
      const prepared = await gh.prepareUpload(thumbFile, 'assets/uploads');
      files.push({ path: prepared.path, content: prepared.content });
      currentDraft.thumbnail = { src: prepared.url, alt: currentDraft.title };
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

      // prepare any pending files for this project's blocks (including
      // items nested inside a group block) — uploaded as part of the single
      // batched commit below, not individually
      for (const block of currentDraft.blocks) {
        await preparePendingFiles(block, files, reportStep);
        if (block.type === 'group') {
          for (const sub of block.items) await preparePendingFiles(sub, files, reportStep);
        }
      }

      if (setLabel) setLabel('Saving details…');
      const detail = {
        title: currentDraft.title,
        eyebrow: currentDraft.eyebrow,
        meta: currentDraft.metaLine ? currentDraft.metaLine.split('·').map(s => s.trim()).filter(Boolean) : [],
        blocks: currentDraft.blocks
      };
      files.push({ path: `data/projects/${slug}.json`, content: JSON.stringify(detail, null, 2) });
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
    files.push({ path: 'data/projects-index.json', content: JSON.stringify(freshIndex, null, 2) });

    // Any file this project referenced when the editor was opened but no
    // longer references now (thumbnail replaced, picture/file block removed,
    // gallery photo removed) is now orphaned in the repo — delete it in the
    // same commit rather than leaving it behind forever.
    const newPaths = collectReferencedPaths(currentDraft);
    for (const oldPath of (draft._originalPaths || [])) {
      if (!newPaths.has(oldPath)) files.push({ path: oldPath, delete: true });
    }

    await gh.commitBatch(files, `Save project: ${currentDraft.title}`);
    projectsIndex = freshIndex;

    toast('Project saved.', 'ok');
    showBuildStatus();
    clearAutosave(AUTOSAVE_PROJECT_KEY);
    // Only clear/hide the editor if it's still showing the project we just
    // saved — guards against a future entry point reassigning currentDraft
    // out from under this in-flight save.
    if (currentDraft === draft) {
      projectDirty = false;
      document.getElementById('projectEditor').classList.add('hidden');
      currentDraft = null; editingSlug = null;
    }
    renderProjectLists();
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  } finally {
    projectSaveInFlight = false;
    document.getElementById('projectEditor').classList.remove('pe-saving');
  }
}

document.getElementById('deleteProjectBtn').addEventListener('click', async () => {
  if (!currentDraft || !currentDraft.slug) return;
  if (projectSaveInFlight) { toast('Still saving — one second.', 'info'); return; }
  if (!confirm(`Delete "${currentDraft.title}"? This removes it from the homepage. Its page file (if custom-built) is not deleted.`)) return;
  try {
    const freshBefore = await fetchFreshIndex();
    const deletedEntry = freshBefore.find(p => p.slug === currentDraft.slug);
    const deletedDetail = currentDraft.contentType !== 'legacy'
      ? await gh.getJSON(`data/projects/${currentDraft.slug}.json`)
      : null;

    const afterDelete = freshBefore.filter(p => p.slug !== currentDraft.slug);
    const deleteFiles = [];
    if (currentDraft.contentType !== 'legacy') {
      deleteFiles.push({ path: `data/projects/${currentDraft.slug}.json`, delete: true });
    }
    deleteFiles.push({ path: 'data/projects-index.json', content: JSON.stringify(afterDelete, null, 2) });
    await gh.commitBatch(deleteFiles, `Delete project: ${currentDraft.title}`);
    projectsIndex = afterDelete;

    clearAutosave(AUTOSAVE_PROJECT_KEY);
    projectDirty = false;
    document.getElementById('projectEditor').classList.add('hidden');
    currentDraft = null; editingSlug = null;
    renderProjectLists();

    toast('Project deleted.', 'ok', {
      label: 'Undo',
      onClick: async () => {
        try {
          const freshNow = await fetchFreshIndex();
          freshNow.push(deletedEntry);
          const restoreFiles = [];
          if (deletedDetail) restoreFiles.push({ path: `data/projects/${deletedEntry.slug}.json`, content: JSON.stringify(deletedDetail, null, 2) });
          restoreFiles.push({ path: 'data/projects-index.json', content: JSON.stringify(freshNow, null, 2) });
          await gh.commitBatch(restoreFiles, `Restore project: ${deletedEntry.title}`);
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

// The action bar's collapsed/expanded state is a personal preference, not
// per-project data, so it lives in its own localStorage key and applies
// immediately on load rather than waiting for a project to be opened.
const ACTION_BAR_COLLAPSED_KEY = 'zita-admin-actionbar-collapsed';
const actionBarEl = document.getElementById('peActionBar');
const actionBarToggleEl = document.getElementById('toggleActionBarBtn');

function setActionBarCollapsed(collapsed) {
  actionBarEl.classList.toggle('collapsed', collapsed);
  actionBarToggleEl.textContent = collapsed ? '▴' : '▾';
  actionBarToggleEl.title = collapsed ? 'Show actions' : 'Hide this bar';
}
actionBarToggleEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const collapsed = !actionBarEl.classList.contains('collapsed');
  setActionBarCollapsed(collapsed);
  localStorage.setItem(ACTION_BAR_COLLAPSED_KEY, collapsed ? '1' : '0');
});
setActionBarCollapsed(localStorage.getItem(ACTION_BAR_COLLAPSED_KEY) === '1');

initConnect();
