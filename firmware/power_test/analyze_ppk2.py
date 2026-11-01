#!/usr/bin/env python3
"""Split a PPK2 capture on the marker codes from power_states.ino, and summarize each state.

Input is a CSV from Power Profiler or ppk2-api, with a time column in ms or s, a current column in
uA, and digital columns D0, D1, and D2 for the REC, UP, and third marker pins. Output is one CSV row
per marked stretch: group, code, state, start and length, mean current, charge, and energy.

Sleep states are shown as code, low, code, so a low stretch between two matching sleep codes is
reported as the sleep itself.
"""

import argparse
import csv
import sys

STATES = {
    1: {1: "S1"},
    2: {1: "S3", 2: "S9"},
    3: {1: "S4", 2: "S5", 3: "S6", 4: "S7", 5: "S8 N=1", 6: "S8 N=5", 7: "S2"},
}
SLEEP_CODES = {(1, 1), (3, 7)}


def column(fields, *names):
    """The first field whose lowercased name contains one of names."""
    for name in names:
        for field in fields:
            if name in field.lower():
                return field
    raise SystemExit(f"no column like {names} in {fields}")


def read_samples(path):
    """Yield (seconds, microamps, code) for each row."""
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        time_field = column(reader.fieldnames, "timestamp", "time")
        current_field = column(reader.fieldnames, "current")
        pins = [column(reader.fieldnames, name) for name in ("d0", "d1", "d2")]
        scale = 1.0 if "(s)" in time_field.lower() else 1e-3
        for row in reader:
            code = sum(int(float(row[pin])) << bit for bit, pin in enumerate(pins))
            yield float(row[time_field]) * scale, float(row[current_field]), code


def segments(samples):
    """Merge samples into stretches of one code: dicts with start, end, code, and mean_ua."""
    current = None
    for t, ua, code in samples:
        if current and current["code"] != code:
            current["mean_ua"] = current.pop("sum_ua") / current.pop("n")
            current["end"] = t
            yield current
            current = None
        if current is None:
            current = {"start": t, "end": t, "code": code, "sum_ua": 0.0, "n": 0}
        current["sum_ua"] += ua
        current["n"] += 1
        current["end"] = t
    if current:
        current["mean_ua"] = current.pop("sum_ua") / current.pop("n")
        yield current


def summarize(segs, group, volts):
    """Rows for the coded states, and for each sleep's low stretch."""
    rows = []
    for k, seg in enumerate(segs):
        code = seg["code"]
        name = None
        if code and (group, code) not in SLEEP_CODES:
            name = STATES[group].get(code)
        elif code == 0 and 0 < k < len(segs) - 1:
            before, after = segs[k - 1]["code"], segs[k + 1]["code"]
            if before == after and (group, before) in SLEEP_CODES:
                code = before
                name = STATES[group][before]
        if not name:
            continue
        seconds = seg["end"] - seg["start"]
        coulombs = seg["mean_ua"] * 1e-6 * seconds
        rows.append({
            "group": group,
            "code": code,
            "state": name,
            "start_s": round(seg["start"], 3),
            "seconds": round(seconds, 3),
            "mean_ua": round(seg["mean_ua"], 2),
            "mean_mw": round(seg["mean_ua"] * 1e-3 * volts, 3),
            "energy_mj": round(coulombs * volts * 1e3, 3),
        })
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("capture", help="the capture's CSV")
    p.add_argument("--group", type=int, required=True, choices=STATES, help="the capture's group")
    p.add_argument("--volts", type=float, default=3.7, help="the PPK2's output voltage")
    args = p.parse_args()
    rows = summarize(list(segments(read_samples(args.capture))), args.group, args.volts)
    if not rows:
        raise SystemExit("no marked states found")
    w = csv.DictWriter(sys.stdout, fieldnames=rows[0].keys())
    w.writeheader()
    w.writerows(rows)


if __name__ == "__main__":
    main()
