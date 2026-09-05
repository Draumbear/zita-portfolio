"""Generates robots.txt + sitemap.xml and keeps every page's <link rel=canonical>
in step with them.

Run it after adding or removing a page. Project pages come from
data/projects-index.json, so projects stay listed as Zita adds and removes them -- but nothing here runs when he saves from the dashboard, so the
sitemap goes stale for new products until someone runs this. That is a fair
trade for a site with no build step: a slightly stale sitemap costs a little
crawl latency, while a build pipeline would cost the dashboard its independence.

SITE_ORIGIN is the one thing to change when the domain moves. A canonical URL
pointing at a domain that does not resolve is worse than none at all -- it tells
Google the real page lives somewhere broken -- so this stays on the origin the
site is actually served from until the new one is live.
"""

import hashlib
import json
import os
import re
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- change this, and re-run, the day a custom domain goes live --------------
SITE_ORIGIN = "https://draumbear.github.io/zita-portfolio"
# -----------------------------------------------------------------------------

# Pages worth finding in a search engine. index.html is deliberately absent:
# it is listed as the bare origin instead, so the homepage has one address
# rather than two.
PUBLIC_PAGES = []

# Reachable, but nothing a search result should ever point at: a dashboard
# nobody but Johnny can use, an error page, and a thank-you page that means
# nothing without the form submission that leads to it.
PRIVATE_PAGES = ["admin.html", "404.html",
                 # Redirect stubs kept so old links still land somewhere; they
                 # already carry noindex, and listing them keeps it that way.
                 "my-biggest-passion-project.html", "personal-projects.html",
                 "project-1.html", "project-smart-design.html",
                 "project-start-up.html", "rewind.html"]

CANONICAL_RE = re.compile(r'\n?[ \t]*<link rel="canonical"[^>]*>')
ROBOTS_META_RE = re.compile(r'\n?[ \t]*<meta name="robots"[^>]*>')
SOCIAL_RE = re.compile(r'\n?[ \t]*<!-- social:start -->.*?<!-- social:end -->', re.S)
JSONLD_RE = re.compile(r'\n?[ \t]*<script type="application/ld\+json">.*?</script>', re.S)
TITLE_RE = re.compile(r'<title>(.*?)</title>', re.S)
DESC_RE = re.compile(r'<meta name="description"[^>]*\scontent="(.*?)"', re.S)

# One landscape crop of Johnny at the bench, built by scripts/build_thumbs.py.
# Every photo on the site is portrait, and a portrait image in a share card gets
# letterboxed or cropped by whoever is rendering it, badly.
OG_IMAGE = "assets/hero-pattern.jpg"


def url_for(page):
    return SITE_ORIGIN + "/" + ("" if page == "index.html" else page)


def lastmod(*paths):
    newest = max((os.path.getmtime(p) for p in paths if os.path.exists(p)), default=time.time())
    return time.strftime("%Y-%m-%d", time.gmtime(newest))


def social_block(html, page):
    """The tags WhatsApp, Facebook, Instagram and Messenger read to build a
    preview card. Title and description are taken from what the page already
    says, so there is only ever one copy to keep true.

    project.html is the awkward one: the projects share a file, and the apps
    that read these tags do not run scripts, so a shared link always shows the
    site's own card rather than that project's photo. project-render.js updates
    them anyway, which is enough for Google, and giving each project its own
    card would mean giving each its own file.
    """
    title = TITLE_RE.search(html)
    desc = DESC_RE.search(html)
    title = title.group(1).strip() if title else "Zita Decoopman"
    desc = desc.group(1).strip() if desc else ""
    tags = [
        ("og:type", "website" if page == "index.html" else "article"),
        ("og:site_name", "Zita Decoopman"),
        ("og:locale", "en_GB"),
        ("og:title", title),
        ("og:description", desc),
        ("og:url", url_for(page)),
        ("og:image", SITE_ORIGIN + "/" + OG_IMAGE),
        ("twitter:card", "summary_large_image"),
        ("twitter:title", title),
        ("twitter:description", desc),
        ("twitter:image", SITE_ORIGIN + "/" + OG_IMAGE),
    ]

    # These pages already carry og:title / og:description / og:image, which
    # script.js rewrites from site.json at runtime. Emitting a second copy would
    # not override them -- scrapers take the first they meet -- it would just
    # give two answers to the same question. So only the tags the page does not
    # already have are added, which is how og:url and og:site_name get in
    # without disturbing what the dashboard controls.
    outside = SOCIAL_RE.sub("", html)
    tags = [(k, v) for k, v in tags if ('property="%s"' % k) not in outside
            and ('name="%s"' % k) not in outside]
    if not tags:
        return None
    lines = ["<!-- social:start -->",
             "<!-- Preview card for links shared in WhatsApp, Facebook, Instagram.",
             "     Written by scripts/build_seo.py from this page's own title and",
             "     description -- edit those, then re-run it. -->"]
    for key, value in tags:
        attr = "name" if key.startswith("twitter:") else "property"
        lines.append('<meta %s="%s" content="%s">' % (attr, key, escape_attr(value)))
    lines.append("<!-- social:end -->")
    return "\n".join(lines)


def escape_attr(text):
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def person_schema(site):
    """A portfolio is a person, not a shop. This is what lets Google connect the
    name, the discipline and the profiles into one entity rather than treating
    the page as unattributed text."""
    data = {
        "@context": "https://schema.org",
        "@type": "Person",
        "name": site.get("heroName") or "Zita Decoopman",
        "url": SITE_ORIGIN + "/",
        "image": SITE_ORIGIN + "/" + OG_IMAGE,
    }
    if site.get("heroEyebrow"):
        data["jobTitle"] = site["heroEyebrow"]
    if site.get("aboutParagraphs"):
        # The first paragraph of the bio, trimmed: a description is a summary,
        # and Google shows very little of it.
        data["description"] = site["aboutParagraphs"][0][:300]

    # Only profiles actually filled in: an empty sameAs entry is a broken claim.
    links = [u for u in (site.get("social") or {}).values() if (u or "").strip()]
    if links:
        data["sameAs"] = links
    return data


def set_head_tag(html, pattern, tag):
    """Replace an existing tag or insert one just before </head>."""
    if pattern.search(html):
        return pattern.sub("\n" + tag, html, count=1)
    return html.replace("</head>", tag + "\n</head>", 1)


def main():
    projects = json.load(open(os.path.join(BASE, "data", "projects-index.json"), encoding="utf-8"))

    # ---- canonicals -------------------------------------------------------
    # project.html is skipped on purpose: one static canonical there would tell
    # Google that every project is the same page. project-render.js sets it
    # per slug once it knows which one it is showing.
    site = json.load(open(os.path.join(BASE, "data", "site.json"), encoding="utf-8"))

    touched = []
    for page in ["index.html"] + PUBLIC_PAGES + ["project.html"]:
        path = os.path.join(BASE, page)
        html = open(path, encoding="utf-8").read()
        updated = html
        # project.html is the one page without a canonical here: a single one
        # would tell Google every project is the same page, so
        # project-render.js writes it per slug instead.
        if page != "project.html":
            updated = set_head_tag(updated, CANONICAL_RE,
                                   '<link rel="canonical" href="%s">' % url_for(page))
        block = social_block(updated, page)
        if block:
            updated = set_head_tag(updated, SOCIAL_RE, block)
        if page == "index.html":
            updated = set_head_tag(updated, JSONLD_RE,
                                   '<script type="application/ld+json">\n%s\n</script>'
                                   % json.dumps(person_schema(site), ensure_ascii=False, indent=2))
        if updated != html:
            open(path, "w", encoding="utf-8", newline="").write(updated)
            touched.append(page)

    for page in PRIVATE_PAGES:
        path = os.path.join(BASE, page)
        html = open(path, encoding="utf-8").read()
        updated = set_head_tag(html, ROBOTS_META_RE,
                               '<meta name="robots" content="noindex, nofollow">')
        if updated != html:
            open(path, "w", encoding="utf-8", newline="").write(updated)
            touched.append(page)

    # ---- sitemap ----------------------------------------------------------
    entries = [(SITE_ORIGIN + "/", lastmod(os.path.join(BASE, "index.html"),
                                           os.path.join(BASE, "data", "site.json")), "1.0")]
    for page in PUBLIC_PAGES:
        entries.append((url_for(page), lastmod(os.path.join(BASE, page),
                                               os.path.join(BASE, "data", "site.json")), "0.8"))
    for p in projects:
        entries.append((
            "%s/project.html?slug=%s" % (SITE_ORIGIN, p["slug"]),
            lastmod(os.path.join(BASE, "data", "projects", p["slug"] + ".json")),
            "0.6",
        ))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, mod, prio in entries:
        lines += ["  <url>",
                  "    <loc>%s</loc>" % loc.replace("&", "&amp;"),
                  "    <lastmod>%s</lastmod>" % mod,
                  "    <priority>%s</priority>" % prio,
                  "  </url>"]
    lines.append("</urlset>")
    write(os.path.join(BASE, "sitemap.xml"), "\n".join(lines) + "\n")

    # ---- robots -----------------------------------------------------------
    robots = ["User-agent: *", "Allow: /", ""]
    robots += ["Disallow: /%s" % p for p in PRIVATE_PAGES]
    robots += ["", "Sitemap: %s/sitemap.xml" % SITE_ORIGIN, ""]
    write(os.path.join(BASE, "robots.txt"), "\n".join(robots))

    print("origin      %s" % SITE_ORIGIN)
    print("sitemap     %d urls (%d projects)" % (len(entries), len(projects)))
    print("head tags   %s" % (", ".join(touched) if touched else "already current"))


def write(path, text):
    old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
    if old != text:
        open(path, "w", encoding="utf-8", newline="").write(text)


if __name__ == "__main__":
    main()
