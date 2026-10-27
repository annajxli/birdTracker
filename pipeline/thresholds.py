"""Per-species confidence thresholds, learned from people's reviews of detections.

For each species, the reviewed detections (review "confirmed" or "rejected") give one of three
outcomes:

  learned  at least MIN_REVIEWS reviews, and some confidence t where at least TARGET_PRECISION of
           the reviewed detections at t or above are confirmed, with MIN_SUPPORT of them or more:
           the threshold is the lowest such t
  blocked  at least MIN_REVIEWS reviews, and no such t: the species counts only when a person
           confirms a detection (BirdNET is wrong about it even when it's sure, such as backup
           beeps heard as a Northern Saw-whet Owl)
  default  fewer reviews: DEFAULT_THRESHOLD, the same for every species

publish.py learns them each time it applies reviews and writes live/thresholds.json, keyed by
scientific name; analyzer.py and the dashboard read that file. People review the detections they
doubt, not a random sample, so a learned threshold is an estimate.
"""

import json
import os
from datetime import UTC, datetime
from pathlib import Path

DEFAULT_THRESHOLD = 0.6  # every species without enough reviews; the dashboard's long-standing cutoff
MIN_REVIEWS = 10
TARGET_PRECISION = 0.9
MIN_SUPPORT = 5  # so that a single confirmed detection at the very top can't set a threshold


def learn(reviews) -> dict[str, dict]:
    """reviews: (scientific name, common name, confidence, "confirmed" or "rejected") tuples.
    Returns {scientific name: entry} for the learned and blocked species only."""
    by_species: dict[str, list] = {}
    names = {}
    for sci, common, confidence, verdict in reviews:
        if verdict in ("confirmed", "rejected"):
            by_species.setdefault(sci, []).append((confidence, verdict == "confirmed"))
            names[sci] = common
    out = {}
    for sci, rows in by_species.items():
        if len(rows) < MIN_REVIEWS:
            continue
        confirmed = sum(ok for _, ok in rows)
        entry = {"common_name": names[sci], "confirmed": confirmed, "rejected": len(rows) - confirmed}
        threshold = None
        for t in sorted({c for c, _ in rows}):
            above = [ok for c, ok in rows if c >= t]
            if len(above) >= MIN_SUPPORT and sum(above) >= TARGET_PRECISION * len(above):
                threshold = round(t, 3)
                break
        out[sci] = {**entry, "threshold": threshold} if threshold is not None else {**entry, "blocked": True}
    return out


def learn_from_db(conn) -> dict[str, dict]:
    return learn(conn.execute(
        "SELECT scientific_name, common_name, confidence, review FROM detections WHERE review IS NOT NULL"))


def write(path: Path, species: dict[str, dict]) -> None:
    data = {"learned": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "default": DEFAULT_THRESHOLD,
            "min_reviews": MIN_REVIEWS, "target_precision": TARGET_PRECISION, "species": species}
    part = path.with_name(path.name + ".part")  # publish.py's mirror skips .part files
    part.write_text(json.dumps(data, sort_keys=True))
    os.replace(part, path)


def load(path: Path) -> dict[str, dict]:
    """{scientific name: entry} from a thresholds file, or {} without a readable one."""
    try:
        return json.loads(path.read_text())["species"]
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        return {}


def threshold(species: dict[str, dict], scientific_name: str | None) -> float | None:
    """A species' threshold, or None when it's blocked."""
    entry = species.get(scientific_name or "")
    if entry is None:
        return DEFAULT_THRESHOLD
    return None if entry.get("blocked") else entry.get("threshold", DEFAULT_THRESHOLD)


def confident(species: dict[str, dict], scientific_name: str | None, confidence: float) -> bool:
    t = threshold(species, scientific_name)
    return t is not None and confidence >= t
