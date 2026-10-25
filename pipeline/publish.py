"""Publish the analyzer's output to Cloudflare R2, where the site reads it.

Runs beside analyzer.py on the indoor computer and keeps one R2 bucket in step
with the data folder:

  live/     the near-live view's spectrogram strips and live.json, every
            --interval seconds (the analyzer writes one strip per minute)
  clips/    detection clips and their spectrograms, every --interval seconds
  data/detections.parquet
            the detections as the dashboard reads them (the site's own export,
            dashboard/src/data/detections.parquet.py), every --detections-minutes
            when the database has changed; pages load it when they open, so the
            Overview is that fresh without a rebuild
  data/detections.sqlite
            a snapshot of the database, every --snapshot-hours; the site's
            build (every 3 hours) downloads it for the copy built into the site

Files are mirrored: new or changed ones are uploaded, and ones the analyzer
deleted (old strips, replaced clips) are deleted from R2 too. The password
Worker serves live/ and clips/ to signed-in visitors under /api/live/ and
/api/clips/ (deploy/password-worker.js).

Settings come from the environment (setup in docs/deploy.md):

  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
                 an R2 API token with Object Read & Write on the bucket
  R2_BUCKET      default birdtracker-media
  GITHUB_TOKEN   optional: a token that may run the repo's workflows, to
                 rebuild right after each snapshot instead of on schedule

Usage:
  python pipeline/publish.py --watch --db data/recorder.sqlite
  python pipeline/publish.py --once                # one pass, snapshot included
"""

import argparse
import json
import logging
import mimetypes
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import boto3
from botocore.config import Config

import db

ROOT = Path(__file__).resolve().parent.parent
REPO = "annajxli/birdTracker"
WORKFLOW = "pages.yml"
SNAPSHOT_KEY = "data/detections.sqlite"
DETECTIONS_KEY = "data/detections.parquet"
EXPORT = ROOT / "dashboard" / "src" / "data" / "detections.parquet.py"
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

    def __init__(self, s3, bucket: str, folder: Path, prefix: str):
        self.s3, self.bucket, self.folder, self.prefix = s3, bucket, folder, prefix
        self.uploaded: dict[str, tuple[int, float]] = {}
        self.listed_at = 0.0

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

    def sync(self) -> tuple[int, int]:
        local = {}
        if self.folder.exists():
            for p in self.folder.rglob("*"):
                if p.is_file() and not p.name.endswith(".part"):
                    st = p.stat()
                    local[self.prefix + p.relative_to(self.folder).as_posix()] = (p, st.st_size, st.st_mtime)
        if time.monotonic() - self.listed_at > FULL_SYNC_SECONDS:
            # What's really there; a file the same size is taken as already uploaded.
            remote = self.remote()
            self.uploaded = {k: (size, local[k][2]) for k, size in remote.items() if k in local and local[k][1] == size}
            stale = [k for k in remote if k not in local]
            self.listed_at = time.monotonic()
        else:
            stale = [k for k in self.uploaded if k not in local]

        sent = 0
        # live.json last, so it never lists a strip that isn't uploaded yet.
        for key in sorted(local, key=lambda k: k.endswith(".json")):
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


def snapshot(s3, bucket: str, db_path: Path) -> None:
    """Upload a consistent copy of the database (SQLite's backup API, so writes can go on)."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "detections.sqlite"
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(copy)
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        s3.upload_file(str(copy), bucket, SNAPSHOT_KEY, ExtraArgs={"ContentType": "application/vnd.sqlite3"})
        log.info("uploaded a snapshot of %s (%.1f MB)", db_path.name, copy.stat().st_size / 1e6)


def upload_detections(s3, bucket: str, db_path: Path) -> None:
    """Run the dashboard's export on the database and upload the Parquet it writes."""
    out = subprocess.run([sys.executable, str(EXPORT)], env={**os.environ, "BIRDTRACKER_DB": str(db_path)},
                         capture_output=True, check=True, timeout=300).stdout
    s3.put_object(Bucket=bucket, Key=DETECTIONS_KEY, Body=out, ContentType="application/vnd.apache.parquet")
    log.info("uploaded detections.parquet (%.1f KB)", len(out) / 1024)


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


def db_changed_since(db_path: Path, when: float) -> bool:
    return any(p.exists() and p.stat().st_mtime > when for p in (db_path, Path(str(db_path) + "-wal")))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--watch", action="store_true", help="keep publishing")
    mode.add_argument("--once", action="store_true", help="publish everything once, snapshot included, then exit")
    p.add_argument("--data", type=Path, default=ROOT / "data", help="holds live/ and clips/")
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    p.add_argument("--interval", type=float, default=15, help="seconds between passes over live/ and clips/")
    p.add_argument("--detections-minutes", type=float, default=10, help="minutes between detections.parquet uploads")
    p.add_argument("--snapshot-hours", type=float, default=3, help="hours between database snapshots and rebuilds")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("botocore").setLevel(logging.WARNING)
    s3 = bucket_client()
    bucket = os.environ.get("R2_BUCKET", "birdtracker-media")
    mirrors = [Mirror(s3, bucket, args.data / "live", "live/"), Mirror(s3, bucket, args.data / "clips", "clips/")]
    last_snapshot = 0.0  # wall-clock time of the last snapshot taken
    last_detections = 0.0  # ...and of the last detections.parquet upload
    while True:
        try:
            for m in mirrors:
                sent, deleted = m.sync()
                if sent or deleted:
                    log.info("%s: %d uploaded, %d deleted", m.prefix, sent, deleted)
            if args.db.exists() and (args.once or (time.time() - last_detections > args.detections_minutes * 60
                                                   and db_changed_since(args.db, last_detections))):
                started = time.time()
                upload_detections(s3, bucket, args.db)
                last_detections = started
            due = time.time() - last_snapshot > args.snapshot_hours * 3600
            if args.db.exists() and (args.once or (due and db_changed_since(args.db, last_snapshot))):
                started = time.time()
                snapshot(s3, bucket, args.db)
                last_snapshot = started
                rebuild()
        except Exception:  # R2 or GitHub unreachable: try again next pass
            if args.once:
                raise
            log.exception("publish pass failed; retrying in %ss", args.interval)
        if args.once:
            break
        time.sleep(args.interval)
