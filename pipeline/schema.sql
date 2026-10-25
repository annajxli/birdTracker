-- One row per BirdNET detection (one 3-second audio segment x one species).
-- Plain SQLite so the same schema can move to Cloudflare D1 unchanged.
CREATE TABLE IF NOT EXISTS detections (
    id              INTEGER PRIMARY KEY,
    station_id      TEXT    NOT NULL,
    detected_at     TEXT    NOT NULL,  -- segment start, ISO 8601 UTC, e.g. 2026-05-12T13:15:03Z
    scientific_name TEXT    NOT NULL,
    common_name     TEXT    NOT NULL,
    confidence      REAL    NOT NULL,  -- BirdNET score, 0-1
    clip_path       TEXT,              -- audio clip key (e.g. in R2), when kept
    source_file     TEXT,              -- recording the detection came from
    UNIQUE (station_id, detected_at, scientific_name)
);

CREATE INDEX IF NOT EXISTS detections_time ON detections (detected_at);
CREATE INDEX IF NOT EXISTS detections_species ON detections (scientific_name, detected_at);

-- One row per recording file the recorder uploads: what was recorded, how it sounded, and
-- how it got here. Feeds the dashboard's Hardware analytics page.
CREATE TABLE IF NOT EXISTS recordings (
    id           INTEGER PRIMARY KEY,
    station_id   TEXT    NOT NULL,
    started_at   TEXT    NOT NULL,  -- recording start, ISO 8601 UTC
    seconds      REAL    NOT NULL,  -- audio length
    rms_dbfs     REAL,              -- background level: quietest 10% of 1 s windows, dBFS
    rssi_dbm     INTEGER,           -- wifi signal when uploading
    upload_s     REAL,              -- time to upload the file
    received_at  TEXT,              -- when the receiver finished writing it, ISO 8601 UTC
    analyzed_at  TEXT,              -- when its detections were stored, ISO 8601 UTC
    source       TEXT,              -- "simulated" for generated rows
    UNIQUE (station_id, started_at)
);
