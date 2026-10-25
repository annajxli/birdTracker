"""Render a clip's spectrogram as a small WebP image for the dashboard.

The image is a mask: sound above the background is in the alpha channel (white pixels, transparent
background), so the dashboard can tint it with the page's ink colour in light
and dark mode. Rows run from MAX_HZ at the top to 0 Hz at the bottom; columns
are time.

Usage: python pipeline/spectrogram.py clip.ogg [more clips...]   # writes clip.webp beside each
"""

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image

MAX_HZ = 12000  # birdsong sits well below this
HEIGHT = 128  # frequency rows
PX_PER_SECOND = 100
RANGE_DB = 20  # how far above each row's background a sound must rise to show fully


def spectrogram(data: np.ndarray, rate: int) -> np.ndarray:
    """dB magnitude, shape (HEIGHT, frames), 0 Hz in the last row."""
    if data.ndim > 1:
        data = data.mean(axis=1)
    n_fft = 1024 if rate > 24000 else 512
    hop = max(1, rate // PX_PER_SECOND)
    if len(data) < n_fft:
        data = np.pad(data, (0, n_fft - len(data)))
    frames = np.lib.stride_tricks.sliding_window_view(data, n_fft)[::hop]
    mag = np.abs(np.fft.rfft(frames * np.hanning(n_fft), axis=1)).T  # (bins, frames)
    freqs = np.fft.rfftfreq(n_fft, 1 / rate)
    # Average FFT bins into HEIGHT evenly spaced rows up to MAX_HZ (or Nyquist).
    edges = np.linspace(0, min(MAX_HZ, rate / 2), HEIGHT + 1)
    idx = np.clip(np.searchsorted(freqs, edges), 0, len(freqs))
    rows = np.stack([mag[a:max(b, a + 1)].mean(axis=0) for a, b in zip(idx[:-1], idx[1:])])
    return 20 * np.log10(rows[::-1] + 1e-10)


def render(clip: Path, out: Path | None = None) -> Path:
    """Write the clip's spectrogram next to it (same name, .webp); returns the image path."""
    data, rate = sf.read(clip, always_2d=False)
    db = spectrogram(data, rate)
    # Measure each frequency row against its own background (its median over time), so steady
    # low rumble from traffic or wind doesn't drown out the song above it.
    above = db - np.median(db, axis=1, keepdims=True)
    # A light 3x3 average keeps calls solid and turns single-pixel noise into a faint wash.
    p = np.pad(above, 1, mode="edge")
    above = sum(p[i:i + above.shape[0], j:j + above.shape[1]] for i in range(3) for j in range(3)) / 9
    alpha = np.clip((above - 5) / RANGE_DB, 0, 1)
    a = (alpha * 255).astype(np.uint8)
    img = Image.fromarray(np.dstack([np.full_like(a, 255)] * 3 + [a]), "RGBA")
    out = out or clip.with_suffix(".webp")
    img.save(out, "WEBP", quality=80, method=4)  # method 6 is ~80x slower for ~4% smaller files: too slow for a Pi
    return out


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print(render(Path(arg)))
