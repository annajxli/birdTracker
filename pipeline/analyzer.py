"""Watch a folder for new recordings, identify birds with BirdNET, and store the results.

This is the indoor half of the system in docs/architecture.md: the recorder drops
short audio files (named by their UTC start time, e.g. 20260512T131500Z.flac)
into the incoming folder, and for each one this:

  1. runs BirdNET with the station's location and the week of year: by default
     the model alone on the small TFLite runtime (birdnet_lite.py; what the
     Raspberry Pi can run), or --engine analyzer for birdnet-analyzer itself
  2. adds the detections to the database (same rows as ingest.py)
  3. cuts a short Opus clip of the most confident detection per species per
     hour, records its path on that detection, and renders the clip's
     spectrogram beside it (same name, .webp; see spectrogram.py)
  4. renders the whole recording's spectrogram into live/, with 24 kHz MP3
     copies of its audio (as recorded, and cleaned by denoise.py for the
     Live page's Bird boost), and lists them, with its detections, in
     live/live.json (the last day) and live/days/, for the site's near-live
     view; strips older than --live-hours (a week) are deleted (publish.py
     uploads them)
  5. deletes the recording (or, with --keep-days, moves it to processed/ and
     deletes it that many days later)

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
import csv
import errno
import fcntl
import json
import logging
import math
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

import db
import thresholds
from ingest import read_results, recording_start
from denoise import clean
from spectrogram import render as render_spectrogram

ROOT = Path(__file__).resolve().parent.parent
AUDIO_SUFFIXES = {".flac", ".wav", ".mp3", ".ogg"}
SEGMENT_SECONDS = 3.0
CLIP_PAD_SECONDS = 1.0  # extra audio either side of the 3 s detection
SETTLE_SECONDS = 5  # a file must be unchanged this long before we treat it as complete
MAX_ATTEMPTS = 3  # analysis failures before a recording is moved to failed/
MAX_BACKOFF_SECONDS = 15 * 60
LOCAL_TZ = ZoneInfo("America/Los_Angeles")  # the station's time zone, for BirdNET's week
LIVE_AUDIO_RATE = 24000  # keeps the spectrogram's 0-12 kHz
LIVE_AUDIO_LEVEL = 0.2  # libsndfile's MP3 compression level: ~53 kbit/s, ~390 KB a minute (0.5 left holes
                        # at 8-11 kHz that warble once playback lifts quiet audio 30 dB). MP3 rather
                        # than Opus: ~35x faster to encode (a Pi 3B+ took 27 s a minute for Opus), and
                        # every browser plays it

log = logging.getLogger("analyzer")


def birdnet_week(t: datetime) -> int:
    """BirdNET's 48-week calendar: 4 weeks per month."""
    return (t.month - 1) * 4 + min(3, (t.day - 1) // 7) + 1


class EnvironmentProblem(Exception):
    """A failure that isn't the recording's fault; retry later instead of quarantining files."""


def is_environment_error(e: BaseException) -> bool:
    if isinstance(e, (EnvironmentProblem, ImportError, MemoryError, sqlite3.OperationalError, sqlite3.DatabaseError)):
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


_lite = None  # the TFLite model, loaded on first use and kept while watching


def run_birdnet(audio: Path, out_dir: Path, args) -> Path:
    """Analyze one file; returns the path of BirdNET's CSV results."""
    global _lite
    week = birdnet_week(recording_start(audio.name, None).astimezone(LOCAL_TZ))
    if args.engine == "lite":
        if _lite is None:
            try:
                from birdnet_lite import BirdNET
                _lite = BirdNET(threads=args.threads)
            except Exception as e:  # missing or damaged model files: no recording's fault
                raise EnvironmentProblem(f"can't load BirdNET: {e}") from e
        return _lite.analyze(audio, out_dir, args.lat, args.lon, week, args.min_conf)
    from birdnet_analyzer.analyze.core import analyze  # slow import (TensorFlow); only needed when there's work

    analyze(str(audio), output=str(out_dir), lat=args.lat, lon=args.lon, week=week, min_conf=args.min_conf,
            rtype="csv", threads=args.threads)
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
    start = recording_start(audio.name, None)
    with tempfile.TemporaryDirectory() as tmp:
        csv_path = run_birdnet(audio, Path(tmp), args)
        rows = list(read_results(csv_path, args.station, None))
        sounds = read_sounds(csv_path.with_name(f"{audio.stem}.BirdNET.sounds.csv"), start)
        species = thresholds.load(args.data / "live" / "thresholds.json")
        activity = read_activity(csv_path.with_name(f"{audio.stem}.BirdNET.activity.csv"), species)
        unidentified = read_unidentified(csv_path.with_name(f"{audio.stem}.BirdNET.activity.csv"), start, species)

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
            continue
        try:
            render_spectrogram(written)
        except Exception:  # the clip still plays without its picture
            log.exception("couldn't render a spectrogram for %s", written.name)

    inserted = db.insert_detections(conn, rows, commit=False)  # one transaction with the clip updates
    record_telemetry(audio, start, args, conn, activity)
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
            (args.data / old_path).with_suffix(".webp").unlink(missing_ok=True)
    if args.live_hours > 0:
        queue_live(audio, rows, sounds, args, unidentified)
    return inserted


_live_worker = None  # one background thread for the near-live view, started on first use


def read_sounds(path: Path, start: datetime) -> list[dict]:
    """The non-bird sounds birdnet_lite heard (a dog, a voice, an engine), for the Live page only:
    they're never stored as detections. birdnet-analyzer doesn't write this file."""
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return [{"at": (start + timedelta(seconds=float(r["Start (s)"]))).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "sound": r["Sound"], "confidence": round(float(r["Confidence"]), 3)} for r in csv.DictReader(f)]


def queue_live(audio: Path, rows: list[dict], sounds: list[dict], args, unidentified: list[dict] = ()) -> None:
    """Hand the near-live view's work (spectrogram, cleaned copy, two MP3s: ~40 s a minute on a
    Pi 3B+) to a background thread, so BirdNET starts on the next minute meanwhile on the other
    cores; in turn, a minute took longer than a minute. The thread gets its own hard link to the
    recording, since run_once deletes the original right after this returns."""
    global _live_worker
    pending = args.data / "live-pending"
    pending.mkdir(exist_ok=True)
    copy = pending / audio.name
    copy.unlink(missing_ok=True)
    try:
        os.link(audio, copy)
    except OSError:
        shutil.copy2(audio, copy)
    if _live_worker is None:
        _live_worker = ThreadPoolExecutor(1, thread_name_prefix="live")
    _live_worker.submit(live_job, copy, rows, sounds, args, unidentified)


def live_job(copy: Path, rows: list[dict], sounds: list[dict], args, unidentified: list[dict] = ()) -> None:
    try:
        update_live(copy, rows, args, sounds, unidentified)
    except Exception:  # the near-live view is a nicety; the detections are already stored
        log.exception("couldn't add %s to the live view", copy.name)
    finally:
        copy.unlink(missing_ok=True)


def background_dbfs(data, rate: int) -> float | None:
    """The background level: RMS of the quietest 10% of 1 s windows, in dBFS. Windows of exact
    zeros (silence the receiver filled in) don't count."""
    n = len(data) // rate
    if not n:
        return None
    rms = np.sqrt(np.mean(np.square(data[:n * rate].reshape(n, rate), dtype=np.float64), axis=1))
    rms = np.sort(rms[rms > 0])
    if not len(rms):
        return None
    return round(20 * math.log10(float(rms[: max(1, len(rms) // 10)].mean())), 1)


# A 3 s window counts as birdsong when BirdNET's "any bird" score reaches ANY_BIRD and its likeliest
# species isn't blocked by reviews (thresholds.py: a blocked species is usually another sound, such
# as backup beeps for an owl), and as unidentified birdsong when, on top of that, that species
# doesn't reach its own threshold. Provisional: labeled windows will show where real birds start.
ANY_BIRD = 0.5


def activity_windows(path: Path, species: dict) -> list[tuple[float, bool]]:
    """(start in seconds, identified) for each birdsong window in birdnet_lite's activity file.
    Files from before the "Best name" column use the default threshold."""
    if not path.exists():
        return []
    out = []
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            name, best = r.get("Best name") or None, float(r["Best species"])
            if float(r["Any bird"]) >= ANY_BIRD and thresholds.threshold(species, name) is not None:
                out.append((float(r["Start (s)"]), thresholds.confident(species, name, best)))
    return out


def read_activity(path: Path, species: dict | None = None) -> tuple[int, int] | None:
    """(bird windows, unidentified windows) from birdnet_lite's activity file, or None without one."""
    if not path.exists():
        return None
    windows = activity_windows(path, species or {})
    return len(windows), sum(1 for _, identified in windows if not identified)


def read_unidentified(path: Path, start: datetime, species: dict | None = None) -> list[dict]:
    """The windows that read_activity counts as unidentified birdsong, as {"at", "seconds"} for the
    Live page, which draws them as "Unidentified bird" (dashboard/src/components/live-unidentified.js)."""
    return [{"at": (start + timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%SZ"), "seconds": SEGMENT_SECONDS}
            for s, identified in activity_windows(path, species or {}) if not identified]


def record_telemetry(audio: Path, start: datetime, args, conn, activity: tuple[int, int] | None = None) -> None:
    """The recording's row in the recordings table (Hardware analytics): its length less any
    filled-in silence, background level, and the receiver's notes in <name>.json, when there
    (wifi signal, board temperature and uptime, audio frames sent and dropped)."""
    try:
        notes = json.loads(audio.with_suffix(".json").read_text())
    except (FileNotFoundError, ValueError):
        notes = {}
    data, rate = sf.read(audio, always_2d=False, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    conn.execute(
        "INSERT OR REPLACE INTO recordings (station_id, started_at, seconds, rms_dbfs, rssi_dbm, upload_s, received_at,"
        " analyzed_at, source, board_temp_c, board_uptime_s, frames_sent, frames_dropped, bird_windows, unidentified_windows)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (args.station, start.strftime("%Y-%m-%dT%H:%M:%SZ"), round(len(data) / rate - notes.get("gap_seconds", 0), 2),
         background_dbfs(data, rate), notes.get("rssi_dbm"), None, notes.get("received_at"),
         datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "recorder", notes.get("board_temp_c"), notes.get("board_uptime_s"),
         notes.get("frames_sent"), notes.get("frames_dropped"), *(activity or (None, None))))


def silence_fills(data, rate: int, min_seconds: float = 0.25) -> list[list[float]]:
    """Where the receiver filled a dropout with silence: runs of exact zeros (a live mic never
    gives those), as [start, end] seconds into the recording. The site hatches them."""
    zero = np.r_[False, data == 0, False]
    edges = np.flatnonzero(zero[1:] != zero[:-1])
    return [[round(float(a) / rate, 2), round(float(b) / rate, 2)] for a, b in zip(edges[::2], edges[1::2]) if b - a >= min_seconds * rate]


def update_live(audio: Path, rows: list[dict], args, sounds: list[dict] = (), unidentified: list[dict] = ()) -> None:
    """Add the recording's spectrogram strip and MP3s to live/, list it in live/live.json and its
    day's file, and drop strips older than --live-hours. Strip lists are oldest first, each strip
    with its detections."""
    live = args.data / "live"
    live.mkdir(exist_ok=True)
    image = live / (audio.stem + ".webp")
    render_spectrogram(audio, image)
    data, rate = sf.read(audio, always_2d=False, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    # Twice: as recorded, and with the background turned down (denoise.py) for Bird boost.
    sound, cleaned = live / (audio.stem + ".mp3"), live / (audio.stem + ".clean.mp3")
    g = math.gcd(LIVE_AUDIO_RATE, rate)
    begun = recording_start(audio.name, None)
    at = lambda r: (datetime.strptime(r["detected_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) - begun).total_seconds()
    keep = [(at(r), at(r) + SEGMENT_SECONDS) for r in rows]  # BirdNET's windows: never clean a detected call away
    for path, samples in ((sound, data), (cleaned, clean(data, rate, keep))):
        part = path.with_name(path.name + ".part")  # publish.py skips .part files
        sf.write(part, resample_poly(samples, LIVE_AUDIO_RATE // g, rate // g).astype("float32"), LIVE_AUDIO_RATE,
                 format="MP3", subtype="MPEG_LAYER_III", compression_level=LIVE_AUDIO_LEVEL)
        os.replace(part, path)
    start = recording_start(audio.name, None)
    gaps = silence_fills(data, rate)
    entry = {
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seconds": round(sf.info(audio).duration, 2),
        "image": image.name,
        "audio": sound.name,
        "clean": cleaned.name,
        **({"gaps": gaps} if gaps else {}),
        **({"sounds": sorted(sounds, key=lambda s: s["at"])} if sounds else {}),
        **({"unidentified": list(unidentified)} if unidentified else {}),
        "detections": [
            {"at": r["detected_at"], "common_name": r["common_name"], "scientific_name": r["scientific_name"],
             "confidence": round(r["confidence"], 3)}
            for r in sorted(rows, key=lambda r: r["detected_at"])
        ],
    }
    now = datetime.now(UTC)
    stamp = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
    index = live / "live.json"
    days = live / "days"
    if not days.exists():  # first run with day files: start them from what live.json has
        days.mkdir()
        for s in read_strips(index):
            add_to_day(days, s)
    add_to_day(days, entry)
    recent = stamp(now - timedelta(hours=LIVE_JSON_HOURS))
    strips = [s for s in read_strips(index) if s["image"] != entry["image"] and s["start"] >= recent] + [entry]
    write_json(index, {"updated": stamp(now), "strips": sorted(strips, key=lambda s: s["start"])})
    prune_days(live, stamp(now - timedelta(hours=args.live_hours)))


# The Live page polls live.json (the last LIVE_JSON_HOURS) every 30 s; the rest of --live-hours is
# in live/days/<UTC date>.json, one file per day with the same strip entries, listed in
# live/days.json with each day's span and, per UTC hour, the minutes of audio and the minutes
# with a confident bird (thresholds.py), so the page can draw a week without loading every day.
LIVE_JSON_HOURS = 24


def read_strips(path: Path) -> list[dict]:
    try:
        return json.loads(path.read_text())["strips"]
    except (FileNotFoundError, KeyError, ValueError):
        return []


def write_json(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".part")  # publish.py skips .part files
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def add_to_day(days: Path, entry: dict) -> None:
    path = days / f"{entry['start'][:10]}.json"
    strips = [s for s in read_strips(path) if s["image"] != entry["image"]] + [entry]
    write_day(path, sorted(strips, key=lambda s: s["start"]))


def write_day(path: Path, strips: list[dict]) -> None:
    """Write a day's file and its line in days.json (or remove both if it has no strips left)."""
    date = path.stem
    index = path.parent.parent / "days.json"
    try:
        listed = [d for d in json.loads(index.read_text()) if d["date"] != date]
    except (FileNotFoundError, ValueError):
        listed = []
    if strips:
        write_json(path, {"date": date, "strips": strips})
        audio, birds = [0.0] * 24, [set() for _ in range(24)]
        species = thresholds.load(path.parent.parent / "thresholds.json")
        for s in strips:
            audio[int(s["start"][11:13])] += (s["seconds"] - sum(b - a for a, b in s.get("gaps", []))) / 60
            for d in s["detections"]:
                if thresholds.confident(species, d.get("scientific_name"), d["confidence"]) and d["at"][:10] == date:
                    birds[int(d["at"][11:13])].add(d["at"][14:16])
        end = max(datetime.strptime(s["start"], "%Y-%m-%dT%H:%M:%SZ") + timedelta(seconds=s["seconds"]) for s in strips)
        listed.append({"date": date, "start": strips[0]["start"], "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "strips": len(strips), "audio": [round(a, 1) for a in audio], "birds": [len(b) for b in birds]})
    else:
        path.unlink(missing_ok=True)
    write_json(index, sorted(listed, key=lambda d: d["date"]))


def prune_days(live: Path, cutoff: str) -> None:
    """Delete strips (spectrogram and both MP3s) that started before cutoff, and their days."""
    try:
        listed = json.loads((live / "days.json").read_text())
    except (FileNotFoundError, ValueError):
        return
    for day in listed:
        if day["start"] >= cutoff:
            break  # sorted by date: the rest are newer
        path = live / "days" / f"{day['date']}.json"
        strips = read_strips(path)
        for s in strips:
            if s["start"] < cutoff:
                for key in ("image", "audio", "clean"):
                    if s.get(key):
                        (live / s[key]).unlink(missing_ok=True)
        write_day(path, [s for s in strips if s["start"] >= cutoff])


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
            audio.with_suffix(".json").unlink(missing_ok=True)
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
                audio.with_suffix(".json").unlink(missing_ok=True)
                del attempts[audio.name]
            continue
        attempts.pop(audio.name, None)
        log.info("%s: %d new detections", audio.name, n)
        audio.with_suffix(".json").unlink(missing_ok=True)
        if args.keep_days <= 0:  # the clips are all we keep
            audio.unlink(missing_ok=True)
            continue
        move(audio, processed)
        try:
            os.utime(processed / audio.name)  # keep-days counts from processing, not from recording
        except FileNotFoundError:
            pass
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
    p.add_argument("--engine", choices=["lite", "analyzer"], default="lite", help="lite: BirdNET's model on the TFLite runtime; analyzer: birdnet-analyzer (needs TensorFlow)")
    p.add_argument("--threads", type=int, default=2, help="threads for BirdNET (leave a core free on a Pi)")
    p.add_argument("--keep-days", type=float, default=0, help="keep recordings in processed/ this many days (default: delete right after analysis)")
    p.add_argument("--interval", type=float, default=30, help="seconds between checks when watching")
    p.add_argument("--live-hours", type=float, default=168, help="keep this many hours of strips (spectrogram and audio) in live/ (0 = off)")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    lock = single_instance(args.data)
    shutil.rmtree(args.data / "live-pending", ignore_errors=True)  # left by a stop mid-job
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
        if _live_worker:
            _live_worker.shutdown(wait=True)
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
