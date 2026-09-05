"""
Bumps the ?v= token on every CSS/JS link in the HTML files so browsers pick
up changes instead of serving a cached copy. Run this after editing
styles.css / admin.css / any of the .js files.

The token is a hash of those files' contents, so re-running it when nothing
changed is a no-op, and it can't drift out of sync with the code the way a
hand-typed date does.
"""
import glob
import hashlib
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = ["styles.css", "admin.css", "site-data.js", "script.js",
          "project-render.js", "admin.js", "admin-github.js"]


def version():
    h = hashlib.sha1()
    for name in sorted(ASSETS):
        path = os.path.join(BASE, name)
        if os.path.exists(path):
            h.update(open(path, "rb").read())
    return h.hexdigest()[:8]


def main():
    v = version()
    # Paths as well as bare filenames, so assets/fonts/fonts.css is covered too.
    pattern = re.compile(r'((?:href|src)="(?:[\w./-]+)\.(?:css|js))(?:\?v=[^"]*)?"')
    changed = []
    for f in glob.glob(os.path.join(BASE, "*.html")):
        s = open(f, encoding="utf-8").read()
        new = pattern.sub(rf'\1?v={v}"', s)
        if new != s:
            open(f, "w", encoding="utf-8").write(new)
            changed.append(os.path.basename(f))
    print(f"version {v} — updated: {', '.join(changed) if changed else 'nothing (already current)'}")


if __name__ == "__main__":
    main()
