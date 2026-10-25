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

A recorder can instead stream continuously, on one long connection:

  POST /stream
  X-Token: <shared token>
  X-Sample-Rate: 32000
  X-Index: <sample index>   the sample being recorded at X-Epoch-Ms
  X-Epoch-Ms: <UTC ms>
  <frames until the connection closes>

Each frame is a little-endian uint64 sample index, a uint32 sample count, then
that many 16-bit mono samples. The index counts every sample since the
recorder started streaming, including ones it had to drop, so a gap in the
indexes is a gap in the audio. The stream is cut into one WAV per UTC minute,
named by its first sample's time; short gaps are filled with silence so the
timing stays right, and a longer gap or a disconnect ends the file. The
recorder reconnects now and then, which re-anchors the index to the clock.

With --live-port, the stream is also forwarded to pipeline/live.py on
localhost: a `BIRDSTREAM 1 rate=... format=s16le channels=1 station=...` line,
then raw PCM, with the same silence filling short gaps; a long gap or a
recorder disconnect closes that connection, and the next audio reopens it.
It's best effort: when live.py isn't running or falls behind, live audio is
dropped, and the minute files never wait on it.

Meant for the home network only: plain HTTP, one shared token. Run it on the
indoor computer:

  python pipeline/receiver.py --token <token>            # port 8765
  python pipeline/analyzer.py --watch                    # in another terminal
"""

import argparse
import hmac
import logging
import os
import queue
import re
import socket
import struct
import threading
import time
import wave
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"^\d{8}T\d{6}Z\.(wav|flac|ogg|opus)$")
MAX_BYTES = 2 * 1024**3  # 2 GB: far more than a few minutes of audio
CHUNK = 64 * 1024
FRAME_HEADER = struct.Struct("<QI")  # sample index, sample count
MAX_FRAME_SAMPLES = 8192
MAX_FILL_SECONDS = 10  # gaps up to this long become silence; longer ones end the file
MIN_FILE_SECONDS = 3   # BirdNET's window: shorter leftovers aren't worth keeping
STREAM_TIMEOUT = 30    # seconds without data before a stream counts as dead

log = logging.getLogger("receiver")


class LiveFeed:
    """Forwards a stream's audio to live.py on localhost, from a thread of its own, so a slow
    or missing live.py costs live audio, never recording."""

    RETRY_SECONDS = 5
    QUEUE_ITEMS = 200  # ~3 s of 16 ms frames

    def __init__(self, port: int, rate: int, station: str):
        self.port, self.header = port, f"BIRDSTREAM 1 rate={rate} format=s16le channels=1 station={station}\n".encode()
        self.items = queue.Queue(self.QUEUE_ITEMS)
        threading.Thread(target=self.run, daemon=True).start()

    def send(self, pcm: bytes) -> None:
        self.put(pcm)

    def restart(self) -> None:
        """A long gap: close the live connection; the next audio opens a new one."""
        self.put(b"")

    def end(self) -> None:
        self.put(None, block=True)

    def put(self, item, block=False) -> None:
        try:
            self.items.put(item, block=block)  # end() waits: the thread never stalls (1 s socket timeout)
        except queue.Full:
            pass  # live.py isn't keeping up: drop

    def run(self) -> None:
        sock, last_try = None, 0.0
        while (item := self.items.get()) is not None:
            if item == b"":
                if sock:
                    sock.close()
                sock, last_try = None, 0.0  # a deliberate reopen, not a failure: no retry wait
                continue
            if not sock:
                if time.monotonic() - last_try < self.RETRY_SECONDS:
                    continue
                last_try = time.monotonic()
                try:
                    sock = socket.create_connection(("127.0.0.1", self.port), timeout=1)
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    sock.sendall(self.header)
                except OSError:
                    sock = None
                    continue
            try:
                sock.sendall(item)
            except OSError:
                sock.close()
                sock = None
        if sock:
            sock.close()


class MinuteFiles:
    """Writes a stream of indexed samples into one WAV per UTC minute in incoming/."""

    def __init__(self, incoming: Path, rate: int, index: int, epoch_ms: int, source: str, live: LiveFeed | None):
        self.incoming, self.rate, self.source, self.live = incoming, rate, source, live
        self.anchor_index, self.anchor_time = index, epoch_ms / 1000
        self.wav = None  # the open file: a wave writer on <name>.part
        self.next_index = None  # index of the next sample the open file expects
        self.samples_left = 0  # samples until the open file's minute ends
        self.gap_samples = 0  # silence filled into the open file

    def time_of(self, index: int) -> float:
        return self.anchor_time + (index - self.anchor_index) / self.rate

    def open(self, index: int) -> None:
        start = self.time_of(index)
        self.name = datetime.fromtimestamp(start, UTC).strftime("%Y%m%dT%H%M%SZ.wav")
        self.part = self.incoming / (self.name + ".part")
        self.wav = wave.open(str(self.part), "wb")
        self.wav.setnchannels(1)
        self.wav.setsampwidth(2)
        self.wav.setframerate(self.rate)
        self.next_index = index
        self.samples_left = max(1, round((60 - start % 60) * self.rate))
        self.gap_samples = 0

    def close(self) -> None:
        if not self.wav:
            return
        frames = self.wav.getnframes()
        self.wav.close()
        self.wav = None
        seconds = frames / self.rate
        if seconds < MIN_FILE_SECONDS:
            self.part.unlink(missing_ok=True)
            return
        final = self.incoming / self.name
        if final.exists():
            log.warning("stream from %s: %s already exists; dropping %.1f s", self.source, self.name, seconds)
            self.part.unlink(missing_ok=True)
            return
        os.replace(self.part, final)
        gap = f", {self.gap_samples / self.rate:.2f} s of it silence filling gaps" if self.gap_samples else ""
        log.info("stream from %s: %s, %.1f s%s", self.source, self.name, seconds, gap)

    def add(self, index: int, pcm: bytes) -> None:
        """Add samples starting at `index` (16-bit little-endian mono)."""
        if self.wav and index < self.next_index:  # overlaps what's written: keep only the new part
            skip = self.next_index - index
            pcm, index = pcm[2 * skip:], self.next_index
        if self.wav and index > self.next_index:
            gap = index - self.next_index
            if gap <= MAX_FILL_SECONDS * self.rate and gap < self.samples_left:
                log.warning("stream from %s: %.2f s gap (samples dropped on the recorder)", self.source, gap / self.rate)
                self.write(b"\0\0" * gap)
                self.gap_samples += gap
            else:
                log.warning("stream from %s: %.1f s gap; starting a new file", self.source, gap / self.rate)
                self.close()
                if self.live:
                    self.live.restart()
        while pcm:
            if not self.wav:
                self.open(index)
            n = min(len(pcm) // 2, self.samples_left)
            self.write(pcm[:2 * n])
            pcm, index = pcm[2 * n:], index + n
            if not self.samples_left:
                self.close()

    def write(self, pcm: bytes) -> None:
        self.wav.writeframesraw(pcm)
        if self.live:
            self.live.send(pcm)
        n = len(pcm) // 2
        self.next_index += n
        self.samples_left -= n


class Handler(BaseHTTPRequestHandler):
    incoming: Path
    token: str
    live_port: int = 0
    station: str = "backyard"

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
        if url.path not in ("/upload", "/stream"):
            return self.reply(404, "not found")
        if not hmac.compare_digest(self.headers.get("X-Token", ""), self.token):
            return self.reply(403, "bad token")
        if url.path == "/stream":
            return self.stream()
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


    def stream(self):
        try:
            rate = int(self.headers["X-Sample-Rate"])
            index = int(self.headers["X-Index"])
            epoch_ms = int(self.headers["X-Epoch-Ms"])
        except (KeyError, TypeError, ValueError):
            return self.reply(400, "X-Sample-Rate, X-Index and X-Epoch-Ms required")
        if not 8000 <= rate <= 96000:
            return self.reply(400, "unsupported sample rate")
        source = self.client_address[0]
        log.info("stream from %s started: %d Hz", source, rate)
        self.connection.settimeout(STREAM_TIMEOUT)
        live = LiveFeed(self.live_port, rate, self.station) if self.live_port else None
        files = MinuteFiles(self.incoming, rate, index, epoch_ms, source, live)
        received = 0
        try:
            while True:
                header = self.rfile.read(FRAME_HEADER.size)
                if len(header) < FRAME_HEADER.size:
                    break  # closed between frames (or mid-header)
                index, count = FRAME_HEADER.unpack(header)
                if not 0 < count <= MAX_FRAME_SAMPLES:
                    log.warning("stream from %s: bad frame (count %d); closing", source, count)
                    break
                pcm = self.rfile.read(2 * count)
                if len(pcm) < 2 * count:
                    break  # closed mid-frame: drop the partial frame
                files.add(index, pcm)
                received += count
        except OSError as e:  # timeout or reset
            log.warning("stream from %s: %s", source, e)
        finally:
            files.close()
            if live:
                live.end()
        log.info("stream from %s ended after %.1f s of audio", source, received / rate)
        self.close_connection = True


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--token", default=os.environ.get("RECEIVER_TOKEN"), help="shared token (or set RECEIVER_TOKEN)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--data", type=Path, default=ROOT / "data", help="recordings go to <data>/incoming/")
    p.add_argument("--live-port", type=int, default=8766, help="forward streams to live.py on this localhost port (0 = off)")
    p.add_argument("--station", default="backyard", help="station name sent to live.py")
    args = p.parse_args()
    if not args.token:
        p.error("set --token or RECEIVER_TOKEN (the same value goes in the firmware's secrets.h)")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    Handler.incoming = args.data / "incoming"
    Handler.incoming.mkdir(parents=True, exist_ok=True)
    Handler.token = args.token
    Handler.live_port = args.live_port
    Handler.station = args.station
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    log.info("receiving on port %d into %s", args.port, Handler.incoming)
    server.serve_forever()
