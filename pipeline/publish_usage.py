"""Local publisher accounting. No credentials, object keys, or telemetry are uploaded.

Counts SDK API calls (including failed calls, excluding automatic HTTP retries), not a bill.
Upload bytes are attempted request payload bytes; downloads and website traffic are not measured.
"""
import json
import threading
from datetime import UTC, datetime
from pathlib import Path


class Usage:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.dirty = False
        try:
            self.days = json.loads(path.read_text())["days"]
        except (FileNotFoundError, ValueError, KeyError):
            self.days = {}

    def attach(self, client):
        client.meta.events.register("before-call.s3", self.record)

    def record(self, model, params, **kwargs):
        body = params.get("body")
        size = 0
        if isinstance(body, (bytes, bytearray)):
            size = len(body)
        elif body is not None and hasattr(body, "seek") and hasattr(body, "tell"):
            position = body.tell()
            try:
                body.seek(0, 2)
                size = body.tell() - position
            finally:
                body.seek(position)
        day = datetime.now(UTC).date().isoformat()
        with self.lock:
            row = self.days.setdefault(day, {"operations": {}, "upload_bytes": 0})
            ops = row["operations"]
            ops[model.name] = ops.get(model.name, 0) + 1
            if model.name in ("PutObject", "UploadPart"):
                row["upload_bytes"] += size
            self.dirty = True

    def save(self):
        with self.lock:
            if not self.dirty:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            part = self.path.with_name(self.path.name + ".part")
            part.write_text(json.dumps({"days": self.days}, indent=2) + "\n")
            part.replace(self.path)
            self.dirty = False
