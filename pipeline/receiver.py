"""Receive recordings uploaded by the recorder and drop them into data/incoming/.

The recorder sends each finished file as an HTTP POST:

  POST /upload?name=20260512T131500Z.wav
  X-Token: <shared token>
  Content-Length: <bytes>
  <file bytes>

The file is written as incoming/<name>.part and renamed when complete, so
analyzer.py never sees a half-written file (it ignores names that don't end in
an audio extension). Only names that look like a UTC start time plus an audio
extension are accepted, so a request can't write anywhere else.

Meant for the home network only: plain HTTP, one shared token. Run it on the
indoor computer:

  python pipeline/receiver.py --token <token>            # port 8765
  python pipeline/analyzer.py --watch                    # in another terminal
"""

import argparse
import hmac
import logging
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"^\d{8}T\d{6}Z\.(wav|flac|ogg|opus)$")
MAX_BYTES = 2 * 1024**3  # 2 GB: far more than a few minutes of audio
CHUNK = 64 * 1024

log = logging.getLogger("receiver")


class Handler(BaseHTTPRequestHandler):
    incoming: Path
    token: str

    def log_message(self, fmt, *args):  # route http.server's access log through logging
        log.debug("%s %s", self.address_string(), fmt % args)

    def reply(self, status: int, text: str) -> None:
        body = (text + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self.reply(200, "ok")
        self.reply(404, "not found")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/upload":
            return self.reply(404, "not found")
        if not hmac.compare_digest(self.headers.get("X-Token", ""), self.token):
            return self.reply(403, "bad token")
        name = parse_qs(url.query).get("name", [""])[0]
        if not NAME.match(name):
            return self.reply(400, "name must look like 20260512T131500Z.wav")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, "Content-Length required")
        if not 0 < length <= MAX_BYTES:
            return self.reply(413, "empty or too large")
        final = self.incoming / name
        if final.exists():
            return self.reply(409, "already have it")

        part = self.incoming / (name + ".part")
        started = time.monotonic()
        remaining = length
        try:
            with open(part, "wb") as f:
                while remaining:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        raise ConnectionError(f"connection closed with {remaining} bytes to go")
                    f.write(chunk)
                    remaining -= len(chunk)
            os.replace(part, final)
        except Exception as e:
            part.unlink(missing_ok=True)
            log.warning("upload of %s failed: %s", name, e)
            return self.reply(500, "upload failed")
        seconds = time.monotonic() - started
        log.info("%s from %s: %.1f KB in %.1f s (%.0f kbit/s)", name, self.client_address[0],
                 length / 1024, seconds, length * 8 / 1000 / max(seconds, 1e-3))
        self.reply(201, f"stored {name} ({length} bytes)")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--token", default=os.environ.get("RECEIVER_TOKEN"), help="shared token (or set RECEIVER_TOKEN)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--data", type=Path, default=ROOT / "data", help="recordings go to <data>/incoming/")
    args = p.parse_args()
    if not args.token:
        p.error("set --token or RECEIVER_TOKEN (the same value goes in the firmware's secrets.h)")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Handler.incoming = args.data / "incoming"
    Handler.incoming.mkdir(parents=True, exist_ok=True)
    Handler.token = args.token
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    log.info("receiving on port %d into %s", args.port, Handler.incoming)
    server.serve_forever()
