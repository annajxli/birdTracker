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
  X-RSSI: <dBm>             optional: the recorder's wifi signal when it connected
  X-AP: <BSSID>             optional: which access point it joined, logged
  <frames until the connection closes>

Each frame is a little-endian uint64 sample index, a uint32 sample count, then
that many 16-bit mono samples. A frame with index 2^64-1 is the recorder's
health instead: `count` 16-bit words of text like "temp_c=41.2 uptime_s=5321
rssi_dbm=-61 frames_sent=3750 frames_dropped=2" (sent after connecting, then once
a minute; the frame counts run since the recorder started streaming). The index counts every sample since the
recorder started streaming, including ones it had to drop, so a gap in the
indexes is a gap in the audio. The stream is cut into one WAV per UTC minute,
named by its first sample's time; short gaps are filled with silence so the
timing stays right, and a longer gap or a disconnect ends the file. The
recorder reconnects now and then, which re-anchors the index to the clock.
Next to each minute's WAV goes <name>.json, written just before the WAV appears:
the wifi signal, the board's temperature and uptime, how many audio frames it
sent and had to drop meanwhile (from its health frames), when the minute was
finished, and how much of it was silence filling gaps. analyzer.py stores it as that minute's row in the recordings table.

With --live-port, the stream is also forwarded to pipeline/live.py on
localhost: a `BIRDSTREAM 1 rate=... format=s16le channels=1 station=...` line,
then raw PCM, with the same silence filling short gaps; a long gap or a
recorder disconnect closes that connection, and the next audio reopens it.
It's best effort: when live.py isn't running or falls behind, live audio is
dropped, and the minute files never wait on it.

While the recorder is paused (<data>/pause.json, which publish.py keeps from the
Hardware analytics page's pause), audio is thrown away before anything is
written: streamed samples and uploaded files recorded inside the pause, by
their recording time, not when they arrive. The minute being written closes at the pause, so paused time is
missing audio. Health frames are still read. A pause always ends on its own.

Meant for the home network only: plain HTTP, one shared token. Run it on the
indoor computer:

  python pipeline/receiver.py --token <token>            # port 8765
  python pipeline/analyzer.py --watch                    # in another terminal
"""

import argparse
import hmac
import json
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
HEALTH_INDEX = 2**64 - 1  # a frame with this index carries the recorder's health, not audio
last_counts = {}  # recorder address -> its last (frames_sent, frames_dropped), across reconnects
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


class Pause:
    """The recorder pause in pause.json: {"set_at": ..., "until": ...} (UTC times, or null).

    Audio recorded from set_at until `until` falls in the pause; audio recorded before it was set
    (a late upload, say) doesn't. Shared by the handler threads, so it's re-read under a lock.
    """

    def __init__(self, path: Path):
        self.path, self.mtime, self.span = path, None, (0.0, 0.0)
        self.lock = threading.Lock()

    @staticmethod
    def epoch(value) -> float | None:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if isinstance(value, str) else None

    def active(self, start: float, end: float | None = None) -> bool:
        """Whether audio recorded from `start` (to `end`, epoch seconds) overlaps the pause."""
        with self.lock:
            try:
                mtime = self.path.stat().st_mtime_ns
            except FileNotFoundError:
                mtime = None
            if mtime != self.mtime:
                span = (0.0, 0.0)
                try:
                    pause = json.loads(self.path.read_text()) if mtime else {}
                    until = self.epoch(pause.get("until"))
                    if until:
                        span = (self.epoch(pause.get("set_at")) or 0.0, until)
                except (OSError, ValueError, AttributeError):
                    log.warning("can't read %s; recording", self.path)
                self.mtime, self.span = mtime, span
            set_at, until = self.span
        return start < until and (start if end is None else end) >= set_at


class MinuteFiles:
    """Writes a stream of indexed samples into one WAV per UTC minute in incoming/."""

    def __init__(self, incoming: Path, rate: int, index: int, epoch_ms: int, source: str, live: LiveFeed | None,
                 rssi: int | None = None, pause: Pause | None = None):
        self.incoming, self.rate, self.source, self.live, self.rssi, self.pause = incoming, rate, source, live, rssi, pause
        self.paused = False  # dropping samples for a pause
        self.anchor_index, self.anchor_time = index, epoch_ms / 1000
        self.wav = None  # the open file: a wave writer on <name>.part
        self.next_index = None  # index of the next sample the open file expects
        self.samples_left = 0  # samples until the open file's minute ends
        self.gap_samples = 0  # silence filled into the open file
        self.temps = []  # board temperatures reported during the open file
        self.temp = None  # ...and the latest one, for a file that gets none
        self.boot = None  # when the board booted (epoch seconds), from its uptime
        self.sent = self.dropped = None  # audio frames the board sent / dropped since the last file

    def health(self, text: str) -> None:
        """A health frame: keep its temperature, signal and boot time for the minute files."""
        fields = dict(f.split("=", 1) for f in text.split() if "=" in f)
        try:
            if "temp_c" in fields:
                self.temp = float(fields["temp_c"])
                self.temps.append(self.temp)
            if "uptime_s" in fields:
                self.boot = time.time() - float(fields["uptime_s"])
            if "rssi_dbm" in fields:
                self.rssi = int(fields["rssi_dbm"])
            if "frames_sent" in fields and "frames_dropped" in fields:
                now = int(fields["frames_sent"]), int(fields["frames_dropped"])
                was = last_counts.get(self.source, (0, 0))
                if now[0] < was[0] or now[1] < was[1]:
                    was = (0, 0)  # the board restarted streaming: its counts began again
                self.sent = (self.sent or 0) + now[0] - was[0]
                self.dropped = (self.dropped or 0) + now[1] - was[1]
                last_counts[self.source] = now
        except ValueError:
            log.warning("stream from %s: bad health frame %r", self.source, text)

    def time_of(self, index: int) -> float:
        return self.anchor_time + (index - self.anchor_index) / self.rate

    def open(self, index: int) -> None:
        start = self.time_of(index)
        self.start = start
        self.name = datetime.fromtimestamp(start, UTC).strftime("%Y%m%dT%H%M%SZ.wav")
        self.part = self.incoming / (self.name + ".part")
        self.wav = wave.open(str(self.part), "wb")
        self.wav.setnchannels(1)
        self.wav.setsampwidth(2)
        self.wav.setframerate(self.rate)
        self.next_index = index
        self.samples_left = max(1, round((60 - start % 60) * self.rate))
        self.gap_samples = 0
        self.temps = []

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
        received = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        temp = sum(self.temps) / len(self.temps) if self.temps else self.temp
        (self.incoming / (final.stem + ".json")).write_text(json.dumps({
            "rssi_dbm": self.rssi, "received_at": received, "gap_seconds": round(self.gap_samples / self.rate, 2),
            "board_temp_c": None if temp is None else round(temp, 1),
            "board_uptime_s": None if self.boot is None else round(max(0.0, self.start - self.boot)),
            "frames_sent": self.sent, "frames_dropped": self.dropped}))
        self.sent = self.dropped = None
        os.replace(self.part, final)
        gap = f", {self.gap_samples / self.rate:.2f} s of it silence filling gaps" if self.gap_samples else ""
        log.info("stream from %s: %s, %.1f s%s", self.source, self.name, seconds, gap)

    def add(self, index: int, pcm: bytes) -> None:
        """Add samples starting at `index` (16-bit little-endian mono)."""
        if self.pause and self.pause.active(self.time_of(index)):
            if not self.paused:
                log.info("stream from %s: paused; dropping audio", self.source)
                self.paused = True
                self.close()
                if self.live:
                    self.live.restart()
            return
        if self.paused:
            log.info("stream from %s: pause over; recording", self.source)
            self.paused = False
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
    pause: Pause | None = None
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
        # By when it was recorded, not when it arrived; upload files are a minute at most.
        begun = datetime.strptime(name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).timestamp()
        if self.pause and self.pause.active(begun, begun + 60):
            remaining = length  # read it so the connection stays usable, but keep none of it
            while remaining:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            log.info("%s from %s: paused; not stored", name, self.client_address[0])
            return self.reply(202, "paused; not stored")

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
        rssi, ap = self.headers.get("X-RSSI"), self.headers.get("X-AP")  # the recorder's wifi when it connected
        log.info("stream from %s started: %d Hz%s%s", source, rate, f", RSSI {rssi} dBm" if rssi else "", f" via {ap}" if ap else "")
        self.connection.settimeout(STREAM_TIMEOUT)
        live = LiveFeed(self.live_port, rate, self.station) if self.live_port else None
        try:
            dbm = int(rssi) if rssi else None
        except ValueError:
            dbm = None
        files = MinuteFiles(self.incoming, rate, index, epoch_ms, source, live, dbm, self.pause)
        received = 0
        try:
            while True:
                header = self.rfile.read(FRAME_HEADER.size)
                if len(header) < FRAME_HEADER.size:
                    break  # closed between frames (or mid-header)
                index, count = FRAME_HEADER.unpack(header)
                if index == HEALTH_INDEX and 0 < count <= 64:
                    text = self.rfile.read(2 * count)
                    if len(text) < 2 * count:
                        break
                    files.health(text.decode("ascii", "replace"))
                    continue
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
    Handler.pause = Pause(args.data / "pause.json")
    Handler.live_port = args.live_port
    Handler.station = args.station
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    log.info("receiving on port %d into %s", args.port, Handler.incoming)
    server.serve_forever()
