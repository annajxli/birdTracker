"""Build a species x week occurrence table for the station location.

Uses BirdNET's location ("meta") model, the same one BirdNET-Analyzer uses to
filter species by lat/lon/week. Output: data/occurrence.csv with one row per
species and columns w1..w48 (BirdNET splits the year into 48 "weeks", 4 per month).

Usage: python pipeline/occurrence.py [--lat 47.61 --lon -122.33]
"""

import argparse
from pathlib import Path

import pandas as pd

from birdnet_analyzer import config as cfg
from birdnet_analyzer import model, utils

ROOT = Path(__file__).resolve().parent.parent


def build(lat: float, lon: float, threshold: float) -> pd.DataFrame:
    utils.ensure_model_exists()
    cfg.LABELS = utils.read_lines(cfg.BIRDNET_LABELS_FILE)

    weeks = {f"w{w}": model.predict_filter(lat, lon, w) for w in range(1, 49)}
    df = pd.DataFrame(weeks)
    df.insert(0, "label", cfg.LABELS)
    df[["scientific_name", "common_name"]] = df.pop("label").str.split("_", n=1, expand=True)

    week_cols = [f"w{w}" for w in range(1, 49)]
    df = df[df[week_cols].max(axis=1) >= threshold]
    df = df[["scientific_name", "common_name", *week_cols]]
    df[week_cols] = df[week_cols].round(4)
    return df.sort_values("w20", ascending=False).reset_index(drop=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--lat", type=float, default=47.61)
    p.add_argument("--lon", type=float, default=-122.33)
    p.add_argument("--threshold", type=float, default=0.03, help="drop species never above this score")
    p.add_argument("--out", type=Path, default=ROOT / "data" / "occurrence.csv")
    args = p.parse_args()

    df = build(args.lat, args.lon, args.threshold)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out, index=False)
    print(f"{len(df)} species -> {args.out}")
