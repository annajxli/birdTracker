"""Publish the analyzer's output to Cloudflare R2, where the site reads it.

Runs beside analyzer.py on the indoor computer and keeps one R2 bucket in step
with the data folder:

  live/     the near-live view's spectrogram strips and live.json, every
            --interval seconds, and status.json: the indoor computer's health,
            deployed code version, and OS update check, for the Hardware
            analytics page
  clips/    detection clips and their spectrograms, every --interval seconds
  data/detections.parquet
            the detections as the dashboard reads them
            (dashboard/src/data/detections.parquet.py), every
            --detections-minutes when the database has changed, so pages are
            fresh without a rebuild
  data/recordings.parquet
            the recorder's telemetry (a row per minute of audio), the same way
  data/detections.sqlite
            a database snapshot every --snapshot-hours, for the site's build
  data/snapshots/<UTC date>.sqlite
            the day's latest snapshot, kept for SNAPSHOT_KEEP_DAYS

An empty or damaged database must not replace what the bucket holds: a snapshot
or Parquet file far smaller than the one it would replace, or a snapshot that
fails SQLite's quick check, isn't uploaded, and a mirror won't delete most of a
prefix in one go. Each logs an error instead; --allow-shrink overrides the size
and deletion checks after a real shrink. After losing the data folder,
--restore fetches it back (docs/deploy.md).

Every --pause-seconds it also copies control/pause.json, the recorder pause set
on the Hardware analytics page, to <data>/pause.json for receiver.py.

Files are mirrored: new or changed ones are uploaded, and ones the analyzer
deleted are deleted from R2 too. The sign-in Worker serves live/ and clips/ to
signed-in visitors (deploy/password-worker.js).

Settings come from the environment (setup in docs/deploy.md):

  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
                 an R2 API token with Object Read & Write on the bucket
  R2_BUCKET      default birdtracker-media
  GITHUB_TOKEN   optional: a token that may run the repo's workflows, to
                 rebuild right after each snapshot instead of on schedule

Usage:
  python pipeline/publish.py --watch --db data/recorder.sqlite
  python pipeline/publish.py --once                # one pass, snapshot included
  python pipeline/publish.py --restore --db data/recorder.sqlite  # with the analyzer and publisher stopped
"""

import argparse
import json
import logging
import mimetypes
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

import db
import thresholds
from publish_usage import Usage

ROOT = Path(__file__).resolve().parent.parent
REPO = "annajxli/birdTracker"
WORKFLOW = "pages.yml"
SNAPSHOT_KEY = "data/detections.sqlite"
EXPORTS = {name: ROOT / "dashboard" / "src" / "data" / f"{name}.parquet.py" for name in ("detections", "recordings")}
SNAPSHOTS_PREFIX = "data/snapshots/"
SNAPSHOT_KEEP_DAYS = 14
MIN_SIZE_RATIO = 0.5  # a new snapshot or Parquet file smaller than this share of the old one looks like lost data
MASS_DELETE_MIN = 20  # a mirror won't delete this many keys or more when that's over half of the prefix
PAUSE_KEY = "control/pause.json"
FULL_SYNC_SECONDS = 3600  # re-list the bucket now and then, in case something changed it behind our back

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("audio/ogg", ".ogg")

log = logging.getLogger("publish")


def bucket_client():
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(k)]
    if missing:
        sys.exit(f"set {', '.join(missing)} (see docs/deploy.md)")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(retries={"max_attempts": 3}, connect_timeout=10, read_timeout=60),
    )


class Mirror:
    """Keeps R2 keys under `prefix` equal to the files in `folder`. Remembers what it uploaded
    (key -> size, mtime), so a pass only lists the folder, not the bucket."""

    def __init__(self, s3, bucket: str, folder: Path, prefix: str, allow_mass_delete: bool = False):
        self.s3, self.bucket, self.folder, self.prefix = s3, bucket, folder, prefix
        self.allow_mass_delete = allow_mass_delete
        self.uploaded: dict[str, tuple[int, float]] = {}
        self.listed_at = None  # list the bucket on the first pass (monotonic time starts near 0 after a boot)

    def remote(self) -> dict[str, int]:
        sizes, token = {}, None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": self.prefix}
            if token:
                kw["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kw)
            sizes.update({o["Key"]: o["Size"] for o in page.get("Contents", [])})
            if not page.get("IsTruncated"):
                return sizes
            token = page["NextContinuationToken"]

    def sync(self, history: bool = True) -> tuple[int, int]:
        local = {}
        if self.folder.exists():
            for p in self.folder.rglob("*"):
                if p.is_file() and not p.name.endswith(".part"):
                    st = p.stat()
                    local[self.prefix + p.relative_to(self.folder).as_posix()] = (p, st.st_size, st.st_mtime)
        if self.listed_at is None or time.monotonic() - self.listed_at > FULL_SYNC_SECONDS:
            # What's really there; a file the same size is taken as already uploaded.
            remote = self.remote()
            self.uploaded = {k: (size, local[k][2]) for k, size in remote.items() if k in local and local[k][1] == size}
            stale = [k for k in remote if k not in local]
            known = len(remote)
            self.listed_at = time.monotonic()
        else:
            stale = [k for k in self.uploaded if k not in local]
            known = len(self.uploaded)

        if stale and not local:
            # An empty or missing folder (a fresh install, data not moved over yet) must not wipe the bucket.
            log.warning("%s: no local files; not deleting %d from the bucket", self.prefix, len(stale))
            stale = []
        if len(stale) >= MASS_DELETE_MIN and 2 * len(stale) > known and not self.allow_mass_delete:
            # The other files in a folder (status.json, a first new clip) don't make it the real data.
            log.error("%s: not deleting %d of %d keys: the data folder looks lost (--allow-shrink overrides)", self.prefix, len(stale), known)
            stale = []

        sent = 0
        # live.json last, so it never lists a strip that isn't uploaded yet.
        def order(key):
            if key == "live/live.json": return 3
            if key == "live/days.json": return 2
            if key.endswith(".json"): return 1
            return 0
        for key in sorted(local, key=order):
            # The recent live index stays fresh; only historical navigation is batched.
            if not history and (key == "live/days.json" or key.startswith("live/days/")) and key in self.uploaded:
                continue
            path, size, mtime = local[key]
            if self.uploaded.get(key) == (size, mtime):
                continue
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            try:
                self.s3.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": ctype})
            except FileNotFoundError:
                continue  # deleted while we looked
            self.uploaded[key] = (size, mtime)
            sent += 1
        for i in range(0, len(stale), 1000):
            batch = stale[i:i + 1000]
            self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True})
            for k in batch:
                self.uploaded.pop(k, None)
        return sent, len(stale)


def too_small(s3, bucket: str, key: str, size: int) -> bool:
    """Whether a new copy of `key` is so much smaller than the bucket's that it looks like lost data."""
    try:
        old = s3.head_object(Bucket=bucket, Key=key)["ContentLength"]
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise
    if size >= old * MIN_SIZE_RATIO:
        return False
    log.error("not replacing %s (%d bytes) with %d bytes: the database looks lost (--allow-shrink overrides)", key, old, size)
    return True


def keep_daily(s3, bucket: str, copy: Path) -> None:
    """Keep the snapshot as today's generation, and drop those past SNAPSHOT_KEEP_DAYS."""
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    s3.upload_file(str(copy), bucket, f"{SNAPSHOTS_PREFIX}{today}.sqlite", ExtraArgs={"ContentType": "application/vnd.sqlite3"})
    page = s3.list_objects_v2(Bucket=bucket, Prefix=SNAPSHOTS_PREFIX)
    keys = sorted(o["Key"] for o in page.get("Contents", []))
    for key in keys[:-SNAPSHOT_KEEP_DAYS]:
        s3.delete_object(Bucket=bucket, Key=key)


def snapshot(s3, bucket: str, db_path: Path, allow_shrink: bool = False) -> bool:
    """Upload a consistent copy of the database (SQLite's backup API, so writes can go on).
    Returns whether it was uploaded."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "detections.sqlite"
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(copy)
        with dst:
            src.backup(dst)
        check = dst.execute("PRAGMA quick_check").fetchone()[0]
        src.close()
        dst.close()
        if check != "ok":
            log.error("not uploading a snapshot of %s: quick check says %s", db_path.name, check)
            return False
        if not allow_shrink and too_small(s3, bucket, SNAPSHOT_KEY, copy.stat().st_size):
            return False
        s3.upload_file(str(copy), bucket, SNAPSHOT_KEY, ExtraArgs={"ContentType": "application/vnd.sqlite3"})
        keep_daily(s3, bucket, copy)
        log.info("uploaded a snapshot of %s (%.1f MB)", db_path.name, copy.stat().st_size / 1e6)
        return True


def restore(s3, bucket: str, data: Path, db_path: Path) -> None:
    """Fetch what the bucket holds into a new data folder: clips/ and live/ files that are missing
    here, and the database snapshot unless the local database already has detections."""
    for prefix, folder in (("clips/", data / "clips"), ("live/", data / "live")):
        keys = [k for k in Mirror(s3, bucket, folder, prefix).remote() if not (folder / k[len(prefix):]).exists()]
        for key in keys:
            dest = folder / key[len(prefix):]
            dest.parent.mkdir(parents=True, exist_ok=True)
            part = dest.with_name(dest.name + ".part")
            s3.download_file(bucket, key, str(part))
            os.replace(part, dest)
        log.info("%s: restored %d files", prefix, len(keys))
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        try:
            if conn.execute("SELECT 1 FROM detections LIMIT 1").fetchone():
                log.warning("%s already has detections; keeping it", db_path)
                return
        except sqlite3.OperationalError:  # no detections table: nothing to keep
            pass
        finally:
            conn.close()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    part = db_path.with_name(db_path.name + ".part")
    s3.download_file(bucket, SNAPSHOT_KEY, str(part))
    os.replace(part, db_path)
    log.info("restored %s from the snapshot", db_path)


def upload_detections(s3, bucket: str, db_path: Path, allow_shrink: bool = False) -> None:
    """Run the dashboard's exports (detections and recordings) on the database and upload the
    Parquet they write."""
    for name, export in EXPORTS.items():
        out = subprocess.run([sys.executable, str(export)], env={**os.environ, "BIRDTRACKER_DB": str(db_path)},
                             capture_output=True, check=True, timeout=300).stdout
        if not allow_shrink and too_small(s3, bucket, f"data/{name}.parquet", len(out)):
            continue
        s3.put_object(Bucket=bucket, Key=f"data/{name}.parquet", Body=out, ContentType="application/vnd.apache.parquet")
        log.info("uploaded %s.parquet (%.1f KB)", name, len(out) / 1024)


def rebuild() -> None:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return  # the scheduled build picks the snapshot up
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches",
        data=json.dumps({"ref": "main"}).encode(),
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        log.info("asked GitHub to rebuild the site (HTTP %d)", r.status)


class Health:
    """The indoor computer's health, written to live/status.json for the Hardware analytics page.
    Reads Linux's /proc and /sys (and the Pi's vcgencmd); anything missing is left out, so it
    runs, with less to say, on a laptop too."""

    EVERY = 60  # seconds between writes
    SAMPLE_EVERY = 300  # seconds between history samples
    HISTORY = 86400  # seconds of history kept

    def __init__(self, data: Path):
        self.data, self.path = data, data / "live" / "status.json"
        self.cpu = None  # last /proc/stat (busy, total), for the CPU use between writes
        # Power trouble seen since the last history sample: under-voltage or throttling flagged now
        # at any write, or a since-boot flag that turned on between writes (a dip shorter than a minute).
        self.power_seen, self.prev_flags = {"under_voltage": False, "throttled": False}, None
        self.written = self.sampled = 0.0
        try:
            self.history = json.loads(self.path.read_text()).get("history", [])
        except (OSError, ValueError):
            self.history = []

    @staticmethod
    def read(path: str) -> str | None:
        try:
            return Path(path).read_text()
        except OSError:
            return None

    def cpu_percent(self) -> float | None:
        stat = self.read("/proc/stat")
        if not stat:
            return None
        fields = [int(v) for v in stat.split("\n", 1)[0].split()[1:]]
        total, busy = sum(fields), sum(fields) - fields[3] - fields[4]  # minus idle and iowait
        prev, self.cpu = self.cpu, (busy, total)
        return round(100 * (busy - prev[0]) / max(1, total - prev[1]), 1) if prev else None

    def snapshot(self) -> dict:
        now = time.time()
        out = {"updated": datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "host": os.uname().nodename}
        if (t := self.read("/sys/class/thermal/thermal_zone0/temp")):
            out["temp_c"] = round(int(t) / 1000, 1)
        if (c := self.cpu_percent()) is not None:
            out["cpu_percent"] = c
        out["load"] = [round(v, 2) for v in os.getloadavg()]
        if (m := self.read("/proc/meminfo")):
            kb = {line.split(":")[0]: int(line.split()[1]) for line in m.splitlines() if line.split()[1:2]}
            if "MemTotal" in kb and "MemAvailable" in kb:
                out["memory_mb"] = {"total": kb["MemTotal"] // 1024, "used": (kb["MemTotal"] - kb["MemAvailable"]) // 1024}
        disk = shutil.disk_usage(self.data)
        out["disk_gb"] = {"total": round(disk.total / 1e9, 1), "free": round(disk.free / 1e9, 1)}
        if (u := self.read("/proc/uptime")):
            out["uptime_s"] = int(float(u.split()[0]))
        try:  # the Pi's power and heat warnings: under-voltage, throttled, now and since boot
            flags = int(subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=5).stdout.split("=")[1], 16)
            out["throttled"] = {"under_voltage": bool(flags & 0x1), "throttled": bool(flags & 0x4),
                                "under_voltage_since_boot": bool(flags & 0x10000), "throttled_since_boot": bool(flags & 0x40000)}
        except (OSError, IndexError, ValueError, subprocess.SubprocessError):
            pass
        # Which code is deployed (deploy/pi/push.sh) and the weekly operating system update check
        # (pipeline/updates.py), for the page to compare with main.
        for key, path in (("code", ROOT / "deployed.json"), ("updates", self.data / "updates.json")):
            try:
                out[key] = json.loads(path.read_text())
            except (OSError, ValueError):
                pass
        return out

    def maybe_write(self) -> None:
        now = time.time()
        if now - self.written < self.EVERY:
            return
        snap = self.snapshot()
        if (t := snap.get("throttled")):
            for k in self.power_seen:
                newly = self.prev_flags is not None and t[f"{k}_since_boot"] and not self.prev_flags[f"{k}_since_boot"]
                self.power_seen[k] |= t[k] or newly
            self.prev_flags = t
        if now - self.sampled >= self.SAMPLE_EVERY and "cpu_percent" in snap:
            sample = {"at": snap["updated"], **{k: snap[k] for k in ("temp_c", "cpu_percent") if k in snap}}
            if "memory_mb" in snap:
                sample["memory_mb_used"] = snap["memory_mb"]["used"]
            sample["disk_gb_free"] = snap["disk_gb"]["free"]
            if "throttled" in snap:
                sample.update(self.power_seen)
                self.power_seen = dict.fromkeys(self.power_seen, False)
            self.history.append(sample)
            cutoff = datetime.fromtimestamp(now - self.HISTORY, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.history = [h for h in self.history if h["at"] >= cutoff]
            self.sampled = now
        part = self.path.with_suffix(".json.part")  # the mirror skips .part files
        part.parent.mkdir(exist_ok=True)
        part.write_text(json.dumps({**snap, "history": self.history}))
        os.replace(part, self.path)
        self.written = now


REVIEWED_DAYS = 8  # live/reviews.json covers the Live page's week, and a day to spare


def apply_reviews(s3, bucket: str, db_path: Path, live: Path, force: bool = False) -> int:
    """Apply visitors' verdicts (reviews/<time>-<id>.json, saved by the sign-in Worker).

    Sets review and reviewed_at on those detections, oldest first so a later verdict wins, then
    deletes the files. A rejected detection stays in the database (thresholds learn from it) but
    leaves the exports. Also writes live/reviews.json, keyed "<UTC time>|<scientific name>", so the
    Live page sees the last week's verdicts on strips written before them, and live/thresholds.json
    (thresholds.py). Returns how many review files were applied."""
    keys, token = [], None
    while True:
        page = s3.list_objects_v2(Bucket=bucket, Prefix="reviews/", **({"ContinuationToken": token} if token else {}))
        keys += [o["Key"] for o in page.get("Contents", [])]
        if not page.get("IsTruncated"):
            break
        token = page["NextContinuationToken"]
    if not keys and not force:
        return 0
    with db.connect(db_path) as conn:
        conn.execute("PRAGMA busy_timeout = 30000")  # the analyzer may be writing
        for key in sorted(keys):
            try:
                r = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
                verdict = r["verdict"] if r["verdict"] in ("rejected", "confirmed") else None
                conn.executemany("UPDATE detections SET review = ?, reviewed_at = ? WHERE detected_at = ? AND scientific_name = ?",
                                 [(verdict, r["at"][:19] + "Z" if verdict else None, d["at"], d["scientific"]) for d in r["detections"]])
            except (KeyError, TypeError, ValueError, sqlite3.ProgrammingError, sqlite3.InterfaceError):
                conn.rollback()  # none of a malformed review, not the part before the bad entry
                log.warning("skipping unreadable review %s", key)
            conn.commit()
            s3.delete_object(Bucket=bucket, Key=key)
        since = datetime.fromtimestamp(time.time() - REVIEWED_DAYS * 86400, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        reviewed = {f"{at}|{sci}": verdict for at, sci, verdict in conn.execute(
            "SELECT detected_at, scientific_name, review FROM detections WHERE review IS NOT NULL AND detected_at >= ?", (since,))}
        learned = thresholds.learn_from_db(conn)
    live.mkdir(parents=True, exist_ok=True)
    part = live / "reviews.json.part"  # the mirror skips .part files
    part.write_text(json.dumps(reviewed))
    os.replace(part, live / "reviews.json")
    thresholds.write(live / "thresholds.json", learned)
    if keys:
        log.info("applied %d reviews", len(keys))
    return len(keys)


def fetch_pause(s3, bucket: str, data: Path) -> None:
    """Copy the recorder pause to <data>/pause.json for receiver.py: {"set_at": ..., "until": ...}.

    Written atomically. When R2 can't be reached the old file stays, and any pause in it still
    ends on its own.
    """
    try:
        pause = json.loads(s3.get_object(Bucket=bucket, Key=PAUSE_KEY)["Body"].read())
    except s3.exceptions.NoSuchKey:
        pause = {}
    except ValueError:
        log.warning("%s isn't JSON; keeping the last pause", PAUSE_KEY)
        return
    pause = pause if isinstance(pause, dict) else {}
    until = pause.get("until") if isinstance(pause.get("until"), str) else None
    set_at = pause.get("set_at") if until and isinstance(pause.get("set_at"), str) else None
    text = json.dumps({"set_at": set_at, "until": until})
    path = data / "pause.json"
    if path.exists() and path.read_text() == text:
        return
    part = path.with_name(path.name + ".part")
    part.write_text(text)
    os.replace(part, path)
    log.info("recorder pause: %s", f"until {until}" if until else "none")


def db_changed_since(db_path: Path, when: float) -> bool:
    return any(p.exists() and p.stat().st_mtime > when for p in (db_path, Path(str(db_path) + "-wal")))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--watch", action="store_true", help="keep publishing")
    mode.add_argument("--once", action="store_true", help="publish everything once, snapshot included, then exit")
    mode.add_argument("--restore", action="store_true", help="fetch clips, live files and the database from the bucket, then exit")
    p.add_argument("--data", type=Path, default=ROOT / "data", help="holds live/ and clips/")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    p.add_argument("--interval", type=float, default=15, help="seconds between passes over live/ and clips/")
    p.add_argument("--reviews-seconds", type=float, default=300, help="seconds between review checks (default: 5 minutes)")
    p.add_argument("--pause-seconds", type=float, default=30, help="seconds between recorder pause checks")
    p.add_argument("--history-seconds", type=float, default=300, help="seconds between historical Live index updates")
    p.add_argument("--detections-minutes", type=float, default=10, help="minutes between detections.parquet uploads")
    p.add_argument("--snapshot-hours", type=float, default=3, help="hours between database snapshots and rebuilds")
    p.add_argument("--allow-shrink", action="store_true", help="publish even if the bucket's data would shrink sharply")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("botocore").setLevel(logging.WARNING)
    if min(args.interval, args.pause_seconds, args.reviews_seconds, args.history_seconds, args.detections_minutes, args.snapshot_hours) <= 0:
        p.error("publishing intervals must be positive")
    s3 = bucket_client()
    usage = Usage(args.data / "publish-usage.json")
    usage.attach(s3)
    bucket = os.environ.get("R2_BUCKET", "birdtracker-media")
    if args.restore:
        restore(s3, bucket, args.data, args.db)
        usage.save()
        sys.exit()
    mirrors = [Mirror(s3, bucket, args.data / "live", "live/", args.allow_shrink), Mirror(s3, bucket, args.data / "clips", "clips/", args.allow_shrink)]
    last_snapshot = 0.0  # wall-clock time of the last snapshot taken
    last_detections = 0.0  # ...and of the last detections.parquet upload
    health = Health(args.data)
    first = True
    last_reviews = last_history = last_pause = None
    while True:
        try:
            health.maybe_write()
            now = time.monotonic()
            if args.once or last_pause is None or now - last_pause >= args.pause_seconds:
                last_pause = now
                try:
                    fetch_pause(s3, bucket, args.data)
                except Exception:  # keep publishing; the receiver keeps the last pause
                    if args.once:
                        raise
                    log.exception("pause check failed")
            if args.db.exists() and (args.once or last_reviews is None or now - last_reviews >= args.reviews_seconds):
                last_reviews = now
                try:
                    if apply_reviews(s3, bucket, args.db, args.data / "live", force=first):
                        last_detections = 0.0  # publish corrections on this pass
                    first = False
                except Exception:  # keep publishing; the reviews wait for the next check
                    if args.once:
                        raise
                    log.exception("review check failed")
            history = args.once or last_history is None or now - last_history >= args.history_seconds
            for m in mirrors:
                sent, deleted = m.sync(history=history)
                if sent or deleted:
                    log.info("%s: %d uploaded, %d deleted", m.prefix, sent, deleted)
            if history:
                last_history = now
            if args.db.exists() and (args.once or (time.time() - last_detections > args.detections_minutes * 60
                                                   and db_changed_since(args.db, last_detections))):
                started = time.time()
                upload_detections(s3, bucket, args.db, args.allow_shrink)
                last_detections = started
            due = time.time() - last_snapshot > args.snapshot_hours * 3600
            if args.db.exists() and (args.once or (due and db_changed_since(args.db, last_snapshot))):
                started = time.time()
                uploaded = snapshot(s3, bucket, args.db, args.allow_shrink)
                last_snapshot = started
                if uploaded:
                    rebuild()
        except Exception:  # R2 or GitHub unreachable: try again next pass
            if args.once:
                raise
            log.exception("publish pass failed; retrying in %ss", args.interval)
        finally:
            usage.save()
        if args.once:
            break
        time.sleep(args.interval)
