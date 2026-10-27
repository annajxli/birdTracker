# Voice privacy filter

This page specifies a filter that silences human voices in all audio that
leaves the indoor computer. It is a production-filter proposal; implementation
and evaluation state belong in [Status](../status.md#voice-privacy-evaluation-branch).
Follow [Implementation steps](#implementation-steps) on a separate branch,
and evaluate the filter before deployment.

## Goal

When BirdNET hears a human voice in a recording, the published audio for that
stretch is silent: the Live page's MP3s, the detection clips, and the
spectrograms drawn from them. Everything else about the recording is unchanged.

### In scope

- Speech, singing, shouting, and other vocal sounds that BirdNET labels
  `Human vocal_Human vocal`.

### Out of scope

- **Other human noise.** Footsteps, coughs, doors, tools, and other sounds that
  BirdNET labels `Human non-vocal_Human non-vocal` (shown as *People* on Live),
  and whistling (`Human whistle_Human whistle`). They pass through unchanged.
  The microphone mostly hears this kind of noise, and it isn't private in the
  way speech is.
- **The local live stream.** `pipeline/live.py` streams raw audio on the home
  network only. It must stay unreachable from outside, but this filter doesn't
  change it.
- **Frequency filtering.** A band-stop filter can't remove speech without
  removing birdsong, because speech formants (about 300 Hz to 4 kHz) overlap
  most songbirds (about 1 to 8 kHz).
- **WebRTC voice activity detection.** An earlier prototype (`719e26c` and
  `fb865dd` on the deleted `codex/privacy-and-home-server` branch, if the
  objects still exist locally) used WebRTC VAD at its least aggressive mode,
  and muted 100% of the energy of synthetic bird-like chirps, and 10% of pure
  silence. Don't use it as the detector. Its other choice, running BirdNET on
  the muted audio, also hid every bird heard under a voice. This design runs
  BirdNET on the raw audio instead.

## Privacy boundary

The boundary is R2: anything the publisher (`pipeline/publish.py`) uploads can
reach the website. The following table lists what crosses it, and what the
filter does to each:

| Published file | Contains audio? | Filter |
| --- | --- | --- |
| `live/<stem>.mp3`, `live/<stem>.clean.mp3` | Yes | Made from the muted recording |
| `live/<stem>.webp` (strip spectrogram) | A picture of it | Made from the muted recording |
| `clips/<date>/<species>_<time>.ogg` and `.webp` | Yes | Cut from the muted recording, or not cut (see [Clips](#clips)) |
| `live/live.json`, `live/days/*.json` | No | Gain a `muted` field |
| `data/detections.parquet`, `data/recordings.parquet`, `data/detections.sqlite` | No | `recordings` gains `muted_seconds` |
| `live/status.json` | No | Unchanged |

Raw audio stays on the Pi. The analyzer deletes each recording after analysis
unless `--keep-days` is set (it isn't, in
`deploy/pi/birdtracker-analyzer.service`), and the Live thread deletes its hard
link in `data/live-pending/` when it finishes. Recordings that fail analysis
move to `data/failed/` with their raw audio. The publisher never reads
`failed/`, `incoming/`, `processed/`, or `live-pending/`. Keep it that way.

## Detector

The detector is BirdNET's `Human vocal_Human vocal` score for each 3-second
window, which `pipeline/birdnet_lite.py` already computes for every window.
Today it only writes the score to `<stem>.BirdNET.sounds.csv` when it reaches
`SOUND_MIN_CONF`, which is too high for privacy.

### Changes to `birdnet_lite.py`

- Add a `Voice` column to `<stem>.BirdNET.activity.csv`: the raw
  `Human vocal_Human vocal` score for every window, formatted `%.4f`. Find the
  label's index once in `__init__`, as `self.voice`.
- Don't change `results.csv`, `sounds.csv`, or the bird veto.

### Changes to `analyzer.py`

Add three constants:

| Constant | Starting value | Meaning |
| --- | --- | --- |
| `VOICE_MUTE_CONF` | `0.15` | A window with a `Voice` score at or above this is muted. Set the final value from [Evaluation](#evaluation). |
| `VOICE_MUTE_PAD_SECONDS` | `1.0` | Silence added before and after each flagged window. |
| `VOICE_MUTE_FADE_SECONDS` | `0.02` | Raised-cosine fade at each edge of a muted span, so it doesn't click. |

#### Read the scores

Extend `read_activity` to also return the list of `(start_s, voice)` pairs. A
missing `Voice` column, from an older CSV, means no scores.

#### Compute the muted spans

Write a pure function:

```python
def muted_spans(voice: list[tuple[float, float]], duration: float,
                carry_in: bool = False) -> list[list[float]]:
```

- For each window with `voice >= VOICE_MUTE_CONF`, take
  `[start - VOICE_MUTE_PAD_SECONDS, start + SEGMENT_SECONDS + VOICE_MUTE_PAD_SECONDS]`.
- If `carry_in` is true, add `[0, VOICE_MUTE_PAD_SECONDS]`.
- Clamp to `[0, duration]`, then merge spans that overlap or are less than
  `2 * VOICE_MUTE_PAD_SECONDS` apart.
- Return spans sorted, rounded to 2 decimals, as `[[start, end], ...]`.

`carry_in` covers a voice that runs across the boundary between two minute
files. In `run_once`'s `state`, keep `state["voice_until"]`: the UTC time when
the last processed recording's last muted span ended, if that span reached the
end of the recording. Pass `carry_in=True` when the next recording starts
within one second of that time.

#### If the engine has no scores

`--engine analyzer` runs birdnet-analyzer, which doesn't write
`activity.csv`, so it has no voice scores. Fail closed: at startup, if
`--engine analyzer` is set without a new `--no-voice-filter` flag, exit with a
message that names the flag. `--no-voice-filter` disables the filter for any
engine, for development only. The Pi's service file must not set it.

## Muting

In `process`, after `run_birdnet` and before any clip is cut:

1. Compute the spans. If there are none, continue exactly as today, with the
   original file.
2. Read the recording, set every sample inside a span to zero, apply the fades
   just inside each span's edges, and write the result to
   `data/muted/<same name>` in the same format and sample rate. Write to a
   `.part` name and rename, as the rest of the analyzer does.
3. Use the muted file as the source for `cut_clip` and `queue_live`.
4. Delete the muted file after `queue_live` returns. `queue_live` makes its own
   hard link, so the Live thread still has it.

Use the original, unmuted recording for:

- BirdNET, which already ran in step 1.
- `record_telemetry`, so `rms_dbfs` still describes the real background.
- `silence_fills`, the dropout gaps. Muted spans are exact zeros too, and
  `silence_fills` would draw them as dropouts. Compute the gaps in `process`
  from the original samples and pass them to `queue_live` and `update_live`
  as a new `gaps` argument, instead of computing them from the file inside
  `update_live`.

### Clips

A clip covers `[offset - CLIP_PAD_SECONDS, offset + SEGMENT_SECONDS + CLIP_PAD_SECONDS]`.
If muted spans cover half or more of that range, don't cut the clip:

- Leave the row's `clip_path` empty.
- Don't add the previous clip to `replaced`, so the hour keeps its earlier
  clip if it has one.
- Still insert the detection row.

Otherwise, cut the clip from the muted file as usual.

### Live entry

`update_live` adds `"muted": [[start, end], ...]`, in seconds into the
recording, to the strip entry when there are spans, and omits the key when
there aren't, the same way as `gaps`. The day files copy the entry, so they get
it too.

### Telemetry

Add `muted_seconds REAL` to the `recordings` table in `pipeline/schema.sql`,
and to the `added` migration list in `db.connect`. `record_telemetry` stores
the sum of the span lengths, or 0 when the filter ran and found nothing.
`dashboard/src/data/recordings.parquet.py` exports it as `muted_seconds`. Leave
it `NULL` when the filter is off.

## Website

The Live page belongs to whoever is working on the dashboard. Hand them this
contract instead of editing `dashboard/src/live.md` yourself:

- Each strip may have `muted: [[start, end], ...]`, in seconds from the strip's
  `start`.
- Draw muted spans so they read as different from `gaps`. Gaps are dropouts
  and are hatched. Muted spans are recorded but silenced on purpose. Label them
  *Voice muted* in the tooltip.
- Detections inside a muted span still show. Their clips may be missing.

## Evaluation

Run the evaluation on the development computer, offline, before deploying. Put
inputs and outputs in an ignored folder such as `data/privacy-eval/`. Write a
script, `pipeline/privacy_eval.py`, so the run can be repeated. Write its
results to `docs/plans/privacy-filter-results.md`, with the date, the inputs,
and the threshold chosen.

**Never play audio during the evaluation.** The browser pane and the computer's
speakers are the user's. Write comparison files and let the user listen to
them.

### Inputs

- **Background:** real station minutes from the Pi's `data/live/*.mp3` (a week
  is kept). Copy them with `scp`. They're 24 kHz MP3s, so resample them to
  48 kHz for BirdNET.
- **Bird clips:** the Pi's `data/clips/**/*.ogg` and `*.flac`, one per species per hour. The analyzer writes FLAC when Opus doesn't support the recording's sample rate.
- **Speech:** generate it locally with macOS `say`, with at least three voices
  and a total of at least 5 minutes, saved as AIFF. Public speech datasets
  such as LibriSpeech need a download; ask the user before downloading
  anything.

### Tests and targets

1. **Speech recall.** Mix speech into background minutes at speech-to-background
   RMS ratios of +10, 0, -10, and -20 dB, measured over the speech's own
   active frames. A speech frame is active if its 100 ms RMS is within 30 dB of
   that utterance's peak. Report the fraction of active frames inside muted
   spans, per ratio. Target: at least 95% at 0 dB and above.
2. **False mutes on real audio.** Run the detector over at least 24 hours of
   real background minutes. Report the fraction of audio time muted, and the
   fraction of detections at or above `LIVE_MIN_CONF` whose window is muted.
   Targets: at most 0.5% of audio time, and at most 1% of those detections.
   Write every muted span, with its time and score, to a CSV for the user to
   review: some may be real voices.
3. **Bird preservation.** Run the detector over every bird clip. Target: at
   most 1% of clips have a window at or above the threshold.
4. **Speed on the Pi.** Time `process` with and without muting on a minute
   that has spans. Target: muting adds less than 2 seconds a minute.

### Choose the threshold

Run tests 1 to 3 for `VOICE_MUTE_CONF` values of 0.05, 0.1, 0.15, 0.2, 0.3, and
0.5. Choose the lowest value that meets the false-mute and bird-preservation
targets, and report its speech recall. If no value meets every target, stop and
report the table to the user instead of choosing.

### Comparison files

For the user, write 3 to 5 pairs of before and after MP3s to
`data/privacy-eval/compare/`, from test 1 at 0 dB and -10 dB, and from any real
minutes that test 2 muted.

## Unit tests

Add `pipeline/test_privacy.py`, using `unittest` and synthetic arrays, with no
BirdNET model:

- `muted_spans`: the threshold is inclusive, padding is applied, spans clamp
  to the recording, nearby spans merge, `carry_in` adds a leading span, and no
  flagged windows give `[]`.
- Muting keeps the length and sample rate, zeroes the inside of each span, and
  fades at the edges.
- Gaps come from the original samples: a muted span isn't reported as a gap,
  and a real dropout is.
- A clip half or more inside a muted span isn't cut, and doesn't replace the
  previous clip.
- The Live entry has `muted` only when there are spans.
- `--engine analyzer` without `--no-voice-filter` exits.

Run all the checks in [AGENTS.md](../../AGENTS.md#checks) before you commit.

## Implementation steps

1. Create a branch from an up-to-date `main` in its own worktree, such as
   `codex/voice-filter`, following [AGENTS.md](../../AGENTS.md).
2. Add `data/muted/` and `data/privacy-eval/` to `.gitignore`, and the `Voice`
   column to `activity.csv`.
3. Write `pipeline/privacy_eval.py`, run [Evaluation](#evaluation), and record
   the results. Stop here if no threshold meets the targets.
4. Set `VOICE_MUTE_CONF`, and implement the detector, muting, clips, Live
   entry, and telemetry changes, with unit tests.
5. Update the documentation in the same commit: describe the filter in
   `docs/architecture.md`, move the evaluation results next to it if they're
   still needed, and delete this plan.
6. Open a pull request. Hand the [Website](#website) contract to whoever is
   working on the dashboard.
7. After the merge, deploy from a session on the home network with
   `deploy/pi/push.sh`, and record it in [Status](../status.md).
8. Verify on the station with the user: they speak near the microphone for
   about 10 seconds, and you check that the next strip has a `muted` span at
   that time, its MP3s are silent there, and no clip from that span was
   published. Don't play the audio yourself: check the samples.

## Risks

- **Quiet or distant voices** may score below the threshold and pass through.
  The evaluation's -20 dB results say how quiet is too quiet.
- **Birds that sound like voices** may be muted. Their detections still count,
  but their clips can be missing. Test 3 bounds this.
- **A missed window.** BirdNET scores 3-second windows with no overlap, so a
  short word that falls across a window boundary scores lower in both. The
  padding covers the neighbors, but only if one window still scores high
  enough.
- **Passing the tests isn't proof of privacy.** The filter reduces exposure.
  It doesn't guarantee that no voice is ever published.


## Run the evaluation from the home-network session

Run inference on the development laptop, not as a second classifier on the Pi.
Use a separate worktree for `codex/voice-filter`, and preserve any other agent's
uncommitted changes. Confirm the laptop has the evaluator's NumPy, SciPy,
SoundFile and LiteRT dependencies. Copy only audio and model files; don't copy
`birdtracker.env` or other credentials.

From the branch's repository root, prepare the ignored corpus as follows:

```bash
STATION_HOST=pio
EVAL_DIR=data/privacy-eval
mkdir -p "$EVAL_DIR/background" "$EVAL_DIR/birds" "$EVAL_DIR/models"
rsync -az --exclude='*.clean.mp3' --include='*.mp3' --exclude='*' "$STATION_HOST:birdtracker/data/live/" "$EVAL_DIR/background/"
rsync -az --include='*/' --include='*.ogg' --include='*.flac' --exclude='*' "$STATION_HOST:birdtracker/data/clips/" "$EVAL_DIR/birds/"
rsync -az "$STATION_HOST:birdtracker/models/" "$EVAL_DIR/models/"
export BIRDNET_MODELS="$PWD/$EVAL_DIR/models"
```

`STATION_HOST` is the SSH alias for the station. Replace `pio` if the laptop uses
a different alias. `EVAL_DIR` is the ignored local evaluation folder. If the
remote installation isn't under `birdtracker/`, use its actual path.

On a macOS development laptop, generate speech files and run the evaluation:

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python pipeline/privacy_eval.py --background "$EVAL_DIR/background" --birds "$EVAL_DIR/birds" --speech "$EVAL_DIR/speech" --out "$EVAL_DIR" --generate-speech --threads 1
```

The synthesis command uses installed voices and writes AIFF files. It doesn't
play sound or download voices. On another operating system, use the generated
AIFFs and matching `synthesis.json` from a macOS run and omit
`--generate-speech`. Don't download a public speech dataset without asking.

Check that the corpus covers at least a full day and includes the station's
bird clips. Don't use `--allow-incomplete` to select a production threshold.
The process caches scores and logs progress, so it can resume on the same
corpus after interruption. Keep its inputs, comparisons and CSV local. Return
the threshold table, input coverage, model hashes, limitations and selected
threshold or failure reason. Append the results to the evaluation record and
update Status. Don't play audio, change production services, deploy or merge as
part of this evaluation handoff.
