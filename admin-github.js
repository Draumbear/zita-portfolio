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
    if (!res.ok) throw new Error(res.status === 404 ? 'Repository not found — check owner/repo.' : `GitHub error ${res.status}`);
    return res.json();
  }

  // Returns { content: string, sha: string } or null if the file doesn't exist.
  async getFile(path) {
    const res = await fetch(`${this.base}/contents/${encodeURI(path)}?ref=${this.branch}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to read ${path} (${res.status})`);
    const data = await res.json();
    return { content: base64ToUtf8(data.content), sha: data.sha };
  }

  async getJSON(path) {
    const file = await this.getFile(path);
    return file ? JSON.parse(file.content) : null;
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

  // Reads a File/Blob and uploads it, returning the raw.githubusercontent.com URL.
  async uploadImage(file, folder = 'assets/uploads') {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '-');
    const path = `${folder}/${Date.now()}-${safeName}`;
    await this.putFile(path, { base64 }, `Upload ${safeName}`);
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
  }
}
