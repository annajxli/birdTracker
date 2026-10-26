# Development

This page explains how to run Bird Tracker on a development computer: set up
the environment, run the dashboard on simulated data, run the pipeline without
a recorder, and run the tests. For how the parts fit together, see
[Architecture](architecture.md).

## Before you begin

Install the following:

- Python 3.11 or later
- Node.js 18 or later

From the repository root, run all commands on this page.

## Set up the environment

1. Create a Python virtual environment:

   ```bash
   python3 -m venv .venv
   ```

2. Install the Python dependencies, including BirdNET:

   ```bash
   .venv/bin/pip install -r requirements.txt
   ```

   The dashboard's data loaders run with `.venv/bin/python`, so the virtual
   environment must be at `.venv/`. To build only the dashboard, without
   BirdNET, install `requirements-dashboard.txt` instead. The deploy workflow
   uses that file.

3. Install the dashboard dependencies:

   ```bash
   npm --prefix dashboard install
   ```

## Run the dashboard on simulated data

1. Generate a year of simulated detections in `data/detections.sqlite`:

   ```bash
   .venv/bin/python pipeline/simulate.py
   ```

   The simulator uses the species in `data/occurrence.csv` and the rain in
   `data/weather.csv`.

2. Optional: Generate simulated recorder telemetry for the **Hardware
   analytics** page:

   ```bash
   .venv/bin/python pipeline/simulate_recordings.py
   ```

3. Start the development server:

   ```bash
   npm --prefix dashboard run dev
   ```

4. Open `http://localhost:3000`.

To read a different database, set the `BIRDTRACKER_DB` environment variable
before you start the server. For example, to view real data copied from the
indoor computer, set it to the path of that `recorder.sqlite` file.

## Run the pipeline without a recorder

The pipeline scripts write to `data/detections.sqlite` by default, which is
also where `simulate.py` writes. To keep real detections apart from simulated
ones, pass `--db data/recorder.sqlite` to each script, as the indoor computer
does. If a database already has real detections, `simulate.py` refuses to add
simulated ones unless you pass `--force`.

To process recordings on a development computer, put audio files named by
their UTC start time, such as `20260512T131500Z.wav`, in `data/incoming/`.
Then run the analyzer once:

```bash
.venv/bin/python pipeline/analyzer.py --once --db data/recorder.sqlite
```

To keep watching for new recordings, use `--watch` instead of `--once`.

To receive recordings from a bench recorder, start the receiver with the same
token as the recorder's `secrets.h`:

```bash
.venv/bin/python pipeline/receiver.py --token TOKEN
```

Replace `TOKEN` with the shared token. You can set the `RECEIVER_TOKEN`
environment variable instead of passing `--token`. On macOS, if the system asks
whether Python can accept incoming connections, allow it. For the bench recorder setup, see
[Recorder hardware](hardware.md#build-the-bench-recorder).

To try the local live view without a recorder, start `live.py`, then replay a
recording into it:

```bash
.venv/bin/python pipeline/live.py
```

```bash
.venv/bin/python pipeline/live_fake_stream.py PATH_TO_AUDIO
```

Replace `PATH_TO_AUDIO` with the path to a WAV file. Then open
`http://localhost:8000`.

### Publish from a development computer

To publish a development computer's data to R2 instead of the Pi's, load the
R2 keys from `publish.env` and run the publisher. Don't run two publishers for
the same bucket. For how to create `publish.env`, see
[Create an R2 token for the publisher](deploy.md#create-an-r2-token-for-the-publisher).

```bash
set -a; . ./publish.env; set +a
.venv/bin/python pipeline/publish.py --watch --db data/recorder.sqlite
```

### Load results from BirdNET-Analyzer

To analyze recordings with BirdNET-Analyzer directly and load the results,
do the following:

1. Analyze a folder of recordings:

   ```bash
   .venv/bin/birdnet-analyze recordings/ -o results/ --lat 47.61 --lon -122.33 --rtype csv
   ```

2. Load the results into the database:

   ```bash
   .venv/bin/python pipeline/ingest.py results/*.BirdNET.results.csv --station backyard --db data/recorder.sqlite
   ```

   `ingest.py` reads each recording's start time from its filename. For a
   file without a timestamp in its name, pass `--start`.

## Run the tests

To run the tests, run the following commands:

- Dashboard component tests:

  ```bash
  node --test dashboard/test/*.test.mjs
  ```

- Password Worker tests:

  ```bash
  node deploy/password-worker.test.mjs
  ```

To check the site build, run `npm --prefix dashboard run build`.

## Regenerate reference data

The repository includes the files in the following table. When a file's input
changes, regenerate the file and commit the result.

| File | Command | When to run it |
| --- | --- | --- |
| `data/occurrence.csv` | `pipeline/occurrence.py` | The station location changes. Pass `--lat` and `--lon`. The first run downloads the BirdNET model, about 220 MB. |
| `data/species_images.json` | `pipeline/species_images.py` | The species list changes. |
| `data/species_categories.csv` | `pipeline/species_categories.py` | The species list changes. |
| `data/photo_focus.json` | `pipeline/photo_focus.py` | `species_images.json` gains photos. Needs TensorFlow. |
| `data/weather.csv`, `data/weather_hourly.csv` | `pipeline/weather.py` | New detections arrive. The deploy workflow also runs it. |

Run each command with `.venv/bin/python`. For options, run the script with
`--help`.

The station location is set in several places: the `--lat` and `--lon`
defaults in `analyzer.py`, `live.py`, and `occurrence.py`, and the `LAT` and
`LON` constants in `weather.py`. To move the station, change all of them.
