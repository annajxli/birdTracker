"""BirdNET without TensorFlow: the same model files, run with the small TFLite runtime.

birdnet-analyzer imports TensorFlow and Keras every time it starts, which a 1 GB Raspberry Pi
3B+ can't afford, though the model itself is a TFLite file. This runs that model (and the
location filter) with ai-edge-litert instead, mirroring birdnet-analyzer 2.4's defaults:
48 kHz mono, 3 s chunks with no overlap (a final chunk of at least 1 s is zero-padded), a
sigmoid on the scores, and only the species the location model expects at the station that
week (score >= 0.03). It writes the same CSV columns, so ingest.read_results reads it unchanged.

The model files ship inside the birdnet-analyzer package; on the Pi they're copied to
models/ by deploy/pi/install.sh, and BIRDNET_MODELS points at that folder.
"""

import csv
import math
import os
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

RATE = 48000
CHUNK = 3.0
MIN_CHUNK = 1.0
BATCH = 4  # chunks per inference call. The model's working memory grows with the batch: on the laptop
           # 16 peaked at 913 MB, 4 at 449 MB (and ran faster); the Pi 3B+ has 905 MB in all. Always
           # this many (the last batch is zero-padded), so the tensors are allocated only once.
LOCATION_THRESHOLD = 0.03
MODEL = "BirdNET_GLOBAL_6K_V2.4_Model_FP32.tflite"
META_MODEL = "BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite"
LABELS = "BirdNET_GLOBAL_6K_V2.4_Labels.txt"


def models_dir() -> Path:
    if os.environ.get("BIRDNET_MODELS"):
        return Path(os.environ["BIRDNET_MODELS"])
    import importlib.util  # the files inside an installed birdnet-analyzer (without importing it)
    spec = importlib.util.find_spec("birdnet_analyzer")
    if spec is None or not spec.submodule_search_locations:
        raise FileNotFoundError("set BIRDNET_MODELS to a folder with the BirdNET V2.4 model files")
    return Path(spec.submodule_search_locations[0]) / "checkpoints" / "V2.4"


class BirdNET:
    def __init__(self, threads: int = 2):
        from ai_edge_litert.interpreter import Interpreter

        d = models_dir()
        self.model = Interpreter(model_path=str(d / MODEL), num_threads=threads)
        self.model.allocate_tensors()
        self.input = self.model.get_input_details()[0]["index"]
        self.output = self.model.get_output_details()[0]["index"]
        self.meta = Interpreter(model_path=str(d / META_MODEL))
        self.meta.allocate_tensors()
        self.labels = [line.split("_", 1) for line in (d / LABELS).read_text(encoding="utf-8").splitlines()]
        self.batch = None
        self.allowed = {}  # (lat, lon, week) -> boolean mask over species

    def species_mask(self, lat: float, lon: float, week: int) -> np.ndarray:
        key = (lat, lon, week)
        if key not in self.allowed:
            m = self.meta
            m.set_tensor(m.get_input_details()[0]["index"], np.array([[lat, lon, week]], dtype=np.float32))
            m.invoke()
            self.allowed[key] = m.get_tensor(m.get_output_details()[0]["index"])[0] >= LOCATION_THRESHOLD
        return self.allowed[key]

    def scores(self, chunks: np.ndarray) -> np.ndarray:
        n = len(chunks)
        if n < BATCH:
            chunks = np.concatenate([chunks, np.zeros((BATCH - n, chunks.shape[1]), np.float32)])
        if self.batch is None:
            self.model.resize_tensor_input(self.input, [BATCH, chunks.shape[1]])
            self.model.allocate_tensors()
            self.batch = BATCH
        self.model.set_tensor(self.input, chunks)
        self.model.invoke()
        logits = self.model.get_tensor(self.output)[:n]
        return 1 / (1 + np.exp(-np.clip(logits, -20, 20)))

    def analyze(self, audio: Path, out_dir: Path, lat: float, lon: float, week: int, min_conf: float) -> Path:
        """Write <stem>.BirdNET.results.csv in out_dir (birdnet-analyzer's name and columns)."""
        sig, rate = sf.read(audio, dtype="float32", always_2d=True)
        sig = sig.mean(axis=1)
        if rate != RATE:
            g = math.gcd(RATE, rate)
            sig = resample_poly(sig, RATE // g, rate // g).astype(np.float32)
        size = int(RATE * CHUNK)
        starts = list(range(0, max(1, len(sig)), size))
        if len(starts) > 1 and len(sig) - starts[-1] < RATE * MIN_CHUNK:
            starts.pop()  # a last bit shorter than 1 s is dropped
        padded = np.concatenate([sig, np.zeros(size, np.float32)])
        chunks = np.stack([padded[s:s + size] for s in starts])
        allowed = self.species_mask(lat, lon, week)

        out = out_dir / f"{audio.stem}.BirdNET.results.csv"
        with out.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Start (s)", "End (s)", "Scientific name", "Common name", "Confidence", "File"])
            for b in range(0, len(chunks), BATCH):
                for i, row in enumerate(self.scores(chunks[b:b + BATCH])):
                    start = starts[b + i] / RATE
                    for k in np.flatnonzero((row >= min_conf) & allowed):
                        sci, common = self.labels[k]
                        w.writerow([f"{start:.1f}", f"{start + CHUNK:.1f}", sci, common, f"{row[k]:.4f}", str(audio)])
        return out
