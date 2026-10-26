"""Export recorder telemetry (one row per uploaded recording) as Parquet for Hardware analytics.

Local date and hour (Pacific time) are computed here, as for detections. delay_s is the time
from the end of a recording to its detections being stored; board_temp and board_uptime are
the recorder's own health (null where it didn't report them). packet_success is the share of
audio frames the recorder recorded that it got onto wifi (the rest it dropped because its buffer
filled while wifi was slow; TCP itself loses nothing); frames_sent and frames_dropped are the
counts behind it, for pooling over a span.

power_mw and tx_mw are estimates, not measurements (the PPK2 will measure them): the recorder's
draw from its 5 V supply, and the part of it spent transmitting. The model: the ESP32 at 240 MHz
with wifi kept awake draws about BASE_MA; transmitting adds TX_EXTRA_MA for the share of time
the radio is sending, which is the stream's bit rate (with TCP/IP and wifi overhead) over the
link rate wifi picks at that signal strength. Set BIRDTRACKER_DB to read a different database.
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

SUPPLY_V = 5.0  # USB power bank, through the board's regulator
BASE_MA = 100  # ESP32 at 240 MHz, wifi connected with modem sleep off, mic included
TX_EXTRA_MA = 140  # the radio transmitting rather than listening
STREAM_KBPS = 32000 * 16 / 1000 * (1 + 12 / 1024)  # 16-bit samples at 32 kHz, plus frame headers
OVERHEAD = 1.6  # TCP/IP headers, wifi framing, acknowledgements and retries
LINK_MBPS = [(-60, 39.0), (-67, 26.0), (-72, 13.0), (-78, 6.5)]  # signal (dBm) -> typical 802.11n rate; weaker: 2


def link_mbps(rssi):
    return next((rate for floor, rate in LINK_MBPS if rssi >= floor), 2.0)


COLUMNS = ["started_at", "seconds", "rms_dbfs", "rssi_dbm", "upload_s", "analyzed_at", "source", "board_temp_c",
           "board_uptime_s", "frames_sent", "frames_dropped"]
with sqlite3.connect(DB) as conn:
    try:
        df = pd.read_sql("SELECT * FROM recordings", conn)
    except (pd.errors.DatabaseError, sqlite3.OperationalError):  # an older database without the table
        df = pd.DataFrame()
df = df.reindex(columns=COLUMNS)  # an older table lacks the newer columns: they come out null

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
    "board_temp": df.board_temp_c.astype("float32"),
    "board_uptime": df.board_uptime_s.astype("float32"),
}).sort_values("time")
out["frames_sent"] = df.frames_sent.astype("float32")  # float: null before the board reported them
out["frames_dropped"] = df.frames_dropped.astype("float32")
frames = df.frames_sent + df.frames_dropped
out["packet_success"] = (df.frames_sent / frames.where(frames > 0)).astype("float32")
real = df.source.ne("simulated") & df.rssi_dbm.notna()
airtime = (STREAM_KBPS / 1000 * OVERHEAD / df.rssi_dbm.map(lambda r: link_mbps(r) if pd.notna(r) else None).astype(float)
           * df.seconds / 60).clip(upper=1)
out["tx_mw"] = (SUPPLY_V * TX_EXTRA_MA * airtime).where(real).astype("float32")
out["power_mw"] = (SUPPLY_V * BASE_MA + out.tx_mw).where(real).astype("float32")

table = pa.Table.from_pandas(out, preserve_index=False)
buf = pa.BufferOutputStream()
pq.write_table(table, buf, compression="zstd", use_dictionary=["date"])
sys.stdout.buffer.write(buf.getvalue().to_pybytes())
