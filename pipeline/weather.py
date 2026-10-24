"""Daily weather at the station from Open-Meteo (free, no API key).

Fetches daily high/low temperature (°F), precipitation (inches) and the WMO
weather code for every date the detections cover. The historical archive lags
a few days behind, so the most recent week comes from the forecast API's
past_days instead.

Output: data/weather.csv. Re-run after new detections arrive.

Usage: python pipeline/weather.py [--start 2025-10-23] [--end 2026-10-22]
"""

import argparse
import json
import sqlite3
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

import db

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "weather.csv"
LAT, LON = 47.61, -122.33
DAILY = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code"
COMMON = {
    "latitude": LAT, "longitude": LON, "daily": DAILY, "timezone": "America/Los_Angeles",
    "temperature_unit": "fahrenheit", "precipitation_unit": "inch",
}


def get(url: str, **params) -> pd.DataFrame:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode({**COMMON, **params})}", headers={"User-Agent": "BirdTracker/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        daily = json.load(resp)["daily"]
    return pd.DataFrame({
        "date": daily["time"],
        "temp_max_f": daily["temperature_2m_max"],
        "temp_min_f": daily["temperature_2m_min"],
        "precip_in": daily["precipitation_sum"],
        "weather_code": daily["weather_code"],
    })


def detection_dates(db_path: Path) -> tuple[date, date]:
    """The days with detections, padded a day either side so local dates near midnight UTC are
    covered; the last year if there's no database or it's empty (e.g. before simulating in CI)."""
    yesterday = date.today() - timedelta(days=1)
    fallback = (yesterday - timedelta(days=365), yesterday)
    if not db_path.exists():
        return fallback
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        try:
            first, last = conn.execute("SELECT min(detected_at), max(detected_at) FROM detections").fetchone()
        except sqlite3.OperationalError:  # no detections table yet
            return fallback
    if not first:
        return fallback
    return date.fromisoformat(first[:10]) - timedelta(days=1), date.fromisoformat(last[:10]) + timedelta(days=1)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", type=date.fromisoformat)
    p.add_argument("--end", type=date.fromisoformat)
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    args = p.parse_args()

    if args.start and args.end:
        start, end = args.start, args.end
    else:
        start, end = detection_dates(args.db)
        start, end = args.start or start, args.end or end
    end = min(end, date.today() - timedelta(days=1))  # today's numbers are still mostly forecast
    recent_from = date.today() - timedelta(days=7)

    parts = []
    if start < recent_from:
        parts.append(get("https://archive-api.open-meteo.com/v1/archive",
                         start_date=start.isoformat(), end_date=min(end, recent_from - timedelta(days=1)).isoformat()))
    if end >= recent_from:
        recent = get("https://api.open-meteo.com/v1/forecast", past_days=8, forecast_days=1)
        parts.append(recent[(recent.date >= max(start, recent_from).isoformat()) & (recent.date <= end.isoformat())])

    weather = pd.concat(parts).drop_duplicates("date", keep="first").sort_values("date").dropna()
    weather.to_csv(OUT, index=False)
    print(f"{len(weather)} days of weather, {weather.date.iloc[0]} to {weather.date.iloc[-1]} -> {OUT}")
