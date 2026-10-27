"""Which version of the indoor computer's code is deployed, and whether main has moved on.

deploy/pi/push.sh runs this on the laptop and copies its output to the Pi as
deployed.json: the commit, its date, whether the working tree had changes, and
a fingerprint of the deployed files' contents. The site's build computes the
fingerprint of each recent commit on main (dashboard/src/data/pi-code.json.py),
so the Hardware analytics page can tell which of main's versions the Pi runs,
even when it was deployed from a branch whose commit was later squash-merged.

Usage:
  python pipeline/code_version.py            # print deployed.json for this checkout
"""

import hashlib
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# What push.sh copies to the Pi (BirdNET's model files aside, which don't change with the code).
DEPLOYED = ["pipeline", "deploy/pi", "dashboard/src/data/detections.parquet.py", "dashboard/src/data/recordings.parquet.py"]


def git(*args: str, root: Path = ROOT) -> str:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout


def _digest(lines: list[tuple[str, str]]) -> str:
    return hashlib.sha256("".join(f"{path} {blob}\n" for path, blob in sorted(lines)).encode()).hexdigest()[:16]


def fingerprint(root: Path = ROOT) -> str:
    """A hash of the deployed files as they are on disk (tracked files only): their paths and Git
    blob ids, so it equals fingerprint_at() of any commit with the same contents."""
    paths = [p for p in git("ls-files", "-z", "--", *DEPLOYED, root=root).split("\0") if p and (root / p).is_file()]
    blobs = subprocess.run(["git", "hash-object", "--stdin-paths"], cwd=root, input="\n".join(paths),
                           capture_output=True, text=True, check=True).stdout.split()
    return _digest(list(zip(paths, blobs)))


def fingerprint_at(commit: str, root: Path = ROOT) -> str:
    """fingerprint() of a commit's deployed files, from Git's objects without a checkout."""
    entries = (e.split("\t", 1) for e in git("ls-tree", "-r", "-z", commit, "--", *DEPLOYED, root=root).split("\0") if e)
    return _digest([(path, meta.split()[2]) for meta, path in entries])  # meta: "MODE blob ID"


def deployed(root: Path = ROOT) -> dict:
    commit, committed = git("log", "-1", "--format=%H %cI", root=root).split()
    return {
        "commit": commit[:7],
        "committed_at": datetime.fromisoformat(committed).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD", root=root).strip(),
        "changed": bool(git("status", "--porcelain", "--", *DEPLOYED, root=root).strip()),
        "fingerprint": fingerprint(root),
        "deployed_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


if __name__ == "__main__":
    json.dump(deployed(), sys.stdout)
    print()
