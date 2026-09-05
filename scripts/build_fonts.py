"""Turns the Google Fonts stylesheet into a self-hosted one.

Two reasons, both real. Loading fonts from fonts.googleapis.com sends every
visitor's IP address to Google before a single word is rendered, which under
GDPR is a transfer a portfolio has no need to make (a German court has fined a
site for exactly this). And a third-party stylesheet plus a third-party font
host is two extra origins any Content-Security-Policy has to allow, which is
most of the value of having one.

Only the latin and latin-ext blocks are kept: the site is in English, and
carrying cyrillic, greek and vietnamese cuts would triple the download for
characters no page uses.
"""
import io, os, re, subprocess, sys

root = r"C:\Users\tangu\Zita\portfolio-remake"
FONT_DIR = os.path.join(root, "assets", "fonts")
KEEP = ("latin", "latin-ext")

css = io.open(r"C:\Users\tangu\AppData\Local\Temp\gf.css", encoding="utf-8").read() \
    if os.path.exists(r"C:\Users\tangu\AppData\Local\Temp\gf.css") else io.open("/tmp/gf.css", encoding="utf-8").read()

os.makedirs(FONT_DIR, exist_ok=True)

blocks = re.findall(r"/\* (\S+) \*/\s*(@font-face \{.*?\})", css, re.S)
out, wanted = [], []
for subset, block in blocks:
    if subset not in KEEP:
        continue
    family = re.search(r"font-family: '([^']+)'", block).group(1)
    style = re.search(r"font-style: (\w+)", block).group(1)
    weight = re.search(r"font-weight: (\d+)", block).group(1)
    url = re.search(r"url\((https://[^)]+)\)", block).group(1)

    name = "%s-%s-%s-%s.woff2" % (
        family.lower().replace(" ", "-"), weight, style, subset)
    wanted.append((url, os.path.join(FONT_DIR, name)))
    # Bare filename: the URL resolves relative to this stylesheet, which lives
    # in the same folder as the fonts.
    out.append(block.replace(url, name).rstrip() + "\n")

for url, path in wanted:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        continue
    subprocess.run(["curl", "-sS", "-L", "-o", path, url], check=True)

header = (
    "/* Self-hosted copies of the two Google fonts this site uses.\n"
    " *\n"
    " * Loading them from fonts.googleapis.com sent every visitor's IP address to\n"
    " * Google before a word was rendered -- a transfer a portfolio has no need to\n"
    " * make, and one a German court has already fined a site for. It also cost two\n"
    " * extra origins that any Content-Security-Policy would have to allow.\n"
    " *\n"
    " * Latin and latin-ext only: the site is in English, and shipping the cyrillic,\n"
    " * greek and vietnamese cuts would multiply the download for characters no page\n"
    " * uses. Regenerate with scripts/build_fonts.py if a weight is ever added.\n"
    " */\n\n")

io.open(os.path.join(FONT_DIR, "fonts.css"), "w", encoding="utf-8", newline="").write(header + "\n".join(out))

total = sum(os.path.getsize(p) for _, p in wanted)
print("faces kept   %d (of %d)" % (len(wanted), len(blocks)))
print("downloaded   %.0f KB into assets/fonts/" % (total / 1024.0))
for _, p in wanted:
    print("   %6.1f KB  %s" % (os.path.getsize(p) / 1024.0, os.path.basename(p)))
