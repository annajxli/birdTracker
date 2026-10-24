"""Watch a folder for new recordings, identify birds with BirdNET, and store the results.

This is the indoor half of the setup in docs/hardware.md: the recorder drops
short audio files (named by their UTC start time, e.g. 20260512T131500Z.flac)
into the incoming folder, and for each one this:

  1. runs BirdNET-Analyzer with the station's location and the week of year
  2. adds the detections to the database (same rows as ingest.py)
  3. cuts a short Opus clip of the most confident detection per species per
     hour, and records its path on that detection
  4. moves the recording to processed/, and deletes recordings processed more
     than --keep-days ago

A recording only counts as finished once its size and modification time have
held still across two checks at least SETTLE_SECONDS apart. Recorders should
still write to a temporary name (e.g. "20260512T131500Z.flac.part") and rename
when done; those names are ignored until then.

When analysis fails, the recording stays in incoming/ and is retried; after
MAX_ATTEMPTS failures it moves to failed/. Failures that aren't about the file
(BirdNET missing, the database locked, a full disk) don't count against it:
the pass stops and --watch backs off until the problem clears. Only one
analyzer runs per data folder at a time.

The BirdNET model loads once and stays in memory while watching.

Usage:
  python pipeline/analyzer.py --watch            # keep watching data/incoming/
  python pipeline/analyzer.py --once             # process what's there, then exit
"""

import argparse
import errno
import fcntl
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import soundfile as sf

import db
from ingest import read_results, recording_start

ROOT = Path(__file__).resolve().parent.parent
AUDIO_SUFFIXES = {".flac", ".wav", ".mp3", ".ogg"}
SEGMENT_SECONDS = 3.0
CLIP_PAD_SECONDS = 1.0  # extra audio either side of the 3 s detection
SETTLE_SECONDS = 5  # a file must be unchanged this long before we treat it as complete
MAX_ATTEMPTS = 3  # analysis failures before a recording is moved to failed/
MAX_BACKOFF_SECONDS = 15 * 60
LOCAL_TZ = ZoneInfo("America/Los_Angeles")  # the station's time zone, for BirdNET's week

log = logging.getLogger("analyzer")


def birdnet_week(t: datetime) -> int:
    """BirdNET's 48-week calendar: 4 weeks per month."""
    return (t.month - 1) * 4 + min(3, (t.day - 1) // 7) + 1


class EnvironmentProblem(Exception):
    """A failure that isn't the recording's fault; retry later instead of quarantining files."""


def is_environment_error(e: BaseException) -> bool:
    if isinstance(e, (ImportError, MemoryError, sqlite3.OperationalError, sqlite3.DatabaseError)):
        return True
    return isinstance(e, OSError) and e.errno in {errno.ENOSPC, errno.EROFS, errno.EACCES, errno.EDQUOT}


def snapshot(incoming: Path) -> dict[Path, tuple[int, float]]:
    """Size and mtime of each audio file in incoming/ (temporary names like *.flac.part are skipped)."""
    out = {}
    for p in incoming.iterdir():
        if p.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        try:
            st = p.stat()
        except FileNotFoundError:  # renamed or removed between listing and stat
            continue
        if p.is_file():
            out[p] = (st.st_size, st.st_mtime)
    return out


def ready_files(previous: dict, current: dict) -> list[Path]:
    """Files unchanged since the previous check and quiet for SETTLE_SECONDS: the recorder is done."""
    now = time.time()
    return sorted(p for p, sig in current.items() if previous.get(p) == sig and now - sig[1] >= SETTLE_SECONDS)


def move(src: Path, dest_dir: Path) -> None:
    """Move a recording, tolerating one that another process already moved."""
    try:
        shutil.move(src, dest_dir / src.name)
    except FileNotFoundError:
        log.warning("%s disappeared before it could be moved to %s/", src.name, dest_dir.name)


def run_birdnet(audio: Path, out_dir: Path, lat: float, lon: float, min_conf: float) -> Path:
    """Analyze one file; returns the path of BirdNET's CSV results."""
    from birdnet_analyzer.analyze.core import analyze  # slow import; only needed when there's work

    week = birdnet_week(recording_start(audio.name, None).astimezone(LOCAL_TZ))
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

    inserted = db.insert_detections(conn, rows, commit=False)  # one transaction with the clip updates
    for row_id, _, _ in replaced:
        conn.execute("UPDATE detections SET clip_path = NULL WHERE id = ?", (row_id,))
    # A re-run may find rows that already exist; still attach any new clips to them.
    conn.executemany(
        "UPDATE detections SET clip_path = ? WHERE station_id = ? AND detected_at = ? AND scientific_name = ? AND clip_path IS NULL",
        [(r["clip_path"], r["station_id"], r["detected_at"], r["scientific_name"]) for r in rows if r["clip_path"]],
    )
    conn.commit()
    # Only now that the database points at the new clips, delete the ones they replaced. A re-run of
    # the same recording cuts its clip to the same path, which must not be deleted.
    kept = {r["clip_path"] for r in rows if r["clip_path"]}
    for _, _, old_path in replaced:
        if old_path not in kept:
            (args.data / old_path).unlink(missing_ok=True)
    return inserted


def prune(processed: Path, keep_days: float) -> None:
    cutoff = time.time() - keep_days * 86400
    for p in processed.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                log.info("deleted old recording %s", p.name)
        except FileNotFoundError:
            pass


def run_once(args, conn, state: dict) -> int:
    """One pass over incoming/. state carries the last snapshot and per-file failure counts
    between passes. Raises EnvironmentProblem if something other than a recording is broken."""
    incoming, processed, failed = (args.data / d for d in ("incoming", "processed", "failed"))
    for d in (incoming, processed, failed):
        d.mkdir(parents=True, exist_ok=True)

    current = snapshot(incoming)
    files = ready_files(state.get("snapshot", {}), current)
    state["snapshot"] = current
    attempts = state.setdefault("attempts", {})
    for audio in files:
        try:
            recording_start(audio.name, None)
        except ValueError:
            log.warning("skipping %s: name has no YYYYMMDDTHHMMSSZ start time", audio.name)
            move(audio, failed)
            continue
        try:
            n = process(audio, args, conn)
        except Exception as e:
            conn.rollback()
            if is_environment_error(e):
                raise EnvironmentProblem(f"{type(e).__name__}: {e}") from e
            attempts[audio.name] = attempts.get(audio.name, 0) + 1
            log.exception("analysis failed for %s (attempt %d of %d)", audio.name, attempts[audio.name], MAX_ATTEMPTS)
            if attempts[audio.name] >= MAX_ATTEMPTS:
                move(audio, failed)
                del attempts[audio.name]
            continue
        attempts.pop(audio.name, None)
        move(audio, processed)
        try:
            os.utime(processed / audio.name)  # keep-days counts from processing, not from recording
        except FileNotFoundError:
            pass
        log.info("%s: %d new detections", audio.name, n)
    prune(processed, args.keep_days)
    return len(files)


def single_instance(data: Path):
    """Hold an exclusive lock on data/.analyzer.lock for the life of the process, or exit."""
    data.mkdir(parents=True, exist_ok=True)
    lock = open(data / ".analyzer.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(f"another analyzer is already running on {data}")
    return lock


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
    lock = single_instance(args.data)
    conn = db.connect(args.db)
    state = {}
    if args.once:
        # Two looks SETTLE_SECONDS apart, so files still being written are left for next time.
        state["snapshot"] = snapshot(args.data / "incoming") if (args.data / "incoming").exists() else {}
        time.sleep(SETTLE_SECONDS)
        try:
            run_once(args, conn, state)
        except EnvironmentProblem as e:
            sys.exit(f"stopped, nothing moved: {e}")
    else:
        log.info("watching %s every %ss", args.data / "incoming", args.interval)
        backoff = 0
        while True:
            try:
                run_once(args, conn, state)
                backoff = 0
            except EnvironmentProblem as e:
                backoff = min(MAX_BACKOFF_SECONDS, max(args.interval, backoff * 2))
                log.error("can't analyze right now (%s); recordings stay in incoming/, retrying in %ds", e, backoff)
            except Exception:
                log.exception("unexpected error; carrying on")
            time.sleep(max(args.interval, backoff))
