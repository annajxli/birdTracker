"""The sign-in page's chart: minutes of birdsong per day, with each day's weather, as plain SVG.

The password Worker (deploy/password-worker.js) shows this chart beside the password field to
visitors who aren't signed in, so it is deliberately coarse: the last --days recorded days back
to back, with no dates, no times of day, and nothing about the recorder. Days without any
detections are left out rather than shown as gaps. Weather is the daily copy from
pipeline/weather.py.

Simulated detections (pipeline/simulate.py) are left out unless --allow-simulated is given, so
a build without the recorder's data shows no chart rather than made-up numbers. Without data, no
chart is written and the page shows the password alone.

Minutes of birdsong are clock minutes with at least one detection that someone confirmed, or
that scored at least --min-confidence and no one rejected. This approximates the dashboard's count, which also applies learned
per-species thresholds.

The SVG carries no colors of its own: the sign-in page's stylesheet colors its classes for light
and dark themes. Run it after the site build, so that the file lands in the built site:

Usage: python pipeline/signin_chart.py [--out dashboard/dist/signin-chart.svg]
"""

import argparse
import sqlite3
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

import db
from simulate import SOURCE as SIMULATED

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("America/Los_Angeles")

# Layout, in SVG units. The page scales the SVG to the card's width.
W, LEFT = 552, 44
BAR_TOP, BAR_H = 6, 120
ICON_Y = BAR_TOP + BAR_H + 18
TEMP_TOP, TEMP_H = ICON_Y + 18, 76
H = TEMP_TOP + TEMP_H + 4
# The dashboard's temperature colors (TEMP_STOPS in dashboard/src/components/birds.js).
TEMP_STOPS = [(20, "#3f7fd9"), (40, "#5fa8d8"), (55, "#d9b13b"), (70, "#ec8a3a"), (85, "#e05a3a"), (100, "#c03a4a")]
CLOUD = "M-4.2 2.8h7.6a2.6 2.6 0 0 0 .3-5.2a3.4 3.4 0 0 0-6.5-.6a2.9 2.9 0 0 0-1.4 5.8z"
SUN_RAYS = "M0-5.5v1.4M0 4.1v1.4M-5.5 0h1.4M4.1 0h1.4M-3.9-3.9l1 1M2.9 2.9l1 1M-3.9 3.9l1-1M2.9-2.9l1-1"


def birdsong_days(conn: sqlite3.Connection, min_confidence: float, days: int, today: date,
                  allow_simulated: bool = False) -> list[tuple[str, int]]:
    """(Pacific date, minutes of birdsong) for the last `days` dates with detections, before today."""
    df = pd.read_sql("SELECT detected_at, confidence, review, source_file FROM detections", conn)
    if not allow_simulated:
        df = df[df["source_file"].fillna("") != SIMULATED]
    if df.empty:
        return []
    t = pd.to_datetime(df["detected_at"], utc=True).dt.tz_convert(TZ)
    df = df.assign(date=t.dt.strftime("%Y-%m-%d"), minute=t.dt.floor("min"))
    review = df["review"].fillna("")
    kept = df[(review == "confirmed") | ((df["confidence"] >= min_confidence) & (review != "rejected"))]
    # A date counts as recorded if anything was detected that day, even below the threshold.
    recorded = sorted(d for d in df["date"].unique() if d < today.isoformat())[-days:]
    per_day = kept.groupby("date")["minute"].nunique()
    return [(d, int(per_day.get(d, 0))) for d in recorded]


def weather_kind(code: float, precip: float) -> tuple[str, int]:
    """The dashboard's icon for a WMO code (weatherKind in birds.js), and rain level 1-3."""
    level = 1 if precip < 0.1 else 2 if precip < 0.3 else 3
    if code <= 1:
        return "clear", 0
    if code == 2:
        return "partly", 0
    if code in (45, 48):
        return "fog", 0
    if 51 <= code <= 57:
        return "drizzle", level
    if 61 <= code <= 67 or 80 <= code <= 82:
        return "rain", level
    if 71 <= code <= 77 or code in (85, 86):
        return "snow", level
    if code >= 95:
        return "storm", 0
    return "cloud", 0


def icon(kind: str, level: int, x: float, title: str) -> str:
    drops = [[0], [-1.6, 1.6], [-3, 0, 3]][max(level, 1) - 1]
    body = {
        "clear": f'<circle r="2.6"/><path d="{SUN_RAYS}" class="stroke"/>',
        "partly": f'<g transform="translate(-2,-2.5) scale(0.7)"><circle r="2.6"/></g><path d="{CLOUD}" transform="translate(1.5,1.5) scale(0.8)"/>',
        "cloud": f'<path d="{CLOUD}"/>',
        "fog": '<path d="M-5-2h10M-4 1h8M-5 4h10" class="stroke"/>',
        "drizzle": f'<path d="{CLOUD}" transform="translate(0,-2)"/>' + "".join(f'<circle cx="{d}" cy="4.8" r=".75"/>' for d in drops),
        "rain": f'<path d="{CLOUD}" transform="translate(0,-2)"/><path d="{"".join(f"M{d + 0.4} 3.5l-.8 2.2" for d in drops)}" class="stroke"/>',
        "snow": f'<path d="{CLOUD}" transform="translate(0,-2)"/>' + "".join(f'<circle cx="{d}" cy="4.9" r=".95"/>' for d in drops),
        "storm": f'<path d="{CLOUD}" transform="translate(0,-2)"/><path d="M.4 2.6l-1.8 2.4h1.6l-1 2.2" class="stroke"/>',
    }[kind]
    tone = "sun" if kind == "clear" else "dry" if kind in ("partly", "cloud", "fog") else "wet"
    return f'<g class="icon icon-{tone}" transform="translate({x:.1f},{ICON_Y}) scale(1.25)"><title>{title}</title>{body}</g>'


def smooth(points: list[tuple[float, float]]) -> str:
    """A path through the points with horizontal tangents, like a monotone curve between days."""
    out = []
    for i, (x, y) in enumerate(points):
        if i == 0:
            out.append(f"{x:.1f},{y:.1f}")
            continue
        x0, y0 = points[i - 1]
        m = (x - x0) / 2
        out.append(f"C{x0 + m:.1f},{y0:.1f} {x - m:.1f},{y:.1f} {x:.1f},{y:.1f}")
    return "".join(out)


def nice_max(v: float) -> int:
    """A round axis top at or above v: 50, 100, 200, 300, ..."""
    for step in (50, 100):
        if v <= step:
            return step
    return int(-(-v // 100) * 100)


def chart(days: list[tuple[str, int]], weather: dict[str, dict]) -> str:
    """The SVG for (date, minutes) pairs; weather maps a date to temp_max_f, temp_min_f, precip_in,
    weather_code. Dates appear nowhere in the output."""
    n = len(days)
    slot = (W - LEFT) / max(n, 1)
    cx = [LEFT + slot * (i + 0.5) for i in range(n)]
    top = nice_max(max((v for _, v in days), default=0) or 1)
    y = lambda v: BAR_TOP + BAR_H * (1 - v / top)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" class="signin-chart" role="img" '
             f'aria-label="Minutes of birdsong per day for the last {n} recorded days, with each day\'s weather and high and low temperature">']
    for g in (0, top // 2, top):
        parts.append(f'<line x1="{LEFT}" x2="{W}" y1="{y(g):.1f}" y2="{y(g):.1f}" class="grid"/>'
                     f'<text x="{LEFT - 5}" y="{y(g) + 4:.1f}" class="tick" text-anchor="end">{g}</text>')
    axis = lambda label, mid: f'<text class="axis" text-anchor="middle" transform="translate(9,{mid:.1f}) rotate(-90)">{label}</text>'
    parts.append(axis("Birdsong (min/day)", BAR_TOP + BAR_H / 2))

    temps = [(i, weather[d]) for i, (d, _) in enumerate(days) if d in weather]
    if temps:
        lo = min(w["temp_min_f"] for _, w in temps)
        hi = max(w["temp_max_f"] for _, w in temps)
        t_min, t_max = 10 * (lo // 10), 10 * -(-hi // 10)
        if t_max - t_min < 20:
            t_max = t_min + 20
        ty = lambda t: TEMP_TOP + TEMP_H * (1 - (t - t_min) / (t_max - t_min))
        for g in range(int(t_min) + 10, int(t_max), 10):
            parts.append(f'<line x1="{LEFT}" x2="{W}" y1="{ty(g):.1f}" y2="{ty(g):.1f}" class="grid"/>'
                         f'<text x="{LEFT - 5}" y="{ty(g) + 4:.1f}" class="tick" text-anchor="end">{g}</text>')
        parts.append(axis("High–low (°F)", TEMP_TOP + TEMP_H / 2))
        parts.append(f'<defs><linearGradient id="signin-temp" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="{ty(20):.1f}" y2="{ty(100):.1f}">'
                     + "".join(f'<stop offset="{(t - 20) / 80:.4f}" stop-color="{c}"/>' for t, c in TEMP_STOPS)
                     + "</linearGradient></defs>")
        high = [(cx[i], ty(w["temp_max_f"])) for i, w in temps]
        low = [(cx[i], ty(w["temp_min_f"])) for i, w in reversed(temps)]
        parts.append(f'<path d="M{smooth(high)}L{smooth(low)}Z" fill="url(#signin-temp)" fill-opacity="0.9"/>')

    bw = slot * 0.62
    for i, (d, v) in enumerate(days):
        x0, x1, yt, yb = cx[i] - bw / 2, cx[i] + bw / 2, y(v), y(0)
        r = min(4, bw / 2, yb - yt)
        w = weather.get(d)
        tip = f"{v} minutes of birdsong"
        if v:
            parts.append(f'<path class="bar" d="M{x0:.1f},{yb:.1f}V{yt + r:.1f}Q{x0:.1f},{yt:.1f} {x0 + r:.1f},{yt:.1f}'
                         f'H{x1 - r:.1f}Q{x1:.1f},{yt:.1f} {x1:.1f},{yt + r:.1f}V{yb:.1f}Z"><title>{tip}</title></path>')
        if w:
            kind, level = weather_kind(w["weather_code"], w["precip_in"])
            word = {"clear": "Clear", "partly": "Partly cloudy", "cloud": "Cloudy", "fog": "Fog", "drizzle": "Drizzle",
                    "rain": "Rain", "snow": "Snow", "storm": "Thunderstorm"}[kind]
            parts.append(icon(kind, level, cx[i], f"{word}, {round(w['temp_min_f'])}–{round(w['temp_max_f'])}°F"))
    parts.append("</svg>")
    return "".join(parts)


def load_weather(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    w = pd.read_csv(path).dropna()
    return {r["date"]: r for r in w.to_dict("records")}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    p.add_argument("--weather", type=Path, default=ROOT / "data" / "weather.csv")
    p.add_argument("--out", type=Path, default=ROOT / "dashboard" / "dist" / "signin-chart.svg")
    p.add_argument("--days", type=int, default=14, help="recorded days to show")
    p.add_argument("--min-confidence", type=float, default=0.6)
    p.add_argument("--allow-simulated", action="store_true", help="include simulated detections (local previews)")
    args = p.parse_args()
    days = []
    if args.db.exists():
        with sqlite3.connect(args.db) as conn:
            days = birdsong_days(conn, args.min_confidence, args.days, pd.Timestamp.now(TZ).date(), args.allow_simulated)
    if not days:
        args.out.unlink(missing_ok=True)  # no stale chart from an earlier run
        print("No recorded days; no chart written")
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(chart(days, load_weather(args.weather)), encoding="utf-8")
    print(f"Wrote {args.out} ({len(days)} days)")


if __name__ == "__main__":
    main()
