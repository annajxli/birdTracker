# Development

This page explains how to run Bird Tracker on a development computer. For how
the parts fit together, see [Architecture](architecture.md). Run all commands
from the repository root.

## Set up the environment

Install Python 3.12 or later and Node.js 18 or later. To get both from conda
instead, run `conda env create -f environment.yml` and
`conda activate birdtracker`.

1. Create a Python virtual environment and install the dependencies, including
   BirdNET:

   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   ```

   The dashboard's data loaders run `.venv/bin/python`, or
   `.venv\Scripts\python.exe` on Windows, so the environment must be at
   `.venv/`. To build only the dashboard, without BirdNET, install
   `requirements-dashboard.txt` instead, as the deploy workflow does.

2. Install the dashboard dependencies:

   ```bash
   npm --prefix dashboard install
   ```

## Run the dashboard on simulated data

1. Generate a year of simulated detections in `data/detections.sqlite`, from
   the species in `data/occurrence.csv` and the rain in `data/weather.csv`:

   ```bash
   .venv/bin/python pipeline/simulate.py
   ```

2. Optional: For the **Hardware analytics** page, generate simulated recorder
   telemetry:

   ```bash
   .venv/bin/python pipeline/simulate_recordings.py
   ```

3. Start the development server, and open `http://localhost:3000`:

   ```bash
   npm --prefix dashboard run dev
   ```

To read a different database, such as a copy of the indoor computer's
`recorder.sqlite`, set the `BIRDTRACKER_DB` environment variable before you
start the server.

## Run the pipeline without a recorder

The pipeline scripts write to `data/detections.sqlite` by default, where
`simulate.py` also writes. To keep real detections apart, pass
`--db data/recorder.sqlite`, as the indoor computer does. `simulate.py`
refuses to add to a database with real detections unless you pass `--force`.

To process recordings, put audio files named by their UTC start time, such as
`20260512T131500Z.wav`, in `data/incoming/`, and run the analyzer. To keep
watching for new files, use `--watch` instead of `--once`.

```bash
.venv/bin/python pipeline/analyzer.py --once --db data/recorder.sqlite
```

To receive recordings from a bench recorder, start the receiver with the token
from the recorder's `secrets.h`, or set `RECEIVER_TOKEN` instead. On macOS,
allow Python to accept incoming connections. For the recorder, see
[Recorder hardware](hardware.md#build-the-bench-recorder).

```bash
.venv/bin/python pipeline/receiver.py --token TOKEN
```

To try the local live view without a recorder, start `live.py`, replay a WAV
file into it, and open `http://localhost:8000`:

```bash
.venv/bin/python pipeline/live.py
.venv/bin/python pipeline/live_fake_stream.py PATH_TO_AUDIO
```

Run each command in its own terminal. Replace `PATH_TO_AUDIO` with the path to
a WAV file.

### Publish from a development computer

To publish this computer's data to R2, load the keys from `publish.env` and
run the publisher. Don't run two publishers for the same bucket. To create
`publish.env`, see
[Create an R2 token for the publisher](deploy.md#create-an-r2-token-for-the-publisher).

```bash
set -a; . ./publish.env; set +a
.venv/bin/python pipeline/publish.py --watch --db data/recorder.sqlite
```

### Load results from BirdNET-Analyzer

To analyze a folder of recordings with BirdNET-Analyzer directly and load the
results, run the following commands:

```bash
.venv/bin/birdnet-analyze recordings/ -o results/ --lat LAT --lon LON --rtype csv
.venv/bin/python pipeline/ingest.py results/*.BirdNET.results.csv --db data/recorder.sqlite
```

Replace `LAT` and `LON` with the station's coordinates. `ingest.py` reads each
recording's start time from its filename. For a file without one, pass
`--start`.

## Run the tests

- Dashboard components: `node --test dashboard/test/*.test.mjs`
- Worker: `node deploy/password-worker.test.mjs`
- Pipeline, with no network or credentials:
  `.venv/bin/python -m unittest discover -s pipeline -p 'test_*.py'`
- Site build: `npm --prefix dashboard run build`

## Regenerate reference data

When a file's input changes, regenerate the file and commit the result. Run
each script with `.venv/bin/python`, and use `--help` for options.

| File | Script | When to run it |
| --- | --- | --- |
| `data/occurrence.csv` | `pipeline/occurrence.py` | The station location changes. Pass `--lat` and `--lon`. The first run downloads the BirdNET model, about 220 MB. |
| `data/species_images.json` | `pipeline/species_images.py` | The species list changes. |
| `data/species_categories.csv` | `pipeline/species_categories.py` | The species list changes. |
| `data/photo_focus.json` | `pipeline/photo_focus.py` | `species_images.json` gains photos. Needs TensorFlow. |
| `data/species_traits.json` | `pipeline/species_traits.py` | The species list or `data/species_length_fixes.csv` changes. Check each new length against its source sentence. |
| `data/avonet_mass.csv` | `pipeline/species_traits.py --avonet XLSX` | AVONET publishes a new release. See the script's docstring. |
| `data/weather.csv`, `data/weather_hourly.csv` | `pipeline/weather.py` | New detections arrive. The deploy workflow also runs it. |

The station location is set in several places: the `--lat` and `--lon`
defaults in `analyzer.py`, `live.py`, and `occurrence.py`, and the `LAT` and
`LON` constants in `weather.py`. To move the station, change all of them.
