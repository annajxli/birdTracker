import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "detections.sqlite"
SCHEMA = Path(__file__).with_name("schema.sql")

COLUMNS = ("station_id", "detected_at", "scientific_name", "common_name", "confidence", "clip_path", "source_file")


def connect(path: Path = DEFAULT_DB) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA.read_text())
    # Columns added since a database was made (CREATE TABLE IF NOT EXISTS leaves an old table as is).
    added = {"recordings": (("board_temp_c", "REAL"), ("board_uptime_s", "REAL"), ("frames_sent", "INTEGER"),
                            ("frames_dropped", "INTEGER"), ("bird_windows", "INTEGER"), ("unidentified_windows", "INTEGER")),
             "detections": (("review", "TEXT"), ("reviewed_at", "TEXT"))}
    for table, columns in added.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for column, kind in columns:
            if column not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    return conn


def insert_detections(conn: sqlite3.Connection, rows, commit: bool = True) -> int:
    """Insert dicts/tuples in COLUMNS order, skipping duplicates. Returns rows inserted.
    commit=False leaves the transaction open for the caller to finish."""
    before = conn.total_changes
    conn.executemany(
        f"INSERT OR IGNORE INTO detections ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
        ([r[c] for c in COLUMNS] if isinstance(r, dict) else r for r in rows),
    )
    if commit:
        conn.commit()
    return conn.total_changes - before
