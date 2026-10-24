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
