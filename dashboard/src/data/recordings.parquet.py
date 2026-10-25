"""Export recorder telemetry (one row per uploaded recording) as Parquet for Hardware analytics.

Local date and hour (Pacific time) are computed here, as for detections. delay_s is the time
from the end of a recording to its detections being stored. Set BIRDTRACKER_DB to read a
different database.
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
    try:
        df = pd.read_sql("SELECT started_at, seconds, rms_dbfs, rssi_dbm, upload_s, analyzed_at, source FROM recordings", conn)
    except (pd.errors.DatabaseError, sqlite3.OperationalError):  # an older database without the table
        df = pd.DataFrame(columns=["started_at", "seconds", "rms_dbfs", "rssi_dbm", "upload_s", "analyzed_at", "source"])

start = pd.to_datetime(df.started_at, utc=True)
local = start.dt.tz_convert(TZ)
analyzed = pd.to_datetime(df.analyzed_at, utc=True)
out = pd.DataFrame({
    "time": start.dt.tz_localize(None).astype("datetime64[ms]"),
    "date": local.dt.strftime("%Y-%m-%d"),
    "hour": local.dt.hour.astype("int8"),
    "seconds": df.seconds.astype("float32"),
    "rms": df.rms_dbfs.astype("float32"),
    "rssi": df.rssi_dbm.astype("float32"),
    "upload": df.upload_s.astype("float32"),
    "delay": ((analyzed - start).dt.total_seconds() - df.seconds).astype("float32"),
    "simulated": df.source.eq("simulated"),
}).sort_values("time")

table = pa.Table.from_pandas(out, preserve_index=False)
buf = pa.BufferOutputStream()
pq.write_table(table, buf, compression="zstd", use_dictionary=["date"])
sys.stdout.buffer.write(buf.getvalue().to_pybytes())
