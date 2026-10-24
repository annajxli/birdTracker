"""Species photos and credits, keyed by common name (built by pipeline/species_images.py)."""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
images = json.loads((ROOT / "data" / "species_images.json").read_text())
names = pd.read_csv(ROOT / "data" / "occurrence.csv", usecols=["scientific_name", "common_name"])
common = dict(zip(names.scientific_name, names.common_name))

json.dump({common[sci]: info for sci, info in images.items() if sci in common}, sys.stdout)
