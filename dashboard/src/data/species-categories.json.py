"""Rough category per species, keyed by common name, plus the display order of categories."""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from species_categories import CATEGORIES  # noqa: E402

df = pd.read_csv(ROOT / "data" / "species_categories.csv")
json.dump({"order": CATEGORIES, "species": dict(zip(df.common_name, df.category))}, sys.stdout)
