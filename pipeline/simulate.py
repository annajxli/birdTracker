"""Generate a year of fake-but-plausible BirdNET detections for one station.

Species and seasons come from BirdNET's own location model (data/occurrence.csv,
built by occurrence.py), so the species mix matches what BirdNET would expect in
Seattle each week. On top of that we model:

  - a per-species "backyard abundance" so some birds dominate and others are rare
  - time of day: a dawn chorus for songbirds, daytime calls for crows/jays/raptors,
    night calls for owls, all following real sunrise/sunset times
  - seasonality: songbirds sing much more in spring (breeding season)
  - rainy days (Seattle-ish monthly odds) that suppress activity, and winter
    outages when a solar-powered recorder's battery runs flat after a gray spell
  - bouts: a singing bird yields several consecutive 3 s detections
  - false positives: occasional low-confidence detections of unlikely species

Rows are written in the same shape ingest.py produces from real BirdNET output.

Usage: python pipeline/simulate.py [--days 365] [--end 2026-10-22] [--seed 7]
"""

import argparse
import math
from datetime import date, datetime, time, timedelta, UTC
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from astral import LocationInfo
from astral.sun import sun

import db

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("America/Los_Angeles")
SITE = LocationInfo("Seattle", "USA", "America/Los_Angeles", 47.61, -122.33)
SOURCE = "simulated"

# Share of days with measurable rain, Jan..Dec (roughly Seattle climatology).
RAIN_ODDS = [0.60, 0.55, 0.60, 0.50, 0.40, 0.30, 0.12, 0.15, 0.30, 0.50, 0.65, 0.65]

NIGHT_WORDS = ("Owl",)
DAY_WORDS = (
    "Crow", "Raven", "Jay", "Gull", "Goose", "Duck", "Mallard", "Heron", "Hawk", "Eagle",
    "Falcon", "Merlin", "Kestrel", "Osprey", "Vulture", "Kingfisher", "Woodpecker",
    "Flicker", "Sapsucker", "Hummingbird", "Swallow", "Swift", "Pigeon", "Dove", "Killdeer",
)
WATER_WORDS = (
    "Duck", "Mallard", "Goose", "Gull", "Heron", "Grebe", "Loon", "Cormorant", "Merganser",
    "Wigeon", "Teal", "Scaup", "Bufflehead", "Goldeneye", "Coot", "Scoter", "Murre", "Tern",
)


def behavior(common_name: str) -> str:
    if any(w in common_name for w in NIGHT_WORDS):
        return "night"
    if any(w in common_name for w in DAY_WORDS):
        return "day"
    return "song"


def week_column(d: date) -> str:
    """BirdNET's 48-week calendar: 4 weeks per month."""
    return f"w{(d.month - 1) * 4 + min(3, (d.day - 1) // 7) + 1}"


def spring_peak(d: date) -> float:
    """0..1 bump centered on late May, when the dawn chorus is loudest."""
    doy = d.timetuple().tm_yday
    return math.exp(-(((doy - 145) / 38) ** 2))


def local_hours(d: date) -> tuple[float, float]:
    s = sun(SITE.observer, date=d, tzinfo=TZ)
    to_h = lambda t: t.hour + t.minute / 60
    return to_h(s["sunrise"]), to_h(s["sunset"])


def bout_start_hour(kind: str, sunrise: float, sunset: float, rng: np.random.Generator) -> float:
    if kind == "night":
        h = rng.uniform(sunset + 0.5, sunrise + 23.5)
    elif kind == "day":
        h = rng.normal(sunrise + 3, 2) if rng.random() < 0.5 else rng.uniform(sunrise + 0.5, sunset - 0.5)
    else:
        r = rng.random()
        if r < 0.5:
            h = rng.normal(sunrise + 0.4, 0.8)  # dawn chorus
        elif r < 0.85:
            h = rng.uniform(sunrise + 1, sunset - 1)
        else:
            h = rng.normal(sunset - 0.8, 0.6)  # evening song
    return h % 24


def to_utc(d: date, hour: float) -> datetime:
    local = datetime.combine(d, time()) + timedelta(hours=hour)
    return local.replace(tzinfo=TZ).astimezone(UTC)


def simulate(occ: pd.DataFrame, days: list[date], station: str, rng: np.random.Generator):
    n = len(occ)
    names = list(zip(occ.scientific_name, occ.common_name))
    kinds = [behavior(c) for _, c in names]
    water = np.array([any(w in c for w in WATER_WORDS) for _, c in names])

    # Fixed per-species traits for this backyard.
    abundance = rng.lognormal(0, 0.6, n) * np.where(water, 0.3, 1.0)
    bout_rate = rng.lognormal(math.log(5), 0.7, n)  # singing bouts per day when present
    detectability = rng.uniform(1.2, 3.0, n)  # higher = BirdNET is more confident on this one
    week_max = occ.filter(like="w").max(axis=1).to_numpy()
    rare_pool = np.flatnonzero(week_max < 0.05)  # candidates for false positives

    raining = False
    rain_streak = 0
    for d in days:
        base = RAIN_ODDS[d.month - 1]
        raining = rng.random() < base + 0.35 * ((1.0 if raining else 0.0) - base)
        rain_streak = rain_streak + 1 if raining else 0
        winter = d.month in (11, 12, 1) or (d.month == 2 and d.day <= 15)
        if winter and rain_streak >= 4:
            continue  # battery flat: no recordings today

        weather = 0.55 if raining else 1.0
        sunrise, sunset = local_hours(d)
        occ_today = occ[week_column(d)].to_numpy()
        present = rng.random(n) < np.minimum(0.97, 1.5 * (occ_today * abundance) ** 1.3)
        peak = spring_peak(d)

        for i in np.flatnonzero(present):
            season = 1 + (1.5 if kinds[i] == "song" else 0.4) * peak
            for _ in range(rng.poisson(bout_rate[i] * (0.5 + occ_today[i]) * season * weather)):
                start = bout_start_hour(kinds[i], sunrise, sunset, rng)
                t = to_utc(d, start).replace(second=0, microsecond=0) + timedelta(seconds=3 * rng.integers(0, 20))
                for _ in range(min(20, rng.geometric(0.3))):
                    if rng.random() > 0.25:  # the bird sometimes pauses for a segment
                        conf = 0.25 + 0.74 * rng.beta(detectability[i], 1.6)
                        yield (station, t.strftime("%Y-%m-%dT%H:%M:%SZ"), *names[i], round(conf, 4), None, SOURCE)
                    t += timedelta(seconds=3)

        for _ in range(rng.poisson(4 * weather)):
            i = rng.choice(rare_pool)
            t = to_utc(d, rng.uniform(0, 24)).replace(microsecond=0)
            conf = 0.25 + 0.3 * rng.beta(1, 3)
            yield (station, t.strftime("%Y-%m-%dT%H:%M:%SZ"), *names[i], round(conf, 4), None, SOURCE)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--days", type=int, default=365)
    p.add_argument("--end", type=date.fromisoformat, default=date.today() - timedelta(days=1))
    p.add_argument("--station", default="backyard")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--occurrence", type=Path, default=ROOT / "data" / "occurrence.csv")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    args = p.parse_args()

    occ = pd.read_csv(args.occurrence)
    days = [args.end - timedelta(days=k) for k in range(args.days - 1, -1, -1)]

    conn = db.connect(args.db)
    conn.execute("DELETE FROM detections WHERE station_id = ? AND source_file = ?", (args.station, SOURCE))
    n = db.insert_detections(conn, simulate(occ, days, args.station, np.random.default_rng(args.seed)))
    print(f"{n} simulated detections, {days[0]} to {days[-1]} -> {args.db}")
