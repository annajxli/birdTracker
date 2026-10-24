"""Sunrise, sunset and local-midnight bounds for each day at the station, as UTC ISO strings.

Covers the year before today through tomorrow, keyed by Pacific-time date.
"""

import json
import sys
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from astral import LocationInfo
from astral.sun import sun

TZ = ZoneInfo("America/Los_Angeles")
SITE = LocationInfo("Seattle", "USA", "America/Los_Angeles", 47.61, -122.33)


def iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


today = datetime.now(TZ).date()
days = {}
for k in range(-400, 2):
    d = today + timedelta(days=k)
    s = sun(SITE.observer, date=d, tzinfo=TZ)
    days[d.isoformat()] = {
        "start": iso(datetime.combine(d, time(), TZ)),
        "end": iso(datetime.combine(d + timedelta(days=1), time(), TZ)),
        "sunrise": iso(s["sunrise"]),
        "sunset": iso(s["sunset"]),
    }

json.dump(days, sys.stdout)
