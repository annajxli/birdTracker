"""Generate a year of fake-but-plausible BirdNET detections for one station.

Species and seasons come from BirdNET's own location model (data/occurrence.csv,
built by occurrence.py), so the species mix matches what BirdNET would expect in
Seattle each week. On top of that it models:

  - per-species local abundance, so some birds dominate and others are rare
  - time of day: a dawn chorus for songbirds, daytime calls for crows/jays/raptors,
    night calls for owls, all following real sunrise/sunset times
  - seasonality: songbirds sing much more in spring (breeding season)
  - real Seattle rain (data/weather.csv from weather.py): wet days suppress
    activity, more so the heavier the rain, and runs of wet winter days flatten
    a solar-powered recorder's battery. Dates without weather data fall back to
    random rain with Seattle-ish monthly odds.
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
WET_INCHES = 0.04  # less than this counts as a dry day

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
# Birds that are common in Seattle yards; they get an abundance boost.
YARD_REGULARS = {
    "American Robin", "Song Sparrow", "Dark-eyed Junco", "Black-capped Chickadee",
    "Chestnut-backed Chickadee", "Spotted Towhee", "Bewick's Wren", "Anna's Hummingbird",
    "House Finch", "American Crow", "Steller's Jay", "Northern Flicker", "Bushtit",
    "Pacific Wren", "Golden-crowned Kinglet", "Red-breasted Nuthatch", "Downy Woodpecker",
    "Swainson's Thrush", "Varied Thrush", "Black-headed Grosbeak", "Pine Siskin",
    "American Goldfinch", "White-crowned Sparrow", "Cedar Waxwing", "Ruby-crowned Kinglet",
}


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


def rain_activity(precip_in: float) -> float:
    """Share of normal bird activity on a day with this much rain."""
    if precip_in < WET_INCHES:
        return 1.0
    return 1.0 - min(0.6, 0.15 + 0.8 * precip_in)


def simulate(occ: pd.DataFrame, days: list[date], station: str, rng: np.random.Generator, rain: dict[str, float] | None = None):
    n = len(occ)
    names = list(zip(occ.scientific_name, occ.common_name))
    kinds = [behavior(c) for _, c in names]
    water = np.array([any(w in c for w in WATER_WORDS) for _, c in names])
    regular = np.array([c in YARD_REGULARS for _, c in names])

    # Fixed per-species traits for this station.
    abundance = rng.lognormal(0, 0.4, n) * np.where(water, 0.3, 1.0) * np.where(regular, 2.0, 0.8)
    bout_rate = rng.lognormal(math.log(3), 0.6, n)  # singing bouts per day when present
    detectability = rng.uniform(1.2, 3.0, n)  # higher = BirdNET is more confident on this one
    week_max = occ.filter(like="w").max(axis=1).to_numpy()
    rare_pool = np.flatnonzero(week_max < 0.05)  # candidates for false positives

    rain = rain or {}
    raining = False
    rain_streak = 0
    for d in days:
        if d.isoformat() in rain:
            precip = rain[d.isoformat()]
            raining = precip >= WET_INCHES
        else:
            base = RAIN_ODDS[d.month - 1]
            raining = rng.random() < base + 0.35 * ((1.0 if raining else 0.0) - base)
            precip = 0.15 if raining else 0.0
        rain_streak = rain_streak + 1 if raining else 0
        winter = d.month in (11, 12, 1) or (d.month == 2 and d.day <= 15)
        if winter and rain_streak >= 4:
            continue  # battery flat: no recordings today

        weather = rain_activity(precip)
        sunrise, sunset = local_hours(d)
        occ_today = occ[week_column(d)].to_numpy()
        present = rng.random(n) < np.minimum(0.97, 2.0 * occ_today**2 * abundance)
        peak = spring_peak(d)

        for i in np.flatnonzero(present):
            season = 1 + (1.5 if kinds[i] == "song" else 0.4) * peak
            for _ in range(rng.poisson(bout_rate[i] * (0.5 + occ_today[i]) * season * weather)):
                start = bout_start_hour(kinds[i], sunrise, sunset, rng)
                t = to_utc(d, start).replace(second=0, microsecond=0) + timedelta(seconds=3 * int(rng.integers(0, 20)))
                # A bout lasts from seconds to many minutes (long-tailed, longer for songbirds),
                # with a song or call every 3-15 s; BirdNET misses some of them.
                length = min(25 * 60, rng.lognormal(math.log(75 if kinds[i] == "song" else 20), 0.9))
                end = t + timedelta(seconds=length)
                while t <= end:
                    if rng.random() > 0.25:
                        conf = 0.25 + 0.74 * rng.beta(detectability[i], 1.6)
                        yield (station, t.strftime("%Y-%m-%dT%H:%M:%SZ"), *names[i], round(conf, 4), None, SOURCE)
                    t += timedelta(seconds=3 * int(rng.integers(1, 6)))

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
    p.add_argument("--weather", type=Path, default=ROOT / "data" / "weather.csv", help="daily rain from weather.py, if present")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    p.add_argument("--force", action="store_true", help="simulate even if this station already has real detections")
    args = p.parse_args()

    occ = pd.read_csv(args.occurrence)
    rain = dict(pd.read_csv(args.weather, usecols=["date", "precip_in"]).itertuples(index=False)) if args.weather.exists() else {}
    days = [args.end - timedelta(days=k) for k in range(args.days - 1, -1, -1)]

    conn = db.connect(args.db)
    # Simulated rows look just like real ones on the dashboard, so don't mix them into a real station.
    real = conn.execute("SELECT count(*) FROM detections WHERE station_id = ? AND source_file IS NOT ?", (args.station, SOURCE)).fetchone()[0]
    if real and not args.force:
        raise SystemExit(f"{args.db} already has {real} real detections for station {args.station!r}; "
                         "use --station or --db to simulate elsewhere, or --force to mix them anyway")
    conn.execute("DELETE FROM detections WHERE station_id = ? AND source_file = ?", (args.station, SOURCE))
    n = db.insert_detections(conn, simulate(occ, days, args.station, np.random.default_rng(args.seed), rain))
    covered = sum(d.isoformat() in rain for d in days)
    print(f"{n} simulated detections, {days[0]} to {days[-1]} ({covered} days with real rain data) -> {args.db}")
