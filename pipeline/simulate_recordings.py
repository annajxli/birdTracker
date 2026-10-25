"""Generate plausible recorder telemetry (the recordings table) for the simulated station.

Until the recorder runs outdoors, this fills the Hardware analytics page. For every day with
simulated detections it lays down the files the recorder would have uploaded: continuous
FILE_MINUTES files from an hour before sunrise to an hour after sunset, with:

  - dropouts: the occasional missing file, and now and then a multi-hour wifi outage
  - background level (dBFS): a quiet floor plus morning and evening traffic, and rain on the
    enclosure on wet days (real rain from data/weather.csv)
  - wifi signal (dBm) that sags a little in rain, and an upload time that follows it
  - pipeline delay: upload, the analyzer's settle check, and analysis, with a backlog after
    an outage clears

Usage: python pipeline/simulate_recordings.py [--station backyard] [--seed 3]
"""

import argparse
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from astral.sun import sun

import db
from simulate import SITE, TZ, WET_INCHES

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "simulated"
FILE_MINUTES = 5
SAMPLE_RATE = 32000
FILE_BITS = FILE_MINUTES * 60 * SAMPLE_RATE * 16  # mono 16-bit WAV
SETTLE_S = 5  # analyzer: a file must hold still this long (two checks)
ANALYZE_S_PER_MIN = 0.8  # BirdNET time per minute of audio on the indoor computer


def ts(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def traffic_db(hour: float, weekday: int) -> float:
    """Extra background from traffic: morning and evening peaks, quieter at weekends."""
    peaks = math.exp(-(((hour - 8) / 1.2) ** 2)) + 0.8 * math.exp(-(((hour - 17.5) / 1.5) ** 2))
    return (5 if weekday < 5 else 2.5) * peaks + 1.5 * (7 <= hour <= 19)


def simulate(days: list[date], station: str, rain: dict[str, float], rng: np.random.Generator):
    rssi_base = -57.0
    backlog_until = None  # the analyzer is still catching up after an outage
    for d in days:
        s = sun(SITE.observer, date=d, tzinfo=TZ)
        start, end = s["sunrise"] - timedelta(hours=1), s["sunset"] + timedelta(hours=1)
        precip = rain.get(d.isoformat(), 0.0)
        wet = precip >= WET_INCHES
        rssi_base += rng.normal(0, 0.6) - 0.15 * (rssi_base + 57)  # slow drift around -57
        outage = None
        if rng.random() < 0.05:  # wifi down for a few hours: files wait on the recorder
            o0 = start + timedelta(hours=float(rng.uniform(1, 10)))
            outage = (o0, o0 + timedelta(hours=float(rng.uniform(1, 4))))
        t = start.replace(minute=start.minute - start.minute % FILE_MINUTES, second=0, microsecond=0)
        while t < end:
            if rng.random() < 0.01:  # a file that never arrived
                t += timedelta(minutes=FILE_MINUTES)
                continue
            hour = t.hour + t.minute / 60
            rms = -63 + traffic_db(hour, d.weekday()) + rng.normal(0, 1.5)
            if wet:
                rms += 6 + min(8, 20 * precip) + rng.normal(0, 1.5)
            rssi = round(rssi_base - (3 if wet else 0) + rng.normal(0, 2))
            kbps = 2300 * min(1.0, max(0.15, (rssi + 92) / 32))
            upload = FILE_BITS / 1000 / kbps * rng.uniform(0.95, 1.15)
            done = t + timedelta(minutes=FILE_MINUTES)
            sent = outage[1] if outage and outage[0] <= done < outage[1] else done
            received = sent + timedelta(seconds=upload)
            ready = received + timedelta(seconds=SETTLE_S * 2 + rng.uniform(0, 5))
            if outage and outage[0] <= done < outage[1]:
                backlog_until = max(backlog_until or ready, ready)
            if backlog_until and ready < backlog_until:
                ready = backlog_until
            analyzed = ready + timedelta(seconds=ANALYZE_S_PER_MIN * FILE_MINUTES * rng.uniform(0.8, 1.3))
            backlog_until = analyzed if backlog_until and analyzed < backlog_until + timedelta(minutes=30) else None
            yield (station, ts(t), FILE_MINUTES * 60.0, round(rms, 1), rssi, round(upload, 1), ts(received), ts(analyzed), SOURCE)
            t += timedelta(minutes=FILE_MINUTES)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--station", default="backyard")
    p.add_argument("--seed", type=int, default=3)
    p.add_argument("--weather", type=Path, default=ROOT / "data" / "weather.csv")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    args = p.parse_args()

    conn = db.connect(args.db)
    real = conn.execute("SELECT count(*) FROM recordings WHERE station_id = ? AND source IS NOT ?", (args.station, SOURCE)).fetchone()[0]
    if real:
        print(f"{args.db} already has {real} real recordings for {args.station!r}; not simulating over them")
        raise SystemExit(0)  # not an error: the site shows the real ones
    # Days the simulated station recorded: the days it has detections (outage days have none).
    utc_days = [r[0] for r in conn.execute("SELECT DISTINCT substr(detected_at, 1, 10) FROM detections WHERE station_id = ?", (args.station,))]
    days = sorted({date.fromisoformat(x) for x in utc_days})
    rain = dict(pd.read_csv(args.weather, usecols=["date", "precip_in"]).itertuples(index=False)) if args.weather.exists() else {}
    conn.execute("DELETE FROM recordings WHERE station_id = ? AND source = ?", (args.station, SOURCE))
    rows = list(simulate(days, args.station, rain, np.random.default_rng(args.seed)))
    conn.executemany("INSERT OR IGNORE INTO recordings (station_id, started_at, seconds, rms_dbfs, rssi_dbm, upload_s, received_at, analyzed_at, source) VALUES (?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    print(f"simulated {len(rows)} recordings over {len(days)} days for {args.station!r}")
