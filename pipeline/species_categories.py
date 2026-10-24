"""Give each species a rough category (songbirds, woodpeckers, raptors, ...) for grouping charts.

Uses BirdNET's bundled eBird species codes to look up each species' order and
family in the public eBird taxonomy, then maps those to a short list of
categories a backyard listener would recognize.

Output: data/species_categories.csv. Re-run when the species list changes.

Usage: python pipeline/species_categories.py
"""

import csv
import io
import json
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "species_categories.csv"
TAXONOMY = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv&species={}"

# Display order of categories; charts list groups in this order.
CATEGORIES = [
    "Songbirds", "Crows & jays", "Woodpeckers", "Hummingbirds & swifts", "Pigeons & doves",
    "Raptors", "Owls & nightjars", "Waterbirds", "Other",
]

ORDER_CATEGORY = {
    "Piciformes": "Woodpeckers",
    "Apodiformes": "Hummingbirds & swifts",
    "Columbiformes": "Pigeons & doves",
    "Accipitriformes": "Raptors",
    "Falconiformes": "Raptors",
    "Cathartiformes": "Raptors",
    "Strigiformes": "Owls & nightjars",
    "Caprimulgiformes": "Owls & nightjars",
    "Anseriformes": "Waterbirds",
    "Podicipediformes": "Waterbirds",
    "Gaviiformes": "Waterbirds",
    "Pelecaniformes": "Waterbirds",
    "Suliformes": "Waterbirds",
    "Gruiformes": "Waterbirds",
    "Charadriiformes": "Waterbirds",
    "Procellariiformes": "Waterbirds",
    "Coraciiformes": "Waterbirds",  # kingfishers, around here
}

# For the few species whose BirdNET label doesn't match an eBird code.
NAME_FALLBACK = {"Gull": "Waterbirds", "Duck": "Waterbirds", "Owl": "Owls & nightjars", "Hawk": "Raptors", "Woodpecker": "Woodpeckers"}


def category(order: str, family_sci: str, common_name: str) -> str:
    if not order:
        return next((c for word, c in NAME_FALLBACK.items() if word in common_name), "Other")
    if order == "Passeriformes":
        return "Crows & jays" if family_sci == "Corvidae" else "Songbirds"
    return ORDER_CATEGORY.get(order, "Other")


def fetch_taxonomy(codes: list[str]) -> list[dict]:
    rows = []
    for i in range(0, len(codes), 100):
        url = TAXONOMY.format(",".join(codes[i : i + 100]))
        req = urllib.request.Request(url, headers={"User-Agent": "BirdTracker/0.1 (https://github.com/annajxli/birdTracker)"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            rows += list(csv.DictReader(io.StringIO(resp.read().decode())))
    return rows


if __name__ == "__main__":
    import birdnet_analyzer  # only needed here; the dashboard imports CATEGORIES without BirdNET installed

    occ = pd.read_csv(ROOT / "data" / "occurrence.csv", usecols=["scientific_name", "common_name"])
    codes = json.loads((Path(birdnet_analyzer.__file__).parent / "eBird_taxonomy_codes_2024E.json").read_text())
    occ["code"] = (occ.scientific_name + "_" + occ.common_name).map(codes)

    taxa = {r["SPECIES_CODE"]: r for r in fetch_taxonomy(occ.code.dropna().tolist())}
    occ["order"] = occ.code.map(lambda c: taxa.get(c, {}).get("ORDER", ""))
    occ["family"] = occ.code.map(lambda c: taxa.get(c, {}).get("FAMILY_COM_NAME", ""))
    occ["category"] = [
        category(o, taxa.get(c, {}).get("FAMILY_SCI_NAME", ""), name) for o, c, name in zip(occ.order, occ.code, occ.common_name)
    ]

    occ.drop(columns="code").to_csv(OUT, index=False)
    print(occ.category.value_counts().reindex(CATEGORIES).fillna(0).astype(int).to_string())
    print(f"-> {OUT}")
