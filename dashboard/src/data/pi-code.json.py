"""The indoor computer's code on main, for the Hardware analytics page to compare with what's deployed.

The recent commits on main that changed the deployed files, newest first, each
with the fingerprint of the files the Pi runs at that commit (pipeline/code_version.py),
and of all the deployed files ("files"), which is what deployments before the
fingerprint left out unrun files reported.
The Pi reports its own fingerprint in live/status.json: when it matches the
first commit, the Pi is up to date; when it matches a later one, the commits
before it are the updates it's missing; when it matches none, the Pi runs code
that isn't on main. The site builds on every push to main
(.github/workflows/pages.yml), so this follows main.
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
import code_version  # noqa: E402

COMMITS = 100  # enough to count however far behind the Pi is

log = code_version.git("log", f"-{COMMITS}", "--format=%h%x1f%cI%x1f%s", "--", *code_version.DEPLOYED)
commits = []
for line in log.splitlines():
    commit, committed, title = line.split("\x1f", 2)
    commits.append({
        "commit": commit,
        "committed_at": datetime.fromisoformat(committed).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "title": title,
        "fingerprint": code_version.fingerprint_at(commit),
        "files": code_version.fingerprint_at(commit, files=True),
    })
json.dump({"commits": commits}, sys.stdout)
