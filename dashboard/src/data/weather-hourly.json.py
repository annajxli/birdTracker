"""Hourly temperature (°F) keyed by Pacific date: {date: [24 values, null where missing]}.
Built by pipeline/weather.py from Open-Meteo; empty if that file doesn't exist yet."""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[3]
path = ROOT / "data" / "weather_hourly.csv"
out = {}
if path.exists():
    for r in pd.read_csv(path).itertuples():
        out.setdefault(r.date, [None] * 24)[int(r.hour)] = round(float(r.temp_f), 1)
json.dump(out, sys.stdout)
