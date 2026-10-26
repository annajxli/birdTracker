"""Turn down the steady background of a recording (mic hiss, rumble) while keeping the bird calls.

Used for the Live page's Bird boost audio: analyzer.py writes each minute's live MP3 twice, as
recorded and cleaned with this. Detections always come from the recording as it is.

It works per frequency in a short-time spectrum. Each frequency's background is estimated
locally (the 20th percentile of each 0.5 s block, then the median of the 7 blocks around it), so
a passing car or a gust becomes background within a few seconds instead of being let through.
A time-frequency cell near its background is turned down by up to FLOOR_DB; one clearly above it
passes unchanged. Below LOW_HZ the margin to open is wider, so rumble that wobbles stays down
while a real low call still passes. Where BirdNET heard a bird (keep: its detection windows), the
cut is held to KEEP_CUT_DB, so a call too faint to stand out from the background, like a distant
owl, is never cleaned away. The gain is smoothed across neighbouring cells so it glides
instead of warbling, and the spectrum is turned back into sound. A minute is done in 15 s pieces
(with 3 s of context either side) so it fits next to BirdNET on the Pi's 1 GB.
"""

import numpy as np
from scipy.ndimage import maximum_filter, median_filter, uniform_filter
from scipy.signal import istft, stft

FLOOR_DB = 24.0
NPERSEG = 1024
BLOCK_SECONDS = 0.5
SPAN_BLOCKS = 7
LOW_HZ = 1000  # small owls toot around 1-1.4 kHz
MARGIN_DB = (2.0, 8.0)  # SNR where the cut starts to ease, and where it's gone
LOW_MARGIN_DB = (6.0, 14.0)  # ...below LOW_HZ
KEEP_CUT_DB = 6.0
KEEP_PAD_SECONDS = 0.5
PIECE_SECONDS = 15
CONTEXT_SECONDS = 3  # more than the background window reaches (3.5 blocks of 0.5 s)


def clean(x: np.ndarray, rate: int, keep: list[tuple[float, float]] = ()) -> np.ndarray:
    """x: mono float samples; keep: (start, end) seconds where a bird was detected. Returns the
    cleaned samples, same length, float32."""
    x = np.asarray(x, dtype=np.float32)
    piece, context = PIECE_SECONDS * rate, CONTEXT_SECONDS * rate
    if len(x) <= piece + 2 * context:
        return _clean(x, rate, keep)
    out = np.empty_like(x)
    for start in range(0, len(x), piece):
        a, b = max(0, start - context), min(len(x), start + piece + context)
        y = _clean(x[a:b], rate, [(s - a / rate, e - a / rate) for s, e in keep])
        out[start:min(len(x), start + piece)] = y[start - a:start - a + min(piece, len(x) - start)]
    return out


def _clean(x: np.ndarray, rate: int, keep=()) -> np.ndarray:
    overlap = NPERSEG * 3 // 4
    f, t, X = stft(x.astype(np.float32), rate, nperseg=NPERSEG, noverlap=overlap)
    X = X.astype(np.complex64)
    level = uniform_filter((X.real ** 2 + X.imag ** 2).astype(np.float32) + 1e-20, size=(3, 5))
    n = max(1, int(round(BLOCK_SECONDS / (t[1] - t[0])))) if len(t) > 1 else 1
    blocks = np.stack([np.percentile(level[:, i:i + n], 20, axis=1) for i in range(0, level.shape[1], n)], axis=1)
    # 2x: the 20th percentile of noise power sits about 3 dB under its mean.
    blocks = median_filter(blocks, size=(1, SPAN_BLOCKS), mode="nearest") * 2.0
    centers = np.arange(blocks.shape[1]) * n + n / 2
    frames = np.arange(level.shape[1])
    noise = np.stack([np.interp(frames, centers, row) for row in blocks]).astype(np.float32)
    snr = 10 * np.log10(level / noise)
    del level, noise
    low = (f < LOW_HZ)[:, None]
    lo = np.where(low, LOW_MARGIN_DB[0], MARGIN_DB[0]).astype(np.float32)
    hi = np.where(low, LOW_MARGIN_DB[1], MARGIN_DB[1]).astype(np.float32)
    gain_db = -FLOOR_DB * np.clip((hi - snr) / (hi - lo), 0, 1)
    del snr
    for s, e in keep:
        held = (t >= s - KEEP_PAD_SECONDS) & (t <= e + KEEP_PAD_SECONDS)
        gain_db[:, held] = np.maximum(gain_db[:, held], -KEEP_CUT_DB)
    gain_db = uniform_filter(maximum_filter(gain_db, size=(1, 3)), size=(3, 5))  # open a touch early; glide
    _, y = istft(X * (10 ** (gain_db / 20)).astype(np.float32), rate, nperseg=NPERSEG, noverlap=overlap)
    return y[: len(x)].astype(np.float32)
