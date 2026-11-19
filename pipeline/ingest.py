"""Load BirdNET-Analyzer CSV results into the detections database.

BirdNET reports times as seconds from the start of each recording, so we need
the recording's start time. By default it is read from the audio filename,
which the recorder should name like `20260512T131500Z.wav` (UTC). For one-off
files, pass --start instead.

Usage:
  python pipeline/ingest.py results/*.BirdNET.results.csv --station STATION
  python pipeline/ingest.py out/soundscape.BirdNET.results.csv --start 2026-05-12T06:15:00-07:00
"""

import argparse
import csv
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import db

FILENAME_TS = re.compile(r"(\d{8}T\d{6}Z)")


def recording_start(source_file: str, override: datetime | None) -> datetime:
    if override:
        return override.astimezone(UTC)
    m = FILENAME_TS.search(Path(source_file).name)
    if not m:
        raise ValueError(f"can't find a YYYYMMDDTHHMMSSZ timestamp in {source_file!r}; pass --start")
    return datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)


def read_results(path: Path, station: str, start: datetime | None):
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            t0 = recording_start(row["File"], start) + timedelta(seconds=float(row["Start (s)"]))
            yield {
                "station_id": station,
                "detected_at": t0.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "scientific_name": row["Scientific name"],
                "common_name": row["Common name"],
                "confidence": float(row["Confidence"]),
                "clip_path": None,
                "source_file": Path(row["File"]).name,
            }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("results", nargs="+", type=Path, help="BirdNET CSV result files (--rtype csv)")
    p.add_argument("--station", default="backyard")
    p.add_argument("--start", type=datetime.fromisoformat, help="recording start time (ISO 8601 with offset)")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    args = p.parse_args()

    conn = db.connect(args.db)
    total = sum(db.insert_detections(conn, read_results(f, args.station, args.start)) for f in args.results)
    print(f"inserted {total} detections into {args.db}")
