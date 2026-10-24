"""Sunrise, sunset and local-midnight bounds for each day at the station, as UTC ISO strings.

Covers every day with detections (plus the year before today, so a fresh
station still has a calendar) through tomorrow, keyed by Pacific-time date.
"""

import json
import os
import sqlite3
import sys
from pathlib import Path
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from astral import LocationInfo
from astral.sun import sun

TZ = ZoneInfo("America/Los_Angeles")
ROOT = Path(__file__).resolve().parents[3]
DB = Path(os.environ.get("BIRDTRACKER_DB", ROOT / "data" / "detections.sqlite"))
SITE = LocationInfo("Seattle", "USA", "America/Los_Angeles", 47.61, -122.33)


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


today = datetime.now(TZ).date()
first, last = today - timedelta(days=400), today + timedelta(days=1)
if DB.exists():
    # Read-only, so a missing table doesn't leave an empty database file behind.
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as conn:
        try:
            lo, hi = conn.execute("SELECT min(detected_at), max(detected_at) FROM detections").fetchone()
        except sqlite3.OperationalError:
            lo = hi = None
    if lo:  # UTC timestamps; a day either side covers the Pacific dates
        first = min(first, date.fromisoformat(lo[:10]) - timedelta(days=1))
        last = max(last, date.fromisoformat(hi[:10]) + timedelta(days=1))

days = {}
for k in range((last - first).days + 1):
    d = first + timedelta(days=k)
    s = sun(SITE.observer, date=d, tzinfo=TZ)
    days[d.isoformat()] = {
        "start": iso(datetime.combine(d, time(), TZ)),
        "end": iso(datetime.combine(d + timedelta(days=1), time(), TZ)),
        "sunrise": iso(s["sunrise"]),
        "sunset": iso(s["sunset"]),
    }

json.dump(days, sys.stdout)
