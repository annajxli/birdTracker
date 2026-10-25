"""Stand in for the recorder's live stream: replay a recording to live.py in real time.

Sends the same header and 16-bit PCM that receiver.py forwards, in 20 ms chunks, then loops.

Usage: python pipeline/live_fake_stream.py data/samples/soundscape.wav [--host localhost] [--rate 32000]
"""

import argparse
import socket
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

CHUNK_S = 0.02

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio", type=Path)
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--rate", type=int, default=32000, help="the rate the recorder streams at")
    args = p.parse_args()

    data, rate = sf.read(args.audio, always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if rate != args.rate:
        data = resample_poly(data, args.rate, rate)
    pcm = (np.clip(data, -1, 1) * 32767).astype("<i2").tobytes()
    step = int(args.rate * CHUNK_S) * 2

    sock = socket.create_connection((args.host, args.port))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.sendall(f"BIRDSTREAM 1 rate={args.rate} format=s16le channels=1 station=fake\n".encode())
    print(f"streaming {args.audio.name} at {args.rate} Hz to {args.host}:{args.port}; Ctrl-C to stop")
    start = time.monotonic()
    sent = 0
    while True:
        for i in range(0, len(pcm), step):
            sock.sendall(pcm[i:i + step])
            sent += 1
            time.sleep(max(0, start + sent * CHUNK_S - time.monotonic()))  # keep to real time
