"""Species photos, credits and focal points, keyed by common name (pipeline/species_images.py, photo_focus.py)."""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
images = json.loads((ROOT / "data" / "species_images.json").read_text())
names = pd.read_csv(ROOT / "data" / "occurrence.csv", usecols=["scientific_name", "common_name"])
common = dict(zip(names.scientific_name, names.common_name))
# Where the bird is in each photo (pipeline/photo_focus.py), for crops that keep it in frame.
focus_file = ROOT / "data" / "photo_focus.json"
focus = json.loads(focus_file.read_text()) if focus_file.exists() else {}

json.dump({common[sci]: {**info, "focus": focus.get(sci, {"x": 0.5, "y": 0.5})} for sci, info in images.items() if sci in common}, sys.stdout)
