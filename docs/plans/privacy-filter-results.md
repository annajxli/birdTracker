# Voice-filter evaluation results

Evaluation date: 2026-10-26.

## Inputs

- Real background files: 2; unique timestamped coverage: 0.033 hours.
- Bird clips: 0.
- Speech files: 3; duration: 364.0 seconds.
- Exact local input paths and SHA-256 hashes are in the ignored evaluation manifest.

## Threshold results

No inference evaluation has run. No candidate threshold has passed or failed the targets.

Generated voice identities: Daniel, Fred, Samantha.

Background input names: live_20261026T203500Z.mp3, live_20261026T203600Z.mp3.

Selected threshold: none.

## Limitations

- Fewer than 24 hours of unique timestamped real station background
- No station bird clips
- LiteRT is unavailable in this environment; the full run needs the runtime and BirdNET model files.
- Inventory-only run; BirdNET was not loaded and no recall or false-mute rates were measured.

No audio was played. No production muting or deployment is enabled by this evaluation.

---

## Evaluation 2026-10-27T09:20:16-07:00

### Inputs

- Real background files: 2397; unique timestamped coverage: 39.176 hours.
- Bird clips: 239.
- Speech files: 3; duration: 340.2 seconds.
- Exact local input paths and SHA-256 hashes are in the ignored evaluation manifest.

### Threshold results

| Threshold | Speech +10 dB | Speech 0 dB | Speech −10 dB | Speech −20 dB | Audio muted | Confident detections touched | Bird clips flagged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.05 | 42.75% | 40.62% | 14.16% | 12.81% | 0.96% | 0.00% | 1.67% |
| 0.1 | 24.37% | 26.72% | 9.36% | 7.30% | 0.57% | 0.00% | 0.84% |
| 0.15 | 9.77% | 13.72% | 6.14% | 1.75% | 0.41% | 0.00% | 0.00% |
| 0.2 | 9.21% | 9.52% | 3.23% | 1.75% | 0.33% | 0.00% | 0.00% |
| 0.3 | 2.98% | 3.01% | 1.50% | 0.00% | 0.25% | 0.00% | 0.00% |
| 0.5 | 0.00% | 0.00% | 0.00% | 0.00% | 0.13% | 0.00% | 0.00% |

Generated voice identities: Daniel, Fred, Samantha.

Selected threshold: none.

### Limitations

- Background candidates may contain genuine voices; CSV needs human review.
- MP3 and OGG source reruns differ from original raw station input.
- macOS synthetic speech does not validate every voice, singing or shouting.
- Pi process overhead remains to be measured on the home network.

No audio was played. No production muting or deployment is enabled by this evaluation.

### Findings, October 27, 2026

No threshold meets the targets, so no threshold is selected. Every threshold
fails speech recall: the best, 0.05, mutes 42.75% of active speech frames at
+10 dB and 40.62% at 0 dB, against a target of 95%. At 0.15, the other targets
pass: 0.41% of audio time is muted, no confident detection is muted, and no
bird clip is flagged.

The recall failure comes from the synthetic speech, not the mixing. Scored
alone, with no background, BirdNET's `Human vocal` class gives the macOS
voices at most 0.05 (Daniel), 0.00 (Fred), and 0.21 (Samantha) in any 3-second
window. Scaling the speech from -30 to -10 dBFS RMS doesn't change those scores.

Real voices in the station audio score much higher. The highest spans in
`muted-spans.csv` are on October 25, 2026, from 2:10 to 2:16 PM and from 5:35
to 8:03 PM, while people set up the recorder. The recorder restarted at 5:34
and 7:19 PM. Their peak scores are 0.55 to 0.86. So the false-mute rate above includes genuine voices,
and synthetic speech can't measure recall.

Inputs and models for this run:

- Background: 2,397 Live MP3s from `pio`, October 25 to 27, 2026, covering
  39.2 hours.
- Bird clips: 239 FLAC clips from `pio`. The analyzer writes FLAC when Opus
  doesn't support the recording's sample rate, so this run also reads
  `.flac` clips.
- Speech: 340 seconds from the macOS voices Daniel, Fred, and Samantha.
- Model SHA-256 hashes: `BirdNET_GLOBAL_6K_V2.4_Model_FP32.tflite`
  `55f3e405...`, `BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite`
  `1226f23f...`, and `BirdNET_GLOBAL_6K_V2.4_Labels.txt` `7399780d...`. The
  full hashes are in the ignored `results.json`.

The first attempt of this run stopped before the speech mixtures, because some
background minutes are shorter than the 58-second speech segment, such as the
39-second minute before a power loss. The evaluator now skips those minutes.

To measure recall, the evaluation needs real speech: recordings of people
talking, or a public speech dataset such as LibriSpeech, which needs the user's
permission to download.
