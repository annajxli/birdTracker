"""Check the indoor computer's operating system for updates, without installing any.

Runs as root from a weekly systemd timer (deploy/pi/birdtracker-updates.timer):
refreshes apt's package lists, simulates a full upgrade, and writes what it
would install to data/updates.json, with when the weekly install
(deploy/pi/birdtracker-upgrade.timer) runs next. pipeline/publish.py adds that file to
live/status.json for the Hardware analytics page. Uses only the standard
library, so it runs on the system Python, outside the project's environment.

Usage:
  sudo python3 -I pipeline/updates.py --out data/updates.json
"""

import argparse
import json
import os
import platform
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

# A simulated install line: "Inst NAME [OLD] (NEW SOURCE [ARCH])", without [OLD] for a new package.
INST = re.compile(r"^Inst (\S+)(?: \[([^\]]*)\])? \((\S+) ([^\[)]*)")


def parse(simulation: str) -> list[dict]:
    out = []
    for line in simulation.splitlines():
        if (m := INST.match(line)):
            name, old, new, source = m.groups()
            out.append({"name": name, "from": old, "to": new, "security": "security" in source.lower()})
    return out


def os_name() -> str | None:
    try:
        fields = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
        return fields.get("PRETTY_NAME", "").strip('"') or None
    except OSError:
        return None


def next_install() -> str | None:
    """When the install timer runs next, as UTC ISO 8601, or None if it isn't enabled."""
    try:
        out = subprocess.run(["systemctl", "list-timers", "--all", "--output=json", "birdtracker-upgrade.timer"],
                             capture_output=True, text=True, timeout=30).stdout
        timers = json.loads(out or "[]")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    usec = timers[0].get("next") if timers else None  # microseconds since the epoch
    if not usec:
        return None
    return datetime.fromtimestamp(usec / 1e6, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def check() -> dict:
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive", "LC_ALL": "C"}
    refreshed = subprocess.run(["apt-get", "update", "-qq"], env=env, capture_output=True, text=True, timeout=600)
    sim = subprocess.run(["apt-get", "-s", "-qq", "dist-upgrade"], env=env, capture_output=True, text=True, timeout=600, check=True)
    packages = parse(sim.stdout)
    return {
        "checked": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "os": os_name(),
        "kernel": platform.release(),
        "lists_refreshed": refreshed.returncode == 0,  # False: offline, so the counts may be stale
        "upgradable": len(packages),
        "security": sum(p["security"] for p in packages),
        "reboot_required": Path("/var/run/reboot-required").exists(),
        "next_install": next_install(),
        "packages": packages[:50],
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True, help="where to write the result")
    args = p.parse_args()
    part = args.out.with_suffix(".json.part")
    part.write_text(json.dumps(check()))
    part.chmod(0o644)
    os.replace(part, args.out)


if __name__ == "__main__":
    main()
