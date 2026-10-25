"""Live view: hear the recorder in real time, with a scrolling spectrogram and BirdNET's
identifications as they happen (like Merlin's Sound ID).

The recorder streams continuously to receiver.py, which cuts the stream into minute files for
the analyzer and also forwards it here over local TCP (port 8766), so the live view and the
record share one stream from the board:

  first line   BIRDSTREAM 1 rate=32000 format=s16le channels=1 station=backyard\\n
  then         raw little-endian 16-bit mono PCM, as it arrives, for as long as it's connected

This keeps the last few seconds of audio, draws a spectrogram column every 10 ms, and runs
BirdNET on the latest 3 seconds every STRIDE seconds (about 15 ms of work each time). Both go to
the browser as Server-Sent Events, so a call shows on screen within about half a second of
reaching the microphone. Nothing here is stored: receiver.py's minute files stay the record.

  http://<this computer>:8000/        the live page (pipeline/live.html)
  http://<this computer>:8000/events  the event stream it reads
  http://<this computer>:8000/audio   the audio itself, only while the page's Listen is on

Usage:
  python pipeline/live.py                      # take receiver.py's stream on :8766, serve on :8000
  python pipeline/live_fake_stream.py FILE     # stand in for a recorder by replaying a recording
"""

import argparse
import asyncio
import base64
import json
import logging
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent
LOCAL_TZ = ZoneInfo("America/Los_Angeles")
MAX_HZ = 12000  # spectrogram height, as for clips (spectrogram.py)
ROWS = 128
COLS_PER_SECOND = 100
WINDOW_S = 3.0  # BirdNET's input length
STRIDE_S = 0.25  # how often BirdNET looks at the latest window
BIRDNET_RATE = 48000
HOLD_S = 6.0  # a species heard again within this long updates its row instead of adding one
LISTEN_RATE = 16000  # audio sent to browsers that press Listen (birdsong mostly sits below 8 kHz)

log = logging.getLogger("live")


class Hub:
    """Fans events out to every connected browser."""

    def __init__(self):
        self.clients: set[asyncio.Queue] = set()
        self.listeners: set[asyncio.Queue] = set()  # browsers playing the audio
        self.status = {"type": "status", "connected": False}

    def send(self, event: dict, to=None):
        data = json.dumps(event, separators=(",", ":"))
        for q in list(self.clients if to is None else to):
            if q.qsize() < 200:  # a stalled browser drops events rather than growing memory
                q.put_nowait(data)


class Spectrogram:
    """Turns incoming samples into display columns (one byte per row, 0 = background)."""

    def __init__(self, rate: int):
        self.rate = rate
        self.n_fft = 1024 if rate > 24000 else 512
        self.hop = rate // COLS_PER_SECOND
        self.window = np.hanning(self.n_fft).astype(np.float32)
        freqs = np.fft.rfftfreq(self.n_fft, 1 / rate)
        edges = np.linspace(0, min(MAX_HZ, rate / 2), ROWS + 1)
        self.idx = np.clip(np.searchsorted(freqs, edges), 0, len(freqs))
        self.pending = np.zeros(0, np.float32)
        self.background = None  # each row's slowly tracked noise floor, in dB

    def push(self, samples: np.ndarray) -> list[bytes]:
        buf = np.concatenate([self.pending, samples])
        cols = []
        start = 0
        while start + self.n_fft <= len(buf):
            frame = buf[start:start + self.n_fft] * self.window
            if not frame.any():  # a dropout receiver.py filled with silence: blank, and leave the background be
                cols.append(bytes(ROWS))
                start += self.hop
                continue
            mag = np.abs(np.fft.rfft(frame))
            rows = np.array([mag[a:max(b, a + 1)].mean() for a, b in zip(self.idx[:-1], self.idx[1:])])
            db = 20 * np.log10(rows + 1e-10)
            db[1:-1] = (db[:-2] + 2 * db[1:-1] + db[2:]) / 4  # soften across frequency, as clips' 3x3 average does
            if self.background is None:
                self.background = db.copy()
            # Each row's background drifts toward the level it sits at most of the time (a little below
            # its median), slowly enough that a call doesn't raise its own floor.
            rate = np.where(db < self.background, 0.02, 0.004)
            self.background += rate * (db - self.background)
            level = np.clip((db - self.background - 9) / 18, 0, 1)
            cols.append((level[::-1] * 255).astype(np.uint8).tobytes())  # top row = MAX_HZ
            start += self.hop
        self.pending = buf[start:]
        return cols


class Identifier(threading.Thread):
    """Runs BirdNET on the latest window every STRIDE_S, off the event loop."""

    def __init__(self, hub: Hub, loop, args):
        super().__init__(daemon=True)
        self.hub, self.loop, self.args = hub, loop, args
        self.audio: deque = deque()
        self.rate = None
        self.lock = threading.Lock()
        self.heard: dict[str, float] = {}  # species -> when last reported

    def feed(self, samples: np.ndarray, rate: int):
        with self.lock:
            if rate != self.rate:
                self.audio.clear()
                self.rate = rate
            self.audio.append(samples)
            keep = int(WINDOW_S * rate)
            total = sum(len(a) for a in self.audio)
            while self.audio and total - len(self.audio[0]) >= keep:
                total -= len(self.audio.popleft())

    def run(self):
        import birdnet_analyzer.config as cfg
        import birdnet_analyzer.model as model

        cfg.MODEL_PATH = cfg.BIRDNET_MODEL_PATH
        cfg.TFLITE_THREADS = 2
        labels = Path(cfg.BIRDNET_LABELS_FILE).read_text().splitlines()
        names = [l.split("_", 1) for l in labels]  # "Scientific_Common"
        week = None
        allowed = None
        log.info("BirdNET loaded; identifying every %ss", STRIDE_S)
        while True:
            time.sleep(STRIDE_S)
            with self.lock:
                if not self.rate:
                    continue
                window = np.concatenate(list(self.audio)) if self.audio else np.zeros(0, np.float32)
                rate = self.rate
            if len(window) < WINDOW_S * rate:
                continue
            now = datetime.now(LOCAL_TZ)
            w = (now.month - 1) * 4 + min(3, (now.day - 1) // 7) + 1
            if w != week:  # the species expected here this week, as the analyzer uses
                week = w
                allowed = model.predict_filter(self.args.lat, self.args.lon, week) >= cfg.LOCATION_FILTER_THRESHOLD
            x = window[-int(WINDOW_S * rate):]
            if rate != BIRDNET_RATE:
                x = resample_poly(x, BIRDNET_RATE, rate).astype(np.float32)
            scores = model.flat_sigmoid(np.array(model.predict([x])), sensitivity=-1, bias=cfg.SIGMOID_SENSITIVITY)[0]
            scores = np.where(allowed, scores, 0)
            hits = [(float(scores[i]), i) for i in np.flatnonzero(scores >= self.args.min_conf)]
            t = time.time()
            for conf, i in sorted(hits, reverse=True)[:5]:
                sci, common = names[i]
                self.loop.call_soon_threadsafe(self.hub.send, {
                    "type": "detection", "t": t, "species": common, "scientific": sci,
                    "confidence": round(conf, 3), "new": t - self.heard.get(sci, 0) > HOLD_S,
                })
                self.heard[sci] = t


async def handle_recorder(reader, writer, hub: Hub, ident: Identifier):
    peer = writer.get_extra_info("peername")
    try:
        header = (await asyncio.wait_for(reader.readline(), 10)).decode("ascii", "replace").split()
    except (asyncio.TimeoutError, ConnectionError):
        writer.close()
        return
    fields = dict(f.split("=", 1) for f in header[2:] if "=" in f)
    if header[:2] != ["BIRDSTREAM", "1"] or fields.get("format", "s16le") != "s16le" or fields.get("channels", "1") != "1":
        log.warning("rejecting %s: header %r", peer, " ".join(header))
        writer.close()
        return
    rate = int(fields.get("rate", 32000))
    station = fields.get("station", "?")
    log.info("recorder %s connected from %s at %d Hz", station, peer, rate)
    spec = Spectrogram(rate)
    hub.status = {"type": "status", "connected": True, "station": station, "rate": rate, "rows": ROWS,
                  "maxHz": min(MAX_HZ, rate // 2), "colsPerSecond": COLS_PER_SECOND}
    hub.send(hub.status)
    leftover = b""
    try:
        while data := await reader.read(4096):
            data = leftover + data
            n = len(data) // 2 * 2
            leftover = data[n:]
            samples = np.frombuffer(data[:n], "<i2").astype(np.float32) / 32768
            ident.feed(samples, rate)
            if hub.listeners:
                pcm = resample_poly(samples, LISTEN_RATE, rate) if rate != LISTEN_RATE else samples
                pcm = (np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes()
                hub.send({"type": "audio", "rate": LISTEN_RATE, "pcm": base64.b64encode(pcm).decode()}, hub.listeners)
            cols = spec.push(samples)
            if cols:
                hub.send({"type": "spec", "t": time.time(), "cols": [c.hex() for c in cols]})
    except ConnectionError:
        pass
    finally:
        log.info("recorder %s disconnected", station)
        hub.status = {"type": "status", "connected": False}
        hub.send(hub.status)
        writer.close()


async def handle_http(reader, writer, hub: Hub, photos: bytes):
    try:
        request = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError):
        writer.close()
        return
    path = request.split(b" ", 2)[1].decode("ascii", "replace").split("?")[0]
    if path in ("/events", "/audio"):
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n")
        q: asyncio.Queue = asyncio.Queue()
        clients = hub.clients if path == "/events" else hub.listeners
        clients.add(q)
        if path == "/events":
            q.put_nowait(json.dumps(hub.status))
        try:
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), 15)
                    writer.write(f"data: {data}\n\n".encode())
                except asyncio.TimeoutError:
                    writer.write(b": keepalive\n\n")
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            clients.discard(q)
            writer.close()
        return
    if path in ("/", "/live"):
        page = (ROOT / "pipeline" / "live.html").read_text().replace("__DASHBOARD__", hub.dashboard)
        body, kind = page.encode(), "text/html; charset=utf-8"
    elif path == "/photos.json":
        body, kind = photos, "application/json"
    else:
        body, kind = b"not found", "text/plain"
    status = "404 Not Found" if body == b"not found" else "200 OK"
    writer.write(f"HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    await writer.drain()
    writer.close()


async def main(args):
    hub = Hub()
    hub.dashboard = args.dashboard.rstrip("/") + "/"
    ident = Identifier(hub, asyncio.get_running_loop(), args)
    ident.start()
    photos_file = ROOT / "data" / "species_images.json"
    photos = photos_file.read_bytes() if photos_file.exists() else b"{}"
    rec = await asyncio.start_server(lambda r, w: handle_recorder(r, w, hub, ident), args.host, args.stream_port)
    web = await asyncio.start_server(lambda r, w: handle_http(r, w, hub, photos), args.host, args.port)
    log.info("recorder stream on :%d, live page on http://localhost:%d/", args.stream_port, args.port)
    async with rec, web:
        await asyncio.gather(rec.serve_forever(), web.serve_forever())


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="0.0.0.0", help="0.0.0.0 to accept the recorder and phones on the home network")
    p.add_argument("--stream-port", type=int, default=8766)
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--lat", type=float, default=47.61)
    p.add_argument("--lon", type=float, default=-122.33)
    p.add_argument("--dashboard", default="https://birds.annajxli.com/", help="where the home button and menu go")
    p.add_argument("--min-conf", type=float, default=0.5, help="show identifications at least this confident")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main(args))
