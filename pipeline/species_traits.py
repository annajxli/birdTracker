"""Find each species' eBird code, body mass and body length, for the species page.

- eBird code: from the eBird taxonomy (api.ebird.org, no key needed). Birds of the
  World pages are addressed by it.
- Mass: AVONET (Tobias et al. 2022, Ecology Letters, CC BY 4.0), eBird taxonomy sheet,
  trimmed to data/avonet_mass.csv. To rebuild that file from a new AVONET release,
  download "AVONET Supplementary dataset 1.xlsx" from
  https://doi.org/10.6084/m9.figshare.16586228 and pass it with --avonet; reading it
  needs openpyxl.
- Length: parsed from the species' Wikipedia article (the one in species_images.json),
  keeping the sentence it came from. The parse is a heuristic: check each new value
  against its sentence, and correct or drop it in data/species_length_fixes.csv.

Output: data/species_traits.json, keyed by scientific name. Re-run when the species
list changes or the fixes file is edited.

Usage: python pipeline/species_traits.py [--avonet XLSX]
"""

import argparse
import csv
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "species_traits.json"
FIXES = ROOT / "data" / "species_length_fixes.csv"
IMAGES = ROOT / "data" / "species_images.json"
MASS = ROOT / "data" / "avonet_mass.csv"
AVONET_CREDIT = ("Body mass from AVONET, eBird taxonomy (Tobias et al. 2022, Ecology Letters 25:581-597, "
                 "https://doi.org/10.6084/m9.figshare.16586228), CC BY 4.0. Built by pipeline/species_traits.py.")
USER_AGENT = "BirdTracker/0.1 (https://github.com/annajxli/birdTracker)"
WIKIPEDIA = "https://en.wikipedia.org/w/api.php"
TAXONOMY = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv"
# Species eBird has since split under new names: the half that lives here.
SPLIT = {"Accipiter gentilis": "norgos"}  # Northern Goshawk -> American Goshawk

# A length: "23 to 28 cm", "18–20 cm", "250 mm" or "6–7 in", with an optional bracketed conversion.
NUMBER = r"(\d+(?:\.\d+)?)"
LENGTH = re.compile(NUMBER + r"(?:\s*(?:–|-|to)\s*" + NUMBER + r")?\s*(cm|mm|in)\b(?:\s*\([^)]*\))?")
UNIT_CM = {"cm": 1, "mm": 0.1, "in": 2.54}
# Measurements of something other than the whole bird, just before or after the number.
OTHER_PART = re.compile(r"egg|wing|tail|bill|beak|tarsus|culmen|chord|tall|height|feather|nest|clutch|across", re.I)
# Words that mark a number as the bird's length: "... long", "length of ...", "measures ...".
AFTER = re.compile(r"^\s*(long|in length|in total length|from bill)", re.I)
BEFORE = re.compile(r"(length|long|measur\w*|range[sd]? (from|in length)|is about|are about|approximately)[^.\d]{0,40}$", re.I)


def get(url: str, data: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def ebird_codes() -> tuple[dict[str, str], dict[str, str]]:
    """Species code by scientific name, and by common name for species eBird has since moved to another genus."""
    rows = [r for r in csv.DictReader(io.StringIO(get(TAXONOMY).decode("utf-8"))) if r["CATEGORY"] == "species"]
    return {r["SCIENTIFIC_NAME"]: r["SPECIES_CODE"] for r in rows}, {r["COMMON_NAME"]: r["SPECIES_CODE"] for r in rows}


def trim_avonet(xlsx: Path) -> None:
    sheet = pd.read_excel(xlsx, sheet_name="AVONET2_eBird", usecols=["Species2", "Mass"])
    with MASS.open("w", encoding="utf-8", newline="") as f:
        f.write(f"# {AVONET_CREDIT}\n")
        sheet.rename(columns={"Species2": "scientific_name", "Mass": "mass_g"}).to_csv(f, index=False)


def avonet_mass() -> dict[str, float]:
    table = pd.read_csv(MASS, comment="#")
    return dict(zip(table.scientific_name, table.mass_g))


def article_text(title: str) -> str:
    body = urllib.parse.urlencode({"action": "query", "prop": "extracts", "explaintext": 1, "redirects": 1,
                                   "titles": title, "format": "json", "formatversion": 2}).encode()
    pages = json.loads(get(WIKIPEDIA, body))["query"]["pages"]
    return pages[0].get("extract", "") if pages else ""


def parse_length(text: str) -> tuple[float, float, str] | None:
    """The first whole-bird length in the article, in cm, with its sentence."""
    for sentence in re.split(r"(?<=[.])\s+", text):
        sentence = " ".join(sentence.split())
        if not re.search(r"length|long|measur", sentence, re.I):
            continue
        for m in LENGTH.finditer(sentence):
            before, after = sentence[max(0, m.start() - 45):m.start()], sentence[m.end():m.end() + 20]
            if OTHER_PART.search(before[-30:]) or OTHER_PART.search(after[:12]):
                continue
            if AFTER.search(after) or BEFORE.search(before):
                f = UNIT_CM[m[3]]
                return round(float(m[1]) * f, 1), round(float(m[2] or m[1]) * f, 1), sentence
    return None


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--avonet", type=Path, help="rebuild data/avonet_mass.csv from AVONET Supplementary dataset 1.xlsx")
    p.add_argument("--occurrence", type=Path, default=ROOT / "data" / "occurrence.csv")
    args = p.parse_args()

    occ = pd.read_csv(args.occurrence)
    species, common = list(occ.scientific_name), dict(zip(occ.scientific_name, occ.common_name))
    articles = {sci: urllib.parse.unquote(v["wikipedia"].rsplit("/", 1)[1]).replace("_", " ")
                for sci, v in json.loads(IMAGES.read_text(encoding="utf-8")).items()}
    if args.avonet:
        trim_avonet(args.avonet)
    (codes, by_common), mass = ebird_codes(), avonet_mass()
    fixes = {r["scientific_name"]: r for r in csv.DictReader(FIXES.open(encoding="utf-8"))} if FIXES.exists() else {}

    out = {}
    for sci in species:
        entry = {"ebird": codes.get(sci) or by_common.get(common[sci]) or SPLIT.get(sci), "mass_g": None if pd.isna(mass.get(sci)) else round(float(mass[sci]), 1)}
        found = parse_length(article_text(articles[sci])) if sci in articles else None
        time.sleep(0.5)
        if sci in fixes:
            fix = fixes[sci]
            found = (float(fix["min_cm"]), float(fix["max_cm"]), fix["note"]) if fix["min_cm"] else None
        if found:
            entry["length_cm"] = [found[0], found[1]]
            entry["length_source"] = {"url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(articles[sci].replace(' ', '_'))}",
                                      "text": found[2]}
        out[sci] = entry

    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    no_code = [s for s, e in out.items() if not e["ebird"]]
    no_length = [s for s, e in out.items() if "length_cm" not in e]
    print(f"{len(out)} species -> {OUT}; {len(no_code)} without an eBird code {no_code}, {len(no_length)} without a length")
