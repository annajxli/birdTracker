"""Watch a folder for new recordings, identify birds with BirdNET, and store the results.

This is the indoor half of the setup in docs/hardware.md: the recorder drops
short audio files (named by their UTC start time, e.g. 20260512T131500Z.flac)
into the incoming folder, and for each one this:

  1. runs BirdNET-Analyzer with the station's location and the week of year
  2. adds the detections to the database (same rows as ingest.py)
  3. cuts a short Opus clip of the most confident detection per species per
     hour, and records its path on that detection
  4. moves the recording to processed/ (or failed/ if analysis errored), and
     deletes recordings processed more than --keep-days ago

The BirdNET model loads once and stays in memory while watching.

Usage:
  python pipeline/analyzer.py --watch            # keep watching data/incoming/
  python pipeline/analyzer.py --once             # process what's there, then exit
"""

import argparse
import logging
import os
import shutil
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import soundfile as sf

import db
from ingest import read_results, recording_start

ROOT = Path(__file__).resolve().parent.parent
AUDIO_SUFFIXES = {".flac", ".wav", ".mp3", ".ogg"}
SEGMENT_SECONDS = 3.0
CLIP_PAD_SECONDS = 1.0  # extra audio either side of the 3 s detection
SETTLE_SECONDS = 5  # a file must be unchanged this long before we treat it as complete

log = logging.getLogger("analyzer")


def birdnet_week(t: datetime) -> int:
    """BirdNET's 48-week calendar: 4 weeks per month."""
    return (t.month - 1) * 4 + min(3, (t.day - 1) // 7) + 1


def ready_files(incoming: Path) -> list[Path]:
    """Audio files in incoming/ that have stopped changing (the recorder is done writing)."""
    now = time.time()
    return sorted(
        p for p in incoming.iterdir()
        if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES and now - p.stat().st_mtime >= SETTLE_SECONDS
    )


def run_birdnet(audio: Path, out_dir: Path, lat: float, lon: float, min_conf: float) -> Path:
    """Analyze one file; returns the path of BirdNET's CSV results."""
    from birdnet_analyzer.analyze.core import analyze  # slow import; only needed when there's work

    week = birdnet_week(recording_start(audio.name, None))
    analyze(str(audio), output=str(out_dir), lat=lat, lon=lon, week=week, min_conf=min_conf, rtype="csv", threads=4)
    results = list(out_dir.glob(f"{audio.stem}*.BirdNET.results.csv"))
    if not results:
        raise RuntimeError(f"BirdNET wrote no results for {audio.name}")
    return results[0]


def best_per_species_hour(rows: list[dict]) -> list[dict]:
    """The most confident detection of each species in each hour."""
    best = {}
    for r in rows:
        key = (r["scientific_name"], r["detected_at"][:13])  # species, YYYY-MM-DDTHH
        if key not in best or r["confidence"] > best[key]["confidence"]:
            best[key] = r
    return list(best.values())


def cut_clip(audio: Path, start_s: float, out: Path) -> Path:
    """Write the detection's audio (with a little padding) to `out`; returns the path actually written."""
    info = sf.info(audio)
    begin = max(0.0, start_s - CLIP_PAD_SECONDS)
    end = min(info.duration, start_s + SEGMENT_SECONDS + CLIP_PAD_SECONDS)
    data, rate = sf.read(audio, start=int(begin * info.samplerate), stop=int(end * info.samplerate), always_2d=False)
    out.parent.mkdir(parents=True, exist_ok=True)
    if rate in (8000, 12000, 16000, 24000, 48000):
        sf.write(out, data, rate, format="OGG", subtype="OPUS")
        return out
    # Opus only supports a few sample rates; fall back to FLAC.
    out = out.with_suffix(".flac")
    sf.write(out, data, rate, format="FLAC")
    return out


def current_clip(conn, station: str, scientific_name: str, hour: str):
    """The detection already holding this species' clip for this hour (YYYY-MM-DDTHH), if any."""
    return conn.execute(
        "SELECT id, confidence, clip_path FROM detections WHERE station_id = ? AND scientific_name = ? "
        "AND substr(detected_at, 1, 13) = ? AND clip_path IS NOT NULL",
        (station, scientific_name, hour),
    ).fetchone()


def process(audio: Path, args, conn) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        csv_path = run_birdnet(audio, Path(tmp), args.lat, args.lon, args.min_conf)
        rows = list(read_results(csv_path, args.station, None))

    start = recording_start(audio.name, None)
    for r in rows:
        r["source_file"] = audio.name  # BirdNET reports the full path; keep just the name

    # One clip per species per hour, across files: only cut one if it beats the clip already kept.
    clips_dir = args.data / "clips"
    replaced = []
    for r in best_per_species_hour(rows):
        prev = current_clip(conn, r["station_id"], r["scientific_name"], r["detected_at"][:13])
        if prev and prev[1] >= r["confidence"]:
            continue
        offset = (datetime.strptime(r["detected_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) - start).total_seconds()
        rel = Path(r["detected_at"][:10]) / f"{r['scientific_name'].replace(' ', '_')}_{r['detected_at'][11:19].replace(':', '')}.ogg"
        try:
            written = cut_clip(audio, offset, clips_dir / rel)
            r["clip_path"] = written.relative_to(args.data).as_posix()
            if prev:
                replaced.append(prev)
        except Exception:
            log.exception("couldn't cut a clip from %s at %.1fs", audio.name, offset)

    inserted = db.insert_detections(conn, rows)
    for row_id, _, old_path in replaced:
        conn.execute("UPDATE detections SET clip_path = NULL WHERE id = ?", (row_id,))
        (args.data / old_path).unlink(missing_ok=True)
    # A re-run may find rows that already exist; still attach any new clips to them.
    conn.executemany(
        "UPDATE detections SET clip_path = ? WHERE station_id = ? AND detected_at = ? AND scientific_name = ? AND clip_path IS NULL",
        [(r["clip_path"], r["station_id"], r["detected_at"], r["scientific_name"]) for r in rows if r["clip_path"]],
    )
    conn.commit()
    return inserted


def prune(processed: Path, keep_days: float) -> None:
    cutoff = time.time() - keep_days * 86400
    for p in processed.iterdir():
        if p.is_file() and p.stat().st_mtime < cutoff:
            p.unlink()
            log.info("deleted old recording %s", p.name)


def run_once(args, conn) -> int:
    incoming, processed, failed = (args.data / d for d in ("incoming", "processed", "failed"))
    for d in (incoming, processed, failed):
        d.mkdir(parents=True, exist_ok=True)

    files = ready_files(incoming)
    for audio in files:
        try:
            recording_start(audio.name, None)
        except ValueError:
            log.warning("skipping %s: name has no YYYYMMDDTHHMMSSZ start time", audio.name)
            shutil.move(audio, failed / audio.name)
            continue
        try:
            n = process(audio, args, conn)
            shutil.move(audio, processed / audio.name)
            os.utime(processed / audio.name)  # keep-days counts from processing, not from recording
            log.info("%s: %d new detections", audio.name, n)
        except Exception:
            log.exception("analysis failed for %s", audio.name)
            shutil.move(audio, failed / audio.name)
    prune(processed, args.keep_days)
    return len(files)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--watch", action="store_true", help="keep watching for new recordings")
    mode.add_argument("--once", action="store_true", help="process what's waiting, then exit")
    p.add_argument("--data", type=Path, default=ROOT / "data", help="holds incoming/, processed/, failed/, clips/")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    p.add_argument("--station", default="backyard")
    p.add_argument("--lat", type=float, default=47.61)
    p.add_argument("--lon", type=float, default=-122.33)
    p.add_argument("--min-conf", type=float, default=0.25, help="BirdNET's own cutoff; the dashboard filters further")
    p.add_argument("--keep-days", type=float, default=3, help="delete recordings this many days after processing them")
    p.add_argument("--interval", type=float, default=30, help="seconds between checks when watching")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    conn = db.connect(args.db)
    if args.once:
        run_once(args, conn)
    else:
        log.info("watching %s every %ss", args.data / "incoming", args.interval)
        while True:
            run_once(args, conn)
            time.sleep(args.interval)
