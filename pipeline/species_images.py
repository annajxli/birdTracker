"""Find a photo for each species, with credit and license, from Wikipedia/Wikimedia Commons.

Looks up each species' Wikipedia article by scientific name, takes the article's
lead image, and reads the photographer and license from Commons. Most images
are CC BY-SA or similar, so the dashboard must show the credit line next to
each photo. Images are linked from upload.wikimedia.org, not copied.

Output: data/species_images.json, keyed by scientific name. Re-run only when the
species list changes; existing entries are kept unless --refresh is passed.

Usage: python pipeline/species_images.py [--refresh]
"""

import argparse
import http.client
import json
import re
import time
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "species_images.json"
USER_AGENT = "BirdTracker/0.1 (https://github.com/annajxli/birdTracker)"
WIKIPEDIA = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"
THUMB_WIDTH = 640


def api(url: str, **params) -> dict:
    # POST, since 50 titles make a long query string.
    body = urllib.parse.urlencode({"format": "json", "formatversion": 2, **params}).encode()
    req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except (OSError, http.client.HTTPException):
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", s or ""))).strip()


def chunks(items, n=50):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def lead_images(scientific_names: list[str]) -> dict[str, dict]:
    """Scientific name -> {title, file} via Wikipedia's page images."""
    found = {}
    for batch in chunks(scientific_names):
        data = api(WIKIPEDIA, action="query", titles="|".join(batch), prop="pageimages", piprop="name", redirects=1)["query"]
        # Follow normalization and redirects from each requested name to its final title.
        alias = {n["from"]: n["to"] for n in data.get("normalized", [])}
        redirect = {r["from"]: r["to"] for r in data.get("redirects", [])}
        pages = {p["title"]: p for p in data.get("pages", [])}
        for name in batch:
            title = redirect.get(alias.get(name, name), alias.get(name, name))
            page = pages.get(title)
            if page and page.get("pageimage"):
                found[name] = {"title": title, "file": page["pageimage"]}
        time.sleep(0.5)
    return found


def file_info(files: list[str]) -> dict[str, dict]:
    """Commons file name -> thumbnail URL, size, credit and license."""
    info = {}
    for batch in chunks(files, 20):
        data = api(
            COMMONS, action="query", titles="|".join(f"File:{f}" for f in batch),
            prop="imageinfo", iiprop="url|extmetadata|size", iiurlwidth=THUMB_WIDTH,
            iiextmetadatafilter="Artist|LicenseShortName|LicenseUrl",
        )["query"]
        alias = {n["to"]: n["from"] for n in data.get("normalized", [])}
        for page in data.get("pages", []):
            if not page.get("imageinfo"):
                continue
            ii = page["imageinfo"][0]
            meta = ii.get("extmetadata", {})
            name = alias.get(page["title"], page["title"]).removeprefix("File:")
            info[name] = {
                "image": (ii.get("thumburl") or ii["url"]).split("?")[0],  # drop tracking params
                "width": ii.get("thumbwidth") or ii.get("width"),
                "height": ii.get("thumbheight") or ii.get("height"),
                "file_page": ii.get("descriptionurl"),
                "artist": strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown",
                "license": strip_html(meta.get("LicenseShortName", {}).get("value", "")),
                "license_url": meta.get("LicenseUrl", {}).get("value"),
            }
        time.sleep(0.5)
    return info


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--occurrence", type=Path, default=ROOT / "data" / "occurrence.csv")
    p.add_argument("--refresh", action="store_true", help="re-fetch species that already have an entry")
    args = p.parse_args()

    occ = pd.read_csv(args.occurrence)
    existing = json.loads(OUT.read_text()) if OUT.exists() and not args.refresh else {}
    todo = [s for s in occ.scientific_name if s not in existing]

    leads = lead_images(todo)
    files = file_info(sorted({v["file"] for v in leads.values()}))
    for name, lead in leads.items():
        if lead["file"] in files:
            existing[name] = {
                "wikipedia": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(lead['title'].replace(' ', '_'))}",
                **files[lead["file"]],
            }

    OUT.write_text(json.dumps(dict(sorted(existing.items())), indent=1, ensure_ascii=False) + "\n")
    missing = [s for s in occ.scientific_name if s not in existing]
    print(f"{len(existing)} species with photos -> {OUT}; {len(missing)} without: {', '.join(missing[:10])}{' …' if len(missing) > 10 else ''}")
