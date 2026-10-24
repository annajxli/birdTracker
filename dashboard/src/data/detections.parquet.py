"""Export detections from SQLite as Parquet for the dashboard.

Local date and hour (Pacific time) are computed here so the browser never has
to do time-zone math. Set BIRDTRACKER_DB to read a different database.
"""

import os
import sqlite3
import sys
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
DB = Path(os.environ.get("BIRDTRACKER_DB", ROOT / "data" / "detections.sqlite"))
TZ = "America/Los_Angeles"

with sqlite3.connect(DB) as conn:
    df = pd.read_sql(
        "SELECT station_id, detected_at, scientific_name, common_name, confidence, clip_path FROM detections",
        conn,
    )

utc = pd.to_datetime(df.pop("detected_at"), utc=True)
local = utc.dt.tz_convert(TZ)
out = pd.DataFrame({
    "time": utc.dt.tz_localize(None).astype("datetime64[ms]"),
    "date": local.dt.strftime("%Y-%m-%d"),
    "hour": local.dt.hour.astype("int8"),
    "species": df.common_name,
    "scientific": df.scientific_name,
    "confidence": df.confidence.astype("float32"),
    "station": df.station_id,
    "clip": df.clip_path,
}).sort_values("time")

schema = pa.schema([
    ("time", pa.timestamp("ms")),
    ("date", pa.string()),
    ("hour", pa.int8()),
    ("species", pa.string()),
    ("scientific", pa.string()),
    ("confidence", pa.float32()),
    ("station", pa.string()),
    ("clip", pa.string()),
])
table = pa.Table.from_pandas(out, schema=schema, preserve_index=False)
buf = pa.BufferOutputStream()
pq.write_table(table, buf, compression="zstd", use_dictionary=["date", "species", "scientific", "station", "clip"])
sys.stdout.buffer.write(buf.getvalue().to_pybytes())
