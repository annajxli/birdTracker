# Architecture

This page describes how Bird Tracker works on `main`: the components, how audio
and data move between them, and where data lives. For what is deployed, see
[Status](status.md).

## System overview

Bird Tracker has four parts:

- **Recorder.** An outdoor microcontroller board with a microphone that
  streams audio over Wi-Fi to the indoor computer. For the hardware, see
  [Recorder hardware](hardware.md).
- **Indoor computer.** An always-on computer, such as a Raspberry Pi, that runs
  the Python services in `pipeline/`. It turns audio into detections, clips,
  and spectrograms, and publishes them to Cloudflare R2.
- **Cloudflare.** An R2 bucket holds the published data. A Worker handles
  sign-in, serves the built dashboard, and serves the R2 data to signed-in
  visitors.
- **Dashboard.** An Observable Framework static site in `dashboard/`, built and
  deployed by GitHub Actions.

```
recorder ──HTTP stream──> receiver.py ──1-minute WAVs──> analyzer.py ──> SQLite database
                              │                              │
                              └──TCP──> live.py              └──> clips/, live/
                                       (local live view)              │
                                                                      v
browser <──────── Worker <──────── R2 bucket <──────────────────── publish.py
                    │                  ^
                    └─ POST /api/reviews┘
```

## Pipeline on the indoor computer

The indoor computer runs three long-lived services, installed as systemd
services from [`deploy/pi/`](../deploy/pi/). Each script's module docstring and
`--help` output are the reference for its behavior and flags.

### Receiver

`pipeline/receiver.py` accepts audio from the recorder over plain HTTP,
authenticated by a shared token, so use it only on a local network. It supports
two modes:

- **Stream** (`POST /stream`). The recorder keeps one connection open and
  sends numbered audio frames and periodic health frames. The receiver cuts the
  stream into one WAV file per UTC minute, fills short gaps with silence, and
  writes a JSON file of recorder telemetry next to each WAV.
- **Upload** (`POST /upload`). The recorder sends one finished file per
  request.

The receiver writes to a `.part` file in `data/incoming/` and renames it when
the file is complete, and deletes leftover `.part` files when it starts. It
accepts only filenames that are a UTC start time plus an audio extension, such
as `20260512T131500Z.wav`. It can also forward the stream, best effort, to
`pipeline/live.py` on a local TCP port.

While the recorder is [paused](#pause-the-recorder), the receiver discards its
audio, so paused time is missing audio, like an outage. It reads the pause from
`data/pause.json`.

With the same token, the receiver also serves:

- **Firmware images** for over-the-air updates. `GET /ota/BOARD.sha256` returns
  the SHA-256 of `ota/BOARD.bin`, and `GET /ota/BOARD.bin` returns the image.
  The directory is `--ota-dir`. The recorder pulls updates, so the receiver
  never needs to reach the recorder.
- **Its clock** at `GET /time`, for a recorder that can't reach NTP. It answers
  only after `systemd-timesyncd` has synced the clock since boot
  (`--clock-synced-file`). Otherwise it returns 503, and the recorder doesn't
  stream, because a gap is better than misdated recordings.

### Recorder firmware updates

The FireBeetle bench firmware checks the receiver for a new image at startup
and every `OTA_CHECK_SECONDS` in `firmware/recorder_test/recorder_test.ino`.
When the receiver's hash differs from the running image's, the recorder stops
streaming, downloads the image into its other app slot while it checks the
SHA-256, and restarts into it. The partition table, `default.csv`, has two app
slots and the LittleFS partition.

A new image starts on trial. It marks itself valid once it has streamed
`OTA_CONFIRM_FRAMES` and the receiver has answered an update check. If it
crashes or restarts first, or isn't valid within `OTA_TRIAL_SECONDS`, the
previous image starts again and skips the rejected hash until the receiver
serves a different one.

A task watchdog (`WATCHDOG_SECONDS`) restarts the board if the loop or
microphone task hangs, and the microphone code restarts it after
`MIC_STALL_SECONDS` without samples. The update check runs before streaming,
so a board that restarts for these reasons can still install a fix.

### Analyzer

`pipeline/analyzer.py` watches `data/incoming/`. A file counts as finished when
its size and modification time stay the same across two checks. For each
finished recording, the analyzer does the following:

1. Runs BirdNET with the station's location and the week of the year, keeping
   only the species expected there that week. When BirdNET scores an excluded
   species whose genus has exactly one expected species, the expected species
   gets the higher of the two scores, because BirdNET often splits a call
   between siblings. For details, see `pipeline/birdnet_lite.py`.
2. Adds the detections to the `detections` table, and the recorder telemetry
   to the `recordings` table.
3. Cuts an Opus clip of the most confident detection of each species per hour
   into `data/clips/`, with a spectrogram image.
4. Renders a spectrogram strip and MP3 copies of the minute into `data/live/`,
   and lists them with their detections in `live.json` for the **Live** page.
5. Deletes the recording, or with `--keep-days`, moves it to
   `data/processed/` so that you can check doubtful detections by ear.

A file that fails repeatedly moves to `data/failed/`. Failures not caused by
the file, such as a locked database or a full disk, don't count against it.
Only one analyzer runs per data folder.

The analyzer has two BirdNET engines:

- `lite` (default): `pipeline/birdnet_lite.py` runs BirdNET's TFLite model on
  `ai-edge-litert`, without TensorFlow, so a Raspberry Pi 3B+ can run it.
- `analyzer`: the `birdnet-analyzer` package, which needs TensorFlow.

### Publisher

`pipeline/publish.py` keeps the R2 bucket in sync with the indoor computer. It
mirrors `data/live/` and `data/clips/`, uploading new and changed files and
deleting remote files that the analyzer deleted. It uploads Parquet exports and
database snapshots when the database changes. For the layout, see
[R2 bucket](#r2-bucket).

On every pass, the publisher uploads what current Live playback needs:
`live.json`, the minute MP3s and spectrograms, and `status.json`. Less often,
at `--reviews-seconds` and `--history-seconds`, it checks for reviews and
uploads the Live page's day files (`days/` and `days.json`). Files upload
before the index files that list them.

The publisher also does the following:

- **Applies reviews.** When a signed-in visitor confirms or rejects a
  detection, the Worker saves the verdict to `reviews/` in R2, and the
  publisher writes it to the database.
- **Learns per-species thresholds.** From all reviews,
  `pipeline/thresholds.py` gives each species with enough reviews the lowest
  threshold that keeps its detections mostly right, blocks species whose
  detections are mostly wrong, and leaves others at a shared default. The
  result is `live/thresholds.json`. The analyzer uses it when it counts
  birdsong, and the dashboard uses it as described in
  [How the dashboard counts](#how-the-dashboard-counts).
- **Fetches the recorder pause** from `control/pause.json` in R2 every
  `--pause-seconds`, and writes it to `data/pause.json`.
- **Counts its R2 usage** per UTC day in `data/publish-usage.json`: API calls
  by operation and attempted upload bytes. The counts aren't a bill. For
  details, see `pipeline/publish_usage.py`.
- **Starts the deploy workflow** after each snapshot, if the `GITHUB_TOKEN`
  environment variable is set, so the built site includes the newest data.

`status.json` also reports which code the indoor computer runs and whether its
operating system has updates:

- `deploy/pi/push.sh` records the commit and a fingerprint of the deployed
  files (`pipeline/code_version.py`) in `deployed.json` on the Pi. The site
  build exports the fingerprints of recent commits on `main`
  (`dashboard/src/data/pi-code.json.py`), so the Hardware analytics page can
  count the updates the Pi is missing, even after a squash merge.
- A weekly timer, `deploy/pi/birdtracker-updates.timer`, runs
  `pipeline/updates.py` to check for package updates. A second weekly timer,
  `deploy/pi/birdtracker-upgrade.timer`, installs Debian security updates with
  `unattended-upgrade`, limited by
  `deploy/pi/52birdtracker-unattended-upgrades`. Neither reboots; the check
  reports when a reboot is required.

### Live view on the local network

`pipeline/live.py` serves a local page with a scrolling spectrogram and
BirdNET's identifications, about half a second behind the microphone, from the
stream that the receiver forwards. It stores nothing. The Raspberry Pi services
run the receiver with forwarding off, so `live.py` isn't part of the Pi
deployment. To try it without a recorder, use `pipeline/live_fake_stream.py`.

## Data

### Database

The pipeline stores data in one SQLite database, defined in
`pipeline/schema.sql`:

- `detections`: one row per 3-second segment in which BirdNET detected a
  species, with the clip path and a person's review, if any.
- `recordings`: one row per recorded minute, with recorder telemetry such as
  background level, Wi-Fi signal, and dropped frames.

Simulated data uses `data/detections.sqlite`, the default in `pipeline/db.py`.
The indoor computer uses `data/recorder.sqlite`, set by `--db` in the systemd
services, which keeps real data apart from simulated data.

### Local folders

The pipeline generates the following folders under `data/`, and Git ignores
them:

| Folder | Contents | Written by |
| --- | --- | --- |
| `incoming/` | Recordings waiting for analysis | Receiver |
| `processed/` | Analyzed recordings kept by `--keep-days` | Analyzer |
| `failed/` | Recordings that failed analysis repeatedly | Analyzer |
| `clips/` | Detection clips and their spectrograms | Analyzer |
| `live/` | Minute strips, MP3s, `live.json`, `days/`, `reviews.json`, `thresholds.json`, and `status.json` | Analyzer and publisher |

The repository includes the following reference files in `data/`. To
regenerate them, see
[Regenerate reference data](development.md#regenerate-reference-data).

| File | Contents |
| --- | --- |
| `occurrence.csv` | Species by week likelihoods for the station location, from BirdNET's location model |
| `species_images.json` | A photo URL, credit, and license for each species |
| `species_categories.csv` | A rough category for each species, such as songbirds or raptors |
| `photo_focus.json` | The focal point of each species photo, for cropping |
| `species_traits.json` | Each species' eBird code, body mass, and length |
| `avonet_mass.csv` | Body mass for every species, from AVONET (Tobias et al. 2022, CC BY 4.0) |
| `species_length_fixes.csv` | Hand corrections to lengths parsed from Wikipedia |
| `weather.csv`, `weather_hourly.csv` | Daily and hourly weather from Open-Meteo |

### R2 bucket

The bucket name comes from the `R2_BUCKET` environment variable, and the
default is `birdtracker-media`. The publisher writes the following keys:

| Key | Contents |
| --- | --- |
| `live/` | Mirror of `data/live/` |
| `clips/` | Mirror of `data/clips/` |
| `data/detections.parquet` | Detections, as the dashboard reads them |
| `data/recordings.parquet` | Recorder telemetry |
| `data/detections.sqlite` | A database snapshot that the site build downloads |
| `data/snapshots/` | One snapshot per UTC day, up to `SNAPSHOT_KEEP_DAYS` in `pipeline/publish.py` |

The Worker writes review verdicts to `reviews/` and the recorder pause to
`control/pause.json`.

The publisher protects the bucket from an empty or damaged data folder. It
logs an error and doesn't upload when a snapshot or Parquet file falls below
`MIN_SIZE_RATIO` of the file it would replace, or when a snapshot fails
SQLite's quick check, and a mirror won't delete most of a prefix in one pass
(`MASS_DELETE_MIN`). To recover, see
[Restore after losing the data folder](deploy.md#restore-after-losing-the-data-folder).

## Website

### Build

`.github/workflows/pages.yml` builds and deploys the site in one job, on a push
to `main` that changes a path in its `paths` list, on a schedule, on demand,
and when the publisher starts it. The build does the following:

1. Updates `data/weather.csv` from Open-Meteo, or keeps the checked-in copy if
   the fetch fails.
2. Downloads the database snapshot from R2, or simulates a year of detections
   if there's none.
3. Builds the site. The Python data loaders in `dashboard/src/data/` export the
   database to Parquet and JSON.
4. Deploys the site as the Worker's static assets.

### Worker

`deploy/password-worker.js` serves the built site only to visitors with a valid
session cookie. It also serves the following routes to signed-in visitors:

| Route | Serves |
| --- | --- |
| `/api/live/NAME` | `live/NAME` from R2 |
| `/api/clips/KEY` | The clip at `KEY`, which starts with `clips/`, from R2 |
| `/api/data/detections.parquet`, `/api/data/recordings.parquet` | The newest exports from R2 |
| `POST /api/reviews` | Saves a review verdict to R2 |
| `/api/pause` | The recorder pause; `POST` sets or ends it with the control password |
| `/__signout` | Signs out the current device |

The sign-in page also shows a chart of minutes of birdsong per day with
weather, written by `pipeline/signin_chart.py` as `signin-chart.svg` during the
deploy. It shows the last `--days` recorded days with no dates, times, or
recorder details. A build from simulated data writes no chart.

For setup steps, see [Deploy](deploy.md).

### Pause the recorder

The Hardware analytics page can pause the recorder, for example when it's loud
indoors. A pause needs a sign-in and the separate `CONTROL_PASSWORD` secret,
and the Worker rate-limits attempts like sign-in. It lasts one of the
durations in `PAUSE_MINUTES` in `deploy/password-worker.js` and always ends on
its own. The Worker saves the end time to `control/pause.json`, the publisher
copies it to the indoor computer, and the receiver discards audio until then.
A pause takes effect within about `--pause-seconds` plus the publisher's
`--interval`.

### Pages

When a page opens, it loads the newest Parquet exports from `/api/data/`, and
falls back to the copy built into the site if that fails, so new data appears
without a rebuild. Pages also fetch recent weather from Open-Meteo and today's
forecast from the National Weather Service (`dashboard/src/components/nws.js`).
Today's weather combines Boeing Field (`KBFI`) observations so far with the
remaining NWS forecast, and the current temperature comes from the NWS Seattle
office station (`SEAW1`) unless it's older than `TEMP_MAX_AGE_MS`. Each
weather request times out after `WEATHER_TIMEOUT_MS`, and charts that don't
show weather don't wait for it.

The site has the following pages:

- **Overview**: daily activity, species, and weather. One date selector sets
  the day that every chart ends on, and each card picks its own span with
  `spanInput` in `dashboard/src/components/period-input.js`. Week, month, and
  year spans end on the selected date (`TRAILING_DAYS` in
  `dashboard/src/components/period.js`). The date and spans are kept in URL
  query parameters. The page checks for new data every `OVERVIEW_REFRESH_MS`
  in `dashboard/src/components/overview-refresh.js`, and when the tab regains
  focus, using HEAD requests that the Worker answers from R2 metadata. Only
  changed files reload, and controls, selections, and scroll position stay as
  they are.
- **Live**: published minutes with spectrograms, audio, and detections, where
  you can confirm or reject detections. Strips can include `unidentified`
  intervals, one per 3-second window that counts as unidentified birdsong
  (`read_unidentified` in `pipeline/analyzer.py`). A dot marks species
  detected at the playback position (`dashboard/src/components/live-activity.js`).
  A label's **More details** link opens the species page in a new tab.
- **Species**: every species heard, with photos and counts.
- **Display**: a slideshow of the Overview charts for a wall screen, at
  `/display`. The site header doesn't link to it.
- **Hardware analytics**: recorder coverage, background level, Wi-Fi signal,
  pipeline delay, and the indoor computer's health, code version, and
  operating system updates.
- **Detections**: a table of every detection, including rejected ones, where
  you can also confirm or reject detections.

### How the dashboard counts

BirdNET scores every 3-second segment, so the database holds one row per
segment with a detection. The dashboard converts rows into simpler numbers.
Simulated data set these choices:

- **Minutes heard.** The dashboard counts clock minutes, not detections. A
  bird that calls for 20 minutes counts as about 20, not about 400.
- **Bouts on the daily timeline.** Detections closer together than
  `BOUT_GAP_MINUTES` in `dashboard/src/components/birds.js` draw as one bar.
  Raise it if calling birds appear as strings of thin bars, and lower it if
  separate visits merge.
- **Simulated bout lengths** in `pipeline/simulate.py` are an estimate of real
  singing.

A detection counts when its confidence reaches its species' threshold from
`live/thresholds.json`. A blocked species counts only confirmed detections.
Species without a learned threshold use the page's confidence control, or the
file's default on the Live page and the display. A confirmed review always
counts, and a rejected one never does. The rule is `includedDetection` in
`dashboard/src/components/detection-policy.js`, and it matches `threshold()`
in `pipeline/thresholds.py`. People review the detections they doubt, not a
random sample, so a learned threshold is an estimate.

The dashboard links species photos from Wikimedia Commons and shows each
photo's credit and license next to it. If you change the layout, keep them
visible.

## Design decisions

- **Identify birds indoors.** Running BirdNET outdoors on solar power through
  a Seattle winter needs a much larger panel and battery than recording does.
  For the estimates, see the
  [recorder hardware options](design/hardware-design.html).
- **Serve the site from the Worker, not GitHub Pages.** GitHub Pages sites are
  public, so a Worker placed in front of Pages could be bypassed. The Worker
  serves the site from its own static assets instead.
- **Show only a coarse chart before sign-in.** The sign-in chart has no dates
  or place names, and everything else stays behind sign-in.
- **Run BirdNET without TensorFlow by default.** `birdnet-analyzer` imports
  TensorFlow on every start, which a 1 GB Raspberry Pi 3B+ can't afford. On
  five test recordings, the `lite` engine found the same 32 detections, with
  scores within 0.005, and ran about six times faster.
- **Plain SQLite schema.** The schema avoids SQLite-specific features so the
  tables could move to Cloudflare D1.
