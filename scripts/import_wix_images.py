"""Brings the portfolio's photos into the repository.

Every image on the site was a live link to static.wixstatic.com -- the CDN of
the old Wix site the portfolio was rebuilt from. They were never copied, only
pointed at. That works right up until the Wix site is cancelled, deleted or
reorganised, at which point every photo in the portfolio disappears at once,
with no warning and nothing left to fall back on.

This downloads each distinct image once into assets/uploads/ and rewrites the
JSON to point at the local copy. It is safe to re-run: an image already present
is not fetched again, and a URL already rewritten is not matched.

Size. The originals are around 5.5 MB each -- a gigabyte across the portfolio,
which does not belong in a git repository. The site was displaying them through
Wix's resizer at 274-800px, which is soft on a retina screen. So each is
fetched through the same resizer at a fixed larger size: good enough to look
sharp and to survive a future redesign, small enough to store.

    python scripts/import_wix_images.py           # download and rewrite
    python scripts/import_wix_images.py --dry-run # just report what it would do
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS = os.path.join(BASE, "assets", "uploads")
DATA = os.path.join(BASE, "data")

WIX_RE = re.compile(r'https://static\.wixstatic\.com/media/[^"\s]+')
# 2x the largest size the site actually displays, which is what a retina screen
# wants; q_85 is where the file size stops paying for itself.
TRANSFORM = "v1/fit/w_1600,h_1600,q_85"


def local_name(url):
    """A readable, stable filename. The hash is over the whole URL, not just the
    media id: two entries can point at the same photo through different crops,
    and those are genuinely different images that must not collide."""
    media_id = url.split("/media/", 1)[1].split("/", 1)[0]
    tail = url.rstrip("/").rsplit("/", 1)[-1]
    stem, ext = os.path.splitext(tail if "." in tail else media_id)
    # Wix's own ids read as noise in a filename; a real photo name does not.
    if re.fullmatch(r"[0-9a-f]{6}_[0-9a-f]{32}~mv2", stem):
        stem = "photo"
    stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()[:48] or "photo"
    digest = hashlib.sha1(url.encode()).hexdigest()[:8]
    return f"{stem}-{digest}{(ext or '.jpg').lower()}"


def source_url(url):
    """The same image at our own size, rather than whatever size the old page
    happened to ask for.

    Except for a crop: those carry coordinates someone chose deliberately, and
    swapping them for a plain fit would silently un-crop the picture. Those are
    fetched exactly as they appear, at whatever size the crop was made for.
    """
    if "/v1/crop/" in url:
        return url
    head, _, _ = url.partition("/v1/")
    return f"{head}/{TRANSFORM}/{os.path.basename(head)}"


def json_files():
    for folder, _dirs, files in os.walk(DATA):
        for name in sorted(files):
            if name.endswith(".json"):
                yield os.path.join(folder, name)


def main():
    dry = "--dry-run" in sys.argv
    found = {}
    for path in json_files():
        for url in WIX_RE.findall(io.open(path, encoding="utf-8").read()):
            found.setdefault(url, local_name(url))

    if not found:
        print("nothing to do: no wixstatic URLs left in data/")
        return

    print("%d distinct images across %d files" % (len(found), len(list(json_files()))))
    if dry:
        for url, name in list(found.items())[:5]:
            print("   %s\n     -> assets/uploads/%s" % (url[:90], name))
        print("   ... (--dry-run, nothing written)")
        return

    os.makedirs(UPLOADS, exist_ok=True)
    fetched = skipped = failed = 0
    for i, (url, name) in enumerate(sorted(found.items()), 1):
        dest = os.path.join(UPLOADS, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            skipped += 1
            continue
        res = subprocess.run(["curl", "-sS", "-L", "--fail", "-o", dest, source_url(url)])
        if res.returncode != 0 or not os.path.exists(dest) or os.path.getsize(dest) == 0:
            # Leave the original URL in place rather than pointing the site at a
            # file that is not there: a working remote image beats a local 404.
            if os.path.exists(dest):
                os.remove(dest)
            failed += 1
            print("   FAILED %s" % url[:100])
            continue
        fetched += 1
        if i % 20 == 0:
            print("   %d/%d" % (i, len(found)))

    # Only rewrite URLs whose file actually arrived.
    usable = {u: n for u, n in found.items() if os.path.exists(os.path.join(UPLOADS, n))}
    rewritten = 0
    for path in json_files():
        text = io.open(path, encoding="utf-8").read()
        original = text
        for url, name in usable.items():
            text = text.replace(url, "assets/uploads/" + name)
        if text != original:
            json.loads(text)  # refuse to write anything that is no longer valid JSON
            io.open(path, "w", encoding="utf-8", newline="").write(text)
            rewritten += 1

    total = sum(os.path.getsize(os.path.join(UPLOADS, n)) for n in usable.values())
    print("downloaded  %d   already had  %d   failed  %d" % (fetched, skipped, failed))
    print("rewritten   %d json files" % rewritten)
    print("on disk     %.0f MB in assets/uploads/ (%.0f KB average)"
          % (total / 1048576.0, total / max(len(usable), 1) / 1024.0))
    if failed:
        print("NOTE: %d images still point at Wix. Re-run to try them again." % failed)


if __name__ == "__main__":
    main()
