// Minimal client-side GitHub Contents API wrapper used by admin.html.
// Nothing here is sent anywhere except api.github.com — the token lives
// only in this browser's localStorage.

const GH_STORAGE_KEY = 'zita-admin-github';

const GitHubStore = {
  load() {
    try { return JSON.parse(localStorage.getItem(GH_STORAGE_KEY)) || null; }
    catch { return null; }
  },
  save(cfg) { localStorage.setItem(GH_STORAGE_KEY, JSON.stringify(cfg)); },
  clear() { localStorage.removeItem(GH_STORAGE_KEY); }
};

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// Monotonic-ish uniqueifier for upload paths. Date.now() alone can collide
// when several files are prepared back-to-back with no network wait between
// them (batch commits removed that natural spacing).
let uploadSeq = 0;
function uniqueUploadName(safeName) {
  uploadSeq += 1;
  return `${Date.now()}-${uploadSeq}-${safeName}`;
}

// Re-encodes an image File as WebP, capped to a reasonable web size.
// SVGs are left alone (already small/vector). Falls back to the original
// file if the browser can't decode/encode it (e.g. no WebP support).
async function toWebP(file, { maxDimension = 2000, quality = 0.82 } = {}) {
  if (!file.type || !file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > maxDimension || height > maxDimension) {
      const scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) return file;
    const newName = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], newName, { type: 'image/webp' });
  } catch (e) {
    console.warn('WebP conversion failed, uploading original file instead.', e);
    return file;
  }
}

class GitHubAPI {
  constructor({ token, owner, repo, branch }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || 'main';
  }

  get base() { return `https://api.github.com/repos/${this.owner}/${this.repo}`; }

  headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  async verify() {
    const res = await fetch(this.base, { headers: this.headers() });
    if (!res.ok) {
      if (res.status === 401) throw new Error('GitHub rejected this token — it may be invalid or expired. Generate a new one and reconnect.');
      if (res.status === 404) throw new Error('Repository not found — check owner/repo.');
      const err = await res.json().catch(() => ({}));
      if (res.status === 403) throw new Error(err.message || 'GitHub denied access — check the token has "Contents: Read and write" permission for this repository.');
      throw new Error(err.message || `GitHub error ${res.status}`);
    }
    return res.json();
  }

  // Lists files directly inside a repo folder (non-recursive). Returns [] for
  // a folder that doesn't exist yet (e.g. no uploads made yet) instead of
  // throwing, since that's a normal/expected state, not an error.
  async listFolder(path) {
    const url = `${this.base}/contents/${encodeURI(path)}?ref=${this.branch}&_=${Date.now()}`;
    const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Failed to list ${path} (${res.status})`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).filter(f => f.type === 'file');
  }

  // Returns { content: string, sha: string } or null if the file doesn't exist.
  // cache:'no-store' + a cache-busting param so this always reflects the true
  // current state of the file, never a browser-cached copy from earlier in
  // the session — that staleness is what causes accidental overwrites.
  async getFile(path) {
    const url = `${this.base}/contents/${encodeURI(path)}?ref=${this.branch}&_=${Date.now()}`;
    const res = await fetch(url, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to read ${path} (${res.status})`);
    const data = await res.json();
    return { content: base64ToUtf8(data.content), sha: data.sha };
  }

  async getJSON(path) {
    const file = await this.getFile(path);
    return file ? JSON.parse(file.content) : null;
  }

  // Like getJSON, but also returns the file's current sha so callers can
  // detect "this changed since I loaded it" before overwriting.
  async getJSONWithSha(path) {
    const file = await this.getFile(path);
    return file ? { data: JSON.parse(file.content), sha: file.sha } : { data: null, sha: null };
  }

  // content: raw string (text) or { base64: '...' } for binary uploads.
  async putFile(path, content, message) {
    const existing = await this.getFile(path).catch(() => null);
    const body = {
      message,
      content: typeof content === 'string' ? utf8ToBase64(content) : content.base64,
      branch: this.branch
    };
    if (existing) body.sha = existing.sha;

    const res = await fetch(`${this.base}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to save ${path} (${res.status})`);
    }
    return res.json();
  }

  async putJSON(path, obj, message) {
    return this.putFile(path, JSON.stringify(obj, null, 2), message);
  }

  async deleteFile(path, message) {
    const existing = await this.getFile(path);
    if (!existing) return; // already gone
    const res = await fetch(`${this.base}/contents/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha: existing.sha, branch: this.branch })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to delete ${path} (${res.status})`);
    }
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
  }

  // Inverse of rawUrl() — returns the repo-relative path if this URL points at
  // a file in this repo/branch, or null for anything else (external URLs from
  // before the dashboard existed, e.g. the original Wix-hosted photo, are left
  // alone rather than mistaken for something we can delete).
  pathFromRawUrl(url) {
    if (!url) return null;
    const prefix = this.rawUrl('');
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }

  uniquePath(name, folder = 'assets/uploads') {
    const safeName = name.replace(/[^a-zA-Z0-9.\-_]/g, '-');
    return `${folder}/${uniqueUploadName(safeName)}`;
  }

  // Reads a File/Blob and gets it ready for a batch commit — does NOT touch
  // the network. Returns { path, content, url }: `url` is the raw.githubusercontent.com
  // URL the file will have once committed (safe to use immediately, e.g. in JSON
  // that's part of the same batch), and `content` is what commitBatch() expects.
  // Images are re-encoded to WebP (and downsized if huge) unless { optimize: false }
  // is passed — used for non-picture file attachments (e.g. a CV or a "file" block).
  async prepareUpload(file, folder = 'assets/uploads', { optimize = true } = {}) {
    if (optimize) file = await toWebP(file);
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const path = this.uniquePath(file.name, folder);
    return { path, content: { base64 }, url: this.rawUrl(path) };
  }

  // Commits any number of file changes as a single atomic commit + push, so one
  // user action (e.g. "Save project" touching several images plus two JSON files)
  // triggers exactly one GitHub Pages deploy instead of one per file.
  // files: [{ path, content }] to add/update (content: string or { base64 }),
  // or [{ path, delete: true }] to remove a path.
  async commitBatch(files, message) {
    if (!files.length) return null;

    // Blob creation is content-addressed and independent of the branch tip, so
    // it only needs to happen once — even if committing below has to retry
    // against a moved tip, these shas are still valid.
    const treeEntries = await Promise.all(files.map(async (f) => {
      if (f.delete) return { path: f.path, mode: '100644', type: 'blob', sha: null };
      const body = typeof f.content === 'string'
        ? { content: f.content, encoding: 'utf-8' }
        : { content: f.content.base64, encoding: 'base64' };
      const res = await fetch(`${this.base}/git/blobs`, {
        method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `Failed to upload ${f.path} (${res.status})`); }
      const sha = (await res.json()).sha;
      return { path: f.path, mode: '100644', type: 'blob', sha };
    }));

    return this._commitTreeEntries(treeEntries, message);
  }

  // Builds a tree on top of the branch's CURRENT tip and updates the ref. If
  // the tip moved since we read it — another save landed first, e.g. two tabs
  // open, or a save racing a reorder — the ref update is rejected as "not a
  // fast forward"; retried once against the new tip (still using the same
  // already-uploaded blobs) rather than just failing the whole save.
  async _commitTreeEntries(treeEntries, message, retriesLeft = 1) {
    const refRes = await fetch(`${this.base}/git/ref/heads/${this.branch}`, { headers: this.headers(), cache: 'no-store' });
    if (!refRes.ok) throw new Error(`Failed to read branch ref (${refRes.status})`);
    const parentSha = (await refRes.json()).object.sha;

    const parentCommitRes = await fetch(`${this.base}/git/commits/${parentSha}`, { headers: this.headers(), cache: 'no-store' });
    if (!parentCommitRes.ok) throw new Error(`Failed to read parent commit (${parentCommitRes.status})`);
    const baseTreeSha = (await parentCommitRes.json()).tree.sha;

    const treeRes = await fetch(`${this.base}/git/trees`, {
      method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
    });
    if (!treeRes.ok) { const err = await treeRes.json().catch(() => ({})); throw new Error(err.message || `Failed to build commit tree (${treeRes.status})`); }
    const newTreeSha = (await treeRes.json()).sha;

    const commitRes = await fetch(`${this.base}/git/commits`, {
      method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: newTreeSha, parents: [parentSha] })
    });
    if (!commitRes.ok) { const err = await commitRes.json().catch(() => ({})); throw new Error(err.message || `Failed to create commit (${commitRes.status})`); }
    const newCommitSha = (await commitRes.json()).sha;

    const updateRefRes = await fetch(`${this.base}/git/refs/heads/${this.branch}`, {
      method: 'PATCH', headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitSha })
    });
    if (!updateRefRes.ok) {
      const conflict = updateRefRes.status === 422 || updateRefRes.status === 409;
      if (conflict && retriesLeft > 0) {
        return this._commitTreeEntries(treeEntries, message, retriesLeft - 1);
      }
      const err = await updateRefRes.json().catch(() => ({}));
      throw new Error(err.message || `Failed to update ${this.branch} (${updateRefRes.status})`);
    }

    return newCommitSha;
  }
}
