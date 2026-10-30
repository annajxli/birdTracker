"""Species eBird codes, mass and length, keyed by scientific name (pipeline/species_traits.py)."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
traits = json.loads((ROOT / "data" / "species_traits.json").read_text(encoding="utf-8"))
# The page shows only the numbers; length sources stay in the repo for checking.
json.dump({sci: {k: v for k, v in t.items() if k != "length_source"} for sci, t in traits.items()}, sys.stdout)
