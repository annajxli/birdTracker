"""Daily weather keyed by Pacific date (built by pipeline/weather.py from Open-Meteo)."""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
w = pd.read_csv(ROOT / "data" / "weather.csv")
json.dump({r.date: {"high": r.temp_max_f, "low": r.temp_min_f, "precip": r.precip_in, "code": int(r.weather_code)} for r in w.itertuples()}, sys.stdout)
