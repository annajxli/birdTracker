"""Evaluate BirdNET's human-vocal detector offline, without playing audio.

Inputs are local station MP3s (not .clean.mp3), bird OGG or FLAC clips and local AIFF
speech. Nothing uploads, connects to the Pi, downloads models or plays sound.
Run --help for corpus, synthesis, inventory and report options. Candidate masking
here is evaluation-only; this module does not enable a production filter.
Exit status is 0 only when a threshold qualifies, or 2 when none is selected.
"""
import argparse
import csv
from datetime import UTC, datetime, timedelta
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

THRESHOLDS = (0.05, 0.1, 0.15, 0.2, 0.3, 0.5)
RATIOS = (10, 0, -10, -20)
RATE = 48000
WINDOW = 3.0
PAD = 1.0
FADE = 0.02
FRAME = 0.1
MIN_BACKGROUND_SECONDS = 86400
MIN_SPEECH_SECONDS = 300
LIVE_MIN_CONF = 0.6
VOICE_NAMES = ("Samantha", "Daniel", "Fred")
TEXT = (
    "We are testing an outdoor audio recorder beside a quiet garden. "
    "Please keep the original recording on the local computer. "
    "The purpose of this passage is to measure whether ordinary conversation "
    "can be detected among birds, wind, distant traffic, and other background sounds. "
    "This is generated test speech and contains no personal conversation. "
    "A listener may speak softly, pause, ask a question, or continue at a steady pace. "
    "The system should preserve the bird calls while reducing exposure of human voices. "
    "We will compare several recording levels and report what the experiment actually shows. "
)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_audio(path):
    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    if rate != RATE:
        divisor = math.gcd(rate, RATE)
        samples = resample_poly(samples, RATE // divisor, rate // divisor).astype(np.float32)
    return samples


def timestamp(path):
    match = re.search(r"(\d{8}T\d{6}Z)", path.stem)
    if match:
        return datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", path.parent.name):
        tail = path.stem.rsplit("_", 1)[-1]
        if re.fullmatch(r"\d{6}", tail):
            return datetime.strptime(path.parent.name + tail, "%Y-%m-%d%H%M%S").replace(tzinfo=UTC)
    return None


def candidate_spans(voice, duration, threshold, carry_in=False):
    """Apply the proposed padding/merge policy to candidate voice scores."""
    if any(not math.isfinite(start) or start < 0 or not math.isfinite(score) or not 0 <= score <= 1 for start, score in voice):
        raise ValueError("invalid voice window")
    spans = [[max(0.0, start - PAD), min(duration, start + WINDOW + PAD)]
             for start, score in voice if score >= threshold]
    if carry_in:
        spans.append([0.0, min(PAD, duration)])
    merged = []
    for start, end in sorted(spans):
        if end <= start:
            continue
        if merged and start - merged[-1][1] < 2 * PAD:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return [[round(start, 2), round(end, 2)] for start, end in merged]


def mask_audio(samples, spans):
    """Silence core spans with raised-cosine edge ramps, for comparison files."""
    out = samples.copy()
    for start, end in spans:
        a, b = max(0, int(start * RATE)), min(len(out), int(end * RATE))
        width = b - a
        if width <= 0:
            continue
        ramp = min(round(FADE * RATE), width // 2)
        out[a:b] = 0
        if ramp:
            envelope = (1 + np.cos(np.linspace(0, np.pi, ramp))) / 2
            out[a:a + ramp] = samples[a:a + ramp] * envelope
            out[b - ramp:b] = samples[b - ramp:b] * envelope[::-1]
    return out


def active_frames(samples):
    size = round(FRAME * RATE)
    rms = np.array([np.sqrt(np.mean(chunk.astype(np.float64) ** 2))
                    for i in range(0, len(samples), size) if len(chunk := samples[i:i + size])])
    if not len(rms) or rms.max() == 0:
        return np.zeros(len(rms), dtype=bool)
    return rms >= rms.max() * 10 ** (-30 / 20)


def frame_recall(active, spans, duration):
    """Active-frame time muted, allowing fractional frames at span edges."""
    covered = total = 0.0
    for index in np.flatnonzero(active):
        start, end = index * FRAME, min((index + 1) * FRAME, duration)
        total += end - start
        covered += sum(max(0.0, min(end, b) - max(start, a)) for a, b in spans)
    return covered, total


def mix_speech(background, speech, active, ratio):
    """Set the speech/background RMS ratio over the speech's active frames."""
    speech = speech[:len(background)]
    activity = np.repeat(active, round(FRAME * RATE))[:len(speech)]
    if not activity.any():
        raise ValueError("speech has no active frames")
    s_rms = np.sqrt(np.mean(speech[activity].astype(np.float64) ** 2))
    b_rms = np.sqrt(np.mean(background[:len(speech)][activity].astype(np.float64) ** 2))
    if b_rms == 0:
        raise ValueError("background is silent over active speech; RMS ratio undefined")
    gain = b_rms * 10 ** (ratio / 20) / s_rms
    voice = np.zeros_like(background)
    voice[:len(speech)] = speech * gain
    mixture = background + voice
    scale = max(1.0, float(np.max(np.abs(mixture))) / 0.99)
    return mixture / scale, gain, scale


def inventory(folder, suffixes, background=False):
    files = []
    if not folder.exists():
        return files
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in suffixes or (background and path.name.endswith(".clean.mp3")):
            continue
        info = sf.info(path)
        files.append({"path": str(path.resolve()), "seconds": info.duration,
                      "sample_rate": info.samplerate, "sha256": sha256(path),
                      "timestamp": timestamp(path).isoformat() if timestamp(path) else None})
    return files


def coverage_seconds(files):
    spans = []
    for item in files:
        if item["timestamp"]:
            start = datetime.fromisoformat(item["timestamp"]).timestamp()
            spans.append((start, start + item["seconds"]))
    end = None
    seconds = 0.0
    for a, b in sorted(spans):
        seconds += max(0, b - max(a, end)) if end is not None else b - a
        end = max(end, b) if end is not None else b
    return seconds


def generate_speech(folder):
    """Use installed macOS voices only; say always writes a file, never speakers."""
    folder.mkdir(parents=True, exist_ok=True)
    available = subprocess.run(["say", "-v", "?"], check=True, capture_output=True, text=True).stdout
    generated = []
    for voice in VOICE_NAMES:
        if not any(line.startswith(voice + " ") for line in available.splitlines()):
            raise ValueError(f"Installed voice {voice!r} is unavailable; no voice is downloaded")
        path = folder / f"{voice}.aiff"
        subprocess.run(["say", "-v", voice, "-r", "140", "-o", str(path), TEXT * 3], check=True)
        generated.append({"voice": voice, "path": str(path.resolve()), "sha256": sha256(path)})
    (folder / "synthesis.json").write_text(json.dumps(generated, indent=2) + "\n")


def prepare_librispeech(source, folder, seconds=30.0, gap=0.3):
    """Join each LibriSpeech speaker's first utterances into one FLAC of about `seconds`.

    `source` is an extracted LibriSpeech folder (SPEAKER/CHAPTER/*.flac), such as Mini
    LibriSpeech's dev-clean-2, downloaded only with the user's permission. The identities go
    in synthesis.json, like the macOS voices, so eligibility counts distinct speakers."""
    folder.mkdir(parents=True, exist_ok=True)
    prepared = []
    for speaker in sorted((d for d in source.iterdir() if d.is_dir()), key=lambda d: int(d.name) if d.name.isdigit() else d.name):
        parts, total, rate = [], 0.0, None
        for flac in sorted(speaker.rglob("*.flac")):
            audio, rate_here = sf.read(flac, dtype="float32")
            if rate is not None and rate_here != rate:
                continue
            rate = rate_here
            parts += [audio, np.zeros(round(gap * rate), np.float32)]
            total += len(audio) / rate + gap
            if total >= seconds:
                break
        if not parts:
            continue
        path = folder / f"librispeech-{speaker.name}.flac"
        sf.write(path, np.concatenate(parts), rate, format="FLAC")
        prepared.append({"voice": f"LibriSpeech speaker {speaker.name}", "path": str(path.resolve()), "sha256": sha256(path)})
    if not prepared:
        raise ValueError(f"No LibriSpeech speakers found in {source}")
    (folder / "synthesis.json").write_text(json.dumps(prepared, indent=2) + "\n")


class Detector:
    def __init__(self, out, lat, lon, threads):
        from birdnet_lite import BirdNET, MODEL, META_MODEL, LABELS, models_dir
        self.net = BirdNET(threads=threads)
        self.lat, self.lon = lat, lon
        self.cache = out / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.models = {name: sha256(models_dir() / name) for name in (MODEL, META_MODEL, LABELS)}

    def score(self, path, instant=None):
        instant = instant or timestamp(path)
        if instant is None:
            raise ValueError(f"Missing recording timestamp: {path}")
        local = instant.astimezone(ZoneInfo("America/Los_Angeles"))
        week = (local.month - 1) * 4 + min(3, (local.day - 1) // 7) + 1
        identity = {"audio": sha256(path), "models": self.models, "lat": self.lat, "lon": self.lon, "week": week, "wrapper": sha256(Path(__file__).with_name("birdnet_lite.py")), "format": 1}
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        cache = self.cache / f"{key}.json"
        if cache.exists():
            return json.loads(cache.read_text())
        with tempfile.TemporaryDirectory() as directory:
            output = self.net.analyze(path, Path(directory), self.lat, self.lon, week, 0.0)
            with output.with_name(path.stem + ".BirdNET.activity.csv").open() as stream:
                activity = list(csv.DictReader(stream))
            if not activity or "Voice" not in activity[0]:
                raise ValueError("Per-window Voice scores are absent; use this branch's BirdNET wrapper")
            with output.open() as stream:
                confident = [float(row["Start (s)"]) for row in csv.DictReader(stream) if float(row["Confidence"]) >= LIVE_MIN_CONF]
        result = {"identity": identity, "voice": [[float(row["Start (s)"]), float(row["Voice"])] for row in activity],
                  "confident": confident}
        cache.write_text(json.dumps(result) + "\n")
        return result


def intersects(start, end, spans):
    return any(a < end and b > start for a, b in spans)


def long_enough(background, count, seconds):
    """The next background minute, from the count-th on, at least `seconds` long.

    Minutes cut short by a reconnect or a power loss can't hold a full speech segment."""
    for step in range(len(background)):
        item = background[(count + step) % len(background)]
        if item["seconds"] >= seconds:
            return item
    raise ValueError("No background minute is as long as the speech segment")


def evaluate(args, inputs):
    detector = Detector(args.out, args.lat, args.lon, args.threads)
    totals = {t: {"muted_seconds": 0.0, "confident_muted": 0, "confident": 0,
                  "bird_clips_flagged": 0, "recall": {str(r): [0.0, 0.0] for r in RATIOS}} for t in THRESHOLDS}
    until = {t: None for t in THRESHOLDS}
    comparisons = []
    csv_path = args.out / "muted-spans.csv"
    with csv_path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["file", "threshold", "start_s", "end_s", "utc_start", "max_voice_score"])
        for index, item in enumerate(inputs["background"]):
            path = Path(item["path"])
            print(f"Background {index + 1}/{len(inputs['background'])}: {path.name}", flush=True)
            score = detector.score(path)
            instant = datetime.fromisoformat(item["timestamp"])
            candidate_by_threshold = {}
            for threshold in THRESHOLDS:
                previous = until[threshold]
                carry = previous is not None and abs((instant - previous).total_seconds()) <= 1
                spans = candidate_spans(score["voice"], item["seconds"], threshold, carry)
                candidate_by_threshold[threshold] = spans
                until[threshold] = instant + timedelta(seconds=item["seconds"]) if spans and spans[-1][1] >= item["seconds"] else None
                tally = totals[threshold]
                tally["muted_seconds"] += sum(b - a for a, b in spans)
                tally["confident"] += len(score["confident"])
                tally["confident_muted"] += sum(intersects(s, s + WINDOW, spans) for s in score["confident"])
                for a, b in spans:
                    maximum = max((v for s, v in score["voice"] if intersects(s, s + WINDOW, [[a, b]])), default=0)
                    writer.writerow([path, threshold, a, b, (instant + timedelta(seconds=a)).isoformat(), maximum])
            if candidate_by_threshold[.15] and not any(c[0] == "background" for c in comparisons):
                comparisons.append(("background", path, candidate_by_threshold))
        for index, item in enumerate(inputs["birds"]):
            path = Path(item["path"])
            print(f"Bird clip {index + 1}/{len(inputs['birds'])}: {path.name}", flush=True)
            score = detector.score(path)
            for threshold in THRESHOLDS:
                totals[threshold]["bird_clips_flagged"] += any(v >= threshold for _, v in score["voice"])
        # Stream one mixture at a time. Never hold a day of decoded audio in RAM.
        count = 0
        for speech_item in inputs["speech"]:
            utterance = read_audio(Path(speech_item["path"]))
            utterance_active = active_frames(utterance)
            size = 58 * RATE
            for offset in range(0, len(utterance), size):
                speech = utterance[offset:offset + size]
                active = utterance_active[offset // round(FRAME * RATE):(offset + len(speech) + round(FRAME * RATE) - 1) // round(FRAME * RATE)]
                if not active.any():
                    continue
                background_item = long_enough(inputs["background"], count, len(speech) / RATE)
                background = read_audio(Path(background_item["path"]))
                if len(background) < len(speech):
                    raise ValueError("Selected background minute is shorter than the speech segment")
                for ratio in RATIOS:
                    mixture, gain, scale = mix_speech(background, speech, active, ratio)
                    with tempfile.TemporaryDirectory(dir=args.out) as directory:
                        path = Path(directory) / "mixture.wav"
                        sf.write(path, mixture, RATE, subtype="FLOAT")
                        score = detector.score(path, datetime.fromisoformat(background_item["timestamp"]))
                        for threshold in THRESHOLDS:
                            spans = candidate_spans(score["voice"], len(mixture) / RATE, threshold)
                            covered, total = frame_recall(active, spans, len(speech) / RATE)
                            tally = totals[threshold]["recall"][str(ratio)]
                            tally[0] += covered
                            tally[1] += total
                        if ratio in (0, -10) and sum(c[0] == f"speech{ratio}" for c in comparisons) < 2:
                            saved = args.out / "compare" / f"mixture-{count}-{ratio}.wav"
                            saved.parent.mkdir(exist_ok=True)
                            sf.write(saved, mixture, RATE, subtype="FLOAT")
                            comparisons.append((f"speech{ratio}", saved, score["voice"]))
                    print(f"Speech mixture {count + 1}, ratio {ratio:+d} dB", flush=True)
                count += 1
    table = []
    seconds = sum(item["seconds"] for item in inputs["background"])
    for threshold, tally in totals.items():
        recalls = {key: a / b if b else None for key, (a, b) in tally.pop("recall").items()}
        table.append({"threshold": threshold, **tally, "speech_recall": recalls,
                      "audio_fraction_muted": tally["muted_seconds"] / seconds,
                      "confident_fraction_muted": tally["confident_muted"] / tally["confident"] if tally["confident"] else None,
                      "bird_clip_fraction_flagged": tally["bird_clips_flagged"] / len(inputs["birds"])})
    complete = eligibility(inputs)
    passing = [row for row in table if not complete and row["audio_fraction_muted"] <= .005
               and row["confident_fraction_muted"] is not None and row["confident_fraction_muted"] <= .01
               and row["bird_clip_fraction_flagged"] <= .01
               and all(row["speech_recall"][str(r)] is not None and row["speech_recall"][str(r)] >= .95 for r in (0, 10))]
    chosen = passing[0]["threshold"] if passing else None
    # Comparison files are candidates for listening, never playback commands.
    comparison_threshold = chosen if chosen is not None else .15
    for index, (kind, path, data) in enumerate(comparisons[:5]):
        samples = read_audio(path)
        spans = data[comparison_threshold] if kind == "background" else candidate_spans(data, len(samples) / RATE, comparison_threshold)
        folder = args.out / "compare"
        folder.mkdir(exist_ok=True)
        for suffix, audio in (("before", samples), ("after", mask_audio(samples, spans))):
            sf.write(folder / f"{index + 1}-{kind}-{suffix}.mp3", audio, RATE, format="MP3")
    return {"models": detector.models, "thresholds": table, "selected_threshold": chosen,
            "comparison_threshold": comparison_threshold,
            "limitations": complete + ["Background candidates may contain genuine voices; CSV needs human review.",
                                        "MP3 and OGG source reruns differ from original raw station input.",
                                        "The speech set covers only its own voices; it doesn't validate every voice, singing or shouting.",
                                        "Pi process overhead remains to be measured on the home network."]}


def eligibility(inputs):
    missing = []
    if coverage_seconds(inputs["background"]) < MIN_BACKGROUND_SECONDS:
        missing.append("Fewer than 24 hours of unique timestamped real station background")
    if any(not item["timestamp"] for item in inputs["background"]):
        missing.append("Background files without recording timestamps")
    if not inputs["birds"]:
        missing.append("No station bird clips")
    if sum(item["seconds"] for item in inputs["speech"]) < MIN_SPEECH_SECONDS:
        missing.append("Fewer than five minutes of speech")
    if len({item.get("voice") for item in inputs["speech"] if item.get("voice")}) < 3:
        missing.append("Fewer than three verified voice identities in synthesis.json")
    return missing


def report(path, inputs, result):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = [f"## Evaluation {datetime.now(UTC).astimezone(ZoneInfo('America/Los_Angeles')).isoformat(timespec='seconds')}", "",
            "### Inputs", "", f"- Real background files: {len(inputs['background'])}; unique timestamped coverage: {coverage_seconds(inputs['background']) / 3600:.3f} hours.",
            f"- Bird clips: {len(inputs['birds'])}.", f"- Speech files: {len(inputs['speech'])}; duration: {sum(x['seconds'] for x in inputs['speech']):.1f} seconds.",
            "- Exact local input paths and SHA-256 hashes are in the ignored evaluation manifest.", "", "### Threshold results", ""]
    if result.get("thresholds"):
        text += ["| Threshold | Speech +10 dB | Speech 0 dB | Speech −10 dB | Speech −20 dB | Audio muted | Confident detections touched | Bird clips flagged |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        def percent(value):
            return f"{value:.2%}" if value is not None else "N/A"
        for row in result["thresholds"]:
            values = [row['threshold'], *(percent(row['speech_recall'][str(r)]) for r in RATIOS), percent(row['audio_fraction_muted']), percent(row['confident_fraction_muted']), percent(row['bird_clip_fraction_flagged'])]
            text.append("| " + " | ".join(map(str, values)) + " |")
    else:
        text.append("No inference evaluation has run. No candidate threshold has passed or failed the targets.")
    text += ["", "Voice identities: " + ", ".join(sorted({x.get("voice", "unverified") for x in inputs["speech"]})) + "."]
    if len(inputs["background"]) <= 10:
        text += ["", "Background input names: " + ", ".join(Path(x["path"]).name for x in inputs["background"]) + "."]
    text += ["", f"Selected threshold: {result.get('selected_threshold') if result.get('selected_threshold') is not None else 'none'}.", "", "### Limitations", ""]
    text += ["- " + item for item in result.get("limitations", [])]
    text += ["", "No audio was played. No production muting or deployment is enabled by this evaluation.", ""]
    # Evaluation records are append-only: retain previous inputs and outcomes.
    with path.open("a") as stream:
        if path.stat().st_size == 0:
            stream.write("# Voice-filter evaluation results\n\n")
        else:
            stream.write("\n---\n\n")
        stream.write("\n".join(text))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--background", type=Path, required=True, help="local station live MP3 directory; .clean.mp3 excluded")
    parser.add_argument("--birds", type=Path, required=True, help="local station clips directory (.ogg, or .flac at sample rates Opus lacks)")
    parser.add_argument("--speech", type=Path, required=True, help="local speech directory: generated AIFF, or FLAC from --librispeech")
    parser.add_argument("--out", type=Path, default=Path("data/privacy-eval"))
    parser.add_argument("--report", type=Path, default=Path("docs/plans/privacy-filter-results.md"))
    parser.add_argument("--generate-speech", action="store_true", help="generate files with three installed macOS voices; never play")
    parser.add_argument("--librispeech", type=Path, help="extracted LibriSpeech folder to prepare real speech from; never downloads")
    parser.add_argument("--inventory-only", action="store_true", help="write coverage/report without loading a model")
    parser.add_argument("--allow-incomplete", action="store_true", help="run a diagnostic subset, never qualify its threshold")
    parser.add_argument("--lat", type=float, default=47.61)
    parser.add_argument("--lon", type=float, default=-122.33)
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    if args.generate_speech:
        generate_speech(args.speech)
    if args.librispeech:
        prepare_librispeech(args.librispeech, args.speech)
    inputs = {"background": inventory(args.background, {".mp3"}, True), "birds": inventory(args.birds, {".ogg", ".flac"}),
              "speech": inventory(args.speech, {".aiff", ".aif", ".flac"})}
    synthesis = args.speech / "synthesis.json"
    if synthesis.exists():
        identities = {Path(item["path"]).name: item for item in json.loads(synthesis.read_text())}
        for item in inputs["speech"]:
            identity = identities.get(Path(item["path"]).name, {})
            if identity.get("sha256") == item["sha256"]:
                item["voice"] = identity.get("voice")
    (args.out / "inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    missing = eligibility(inputs)
    result = {"thresholds": [], "selected_threshold": None, "limitations": missing}
    (args.out / "run.json").write_text(json.dumps({
        "started_at": datetime.now(UTC).isoformat(), "thresholds": THRESHOLDS,
        "ratios_db": RATIOS, "pad_seconds": PAD, "fade_seconds": FADE,
        "sample_rate": RATE, "active_frame_seconds": FRAME,
        "lat": args.lat, "lon": args.lon, "threads": args.threads,
        "python": sys.version,
    }, indent=2) + "\n")
    # Clear the machine-readable result before loading models or running a long corpus.
    (args.out / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    if args.inventory_only:
        if importlib.util.find_spec("ai_edge_litert") is None:
            result["limitations"].append("LiteRT is unavailable in this environment; the full run needs the runtime and BirdNET model files.")
        result["limitations"].append("Inventory-only run; BirdNET was not loaded and no recall or false-mute rates were measured.")
    if not args.inventory_only:
        if not inputs["background"] or not inputs["birds"] or not inputs["speech"] or (missing and not args.allow_incomplete):
            result["limitations"].append("Evaluation stopped before inference because required inputs are missing.")
        else:
            try:
                result = evaluate(args, inputs)
            except (OSError, ValueError, ImportError) as error:
                result["limitations"].append(f"Evaluation stopped: {type(error).__name__}: {error}")
    (args.out / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    report(args.report, inputs, result)
    print(json.dumps(result, indent=2), flush=True)
    return 0 if result.get("selected_threshold") is not None else 2


if __name__ == "__main__":
    raise SystemExit(main())
