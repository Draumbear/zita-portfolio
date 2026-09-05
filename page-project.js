// Split out of project.html so the site can run under a Content-Security-Policy
// that forbids inline scripts.
  if (new URLSearchParams(location.search).get('preview') === '1') {
    let data = null;
    try { data = JSON.parse(sessionStorage.getItem('zita-preview-draft')); } catch (e) { /* fall through to error below */ }
    if (data) {
      renderProjectData(data);
      document.title = `Preview: ${data.title || ''} — Zita Decoopman`;
      const banner = document.createElement('div');
      banner.textContent = 'PREVIEW — unsaved draft, not the live page';
      banner.style.cssText = 'position:sticky; top:0; z-index:999; background:#1a01ff; color:#fff; text-align:center; padding:0.5rem; font-family:"Jost",sans-serif; font-size:0.85rem; letter-spacing:0.05em;';
      document.body.prepend(banner);
    } else {
      renderProjectError('No preview data found — open Preview again from the dashboard.');
    }
  } else {
    renderProject();
  }
