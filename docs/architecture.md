# Architecture

This page describes how Bird Tracker works on `main`: the components, how audio
and data move between them, and where each piece of data lives. For what is
deployed and what work is in progress, see [Status](status.md).

## System overview

Bird Tracker has four parts:

- **Recorder.** An outdoor microcontroller board with a microphone. It streams
  audio over Wi-Fi to the indoor computer. It doesn't identify birds. For the
  hardware, see [Recorder hardware](hardware.md).
- **Indoor computer.** An always-on computer on wall power, such as a
  Raspberry Pi or a laptop, that runs the Python services in `pipeline/`. It
  turns audio into detections, clips, and spectrograms, and publishes them to
  Cloudflare R2.
- **Cloudflare.** An R2 bucket holds the published data. A Worker checks a
  shared password, serves the built dashboard, and serves the R2 data to
  signed-in visitors.
- **Dashboard.** An Observable Framework static site in `dashboard/`. GitHub
  Actions builds it and deploys it to the Worker.

The following diagram shows how audio and data flow between the parts:

```
recorder ──HTTP stream──> receiver.py ──1-minute WAVs──> analyzer.py ──> SQLite database
                              │                              │
                              └──TCP──> live.py              └──> clips/, live/
                                       (local live view)              │
                                                                      v
browser <── password Worker <── R2 bucket <────────────────────── publish.py
                │                   ^
                └── POST /api/reviews ┘
```

## Pipeline on the indoor computer

The indoor computer runs three long-lived services. The
[`deploy/pi/`](../deploy/pi/) folder installs them as systemd services. Each
script's module docstring and `--help` output are the reference for its
behavior and flags.

### Receiver

`pipeline/receiver.py` accepts audio from the recorder over plain HTTP,
authenticated by a shared token. Use it only on the home network. It supports
two modes:

- **Stream** (`POST /stream`). The recorder keeps one connection open and
  sends numbered audio frames and periodic health frames. The receiver cuts the
  stream into one WAV file per UTC minute, fills short gaps with silence, and
  writes a JSON file of recorder telemetry next to each WAV.
- **Upload** (`POST /upload`). The recorder sends one finished file per
  request.

In both modes, the receiver writes to a `.part` file in `data/incoming/` and
renames it when the file is complete. When it starts, it deletes `.part` files left
by a stop in the middle of a file. It accepts only filenames that look like
a UTC start time plus an audio extension, such as `20260512T131500Z.wav`.

The receiver can also forward the stream to `pipeline/live.py` on a local TCP
port. This forwarding is best effort and never delays the minute files.

While the recorder is paused, the receiver discards its audio before writing
anything, so paused time is missing audio, the same as an outage. It reads the
pause from `data/pause.json`, and a pause always ends on its own. For how a
pause is set, see [Pause the recorder](#pause-the-recorder).

### Analyzer

`pipeline/analyzer.py` watches `data/incoming/`. A file counts as finished
when its size and modification time stay the same across two checks. For each
finished recording, the analyzer does the following:

1. Runs BirdNET with the station's location and the week of the year. The
   location filter keeps only the species expected at the station that week.
   When BirdNET scores an excluded species, and its genus has exactly one
   expected species, the expected species gets the higher of the two scores,
   because BirdNET often splits a call between siblings. For example, a
   California Scrub-Jay in Seattle often scores as Woodhouse's Scrub-Jay.
   For the details, see the docstring of `pipeline/birdnet_lite.py`.
2. Adds the detections to the `detections` table, and the recorder telemetry
   to the `recordings` table.
3. Cuts a short Opus clip of the most confident detection of each species per
   hour into `data/clips/`, with a spectrogram image next to it.
4. Renders a spectrogram strip and MP3 copies of the minute into
   `data/live/`, and lists them with their detections in `live.json` for the
   dashboard's **Live** page.
5. Deletes the recording. If you set `--keep-days`, the analyzer moves the
   recording to `data/processed/` instead. On the Pi,
   `deploy/pi/birdtracker-analyzer.service` sets it, so you can check a
   missed or doubtful detection against the audio that BirdNET heard.

If analysis of a file fails repeatedly, the analyzer moves the file to
`data/failed/`. Failures that aren't caused by the file, such as a locked
database or a full disk, don't count against it. Only one analyzer runs per
data folder.

The analyzer has two BirdNET engines:

- `lite` (default): `pipeline/birdnet_lite.py` runs BirdNET's TFLite model on
  `ai-edge-litert`, without TensorFlow. A Raspberry Pi 3B+ can run it.
- `analyzer`: runs the `birdnet-analyzer` package, which needs TensorFlow.

### Publisher

`pipeline/publish.py` keeps the R2 bucket synchronized with the indoor
computer. It
mirrors `data/live/` and `data/clips/`: it uploads new and changed files and
deletes remote files that the analyzer deleted. It also uploads Parquet
exports and database snapshots when the database changes. For the R2 layout,
see [R2 bucket](#r2-bucket).

The publisher also applies reviews. When a signed-in visitor marks a detection
as confirmed or rejected, the Worker saves the verdict to `reviews/` in R2. The
next time the publisher checks for reviews, it writes the verdict to the
database.

The publisher also fetches the recorder pause, `control/pause.json` in R2,
every `--pause-seconds`, and writes it to `data/pause.json` for the receiver.

Each time it applies reviews, the publisher also learns a confidence threshold
for each species from all reviews so far (`pipeline/thresholds.py`), and
writes `live/thresholds.json`. A species with enough reviews gets the lowest
threshold that keeps its reviewed detections mostly right. A species whose
detections are mostly wrong even at high confidence is blocked, so it counts
only when a person confirms it. Other species keep a shared default. The
module's docstring has the rule and its constants. The analyzer reads the file
when it counts birdsong: a window whose likeliest species is blocked isn't
birdsong, and a window counts as identified when that species reaches its own
threshold. The Live page's day index uses the same thresholds for its minutes
with a bird, and the dashboard uses them to count detections, as
[How the dashboard counts](#how-the-dashboard-counts) describes.

The publisher uploads what the Live page needs for current playback on every
pass: `live.json`, the minute MP3s and spectrograms, and `status.json`. It
checks for reviews, and uploads changes to the Live page's day files (`days/`
and `days.json`), less often, at the intervals set by `--reviews-seconds` and
`--history-seconds` in `pipeline/publish.py`. A new day file uploads right
away. Within each pass, files upload before the index files that list them, so
an index never refers to a file that isn't in R2 yet.

The publisher counts its R2 API calls by operation, and the bytes it tries to
upload, per UTC day in `data/publish-usage.json`. The counts survive restarts
and contain no object keys or credentials. They aren't a bill: they leave out
downloads, website requests, and automatic HTTP retries. For details, see
`pipeline/publish_usage.py`.

`status.json` also reports which code the indoor computer runs and whether its
operating system has updates. When `deploy/pi/push.sh` deploys, it records the
commit and a fingerprint of the contents of the deployed files that the Pi
runs (`pipeline/code_version.py`) in `deployed.json` on the Pi. A weekly systemd
timer, `deploy/pi/birdtracker-updates.timer`, runs `pipeline/updates.py`,
which refreshes apt's package lists, simulates an upgrade, and reads when the
next install is due. A second weekly timer, `deploy/pi/birdtracker-upgrade.timer`,
installs Debian security updates with `unattended-upgrade`, limited by
`deploy/pi/52birdtracker-unattended-upgrades`, and then runs the check again.
Other updates wait for an install by hand.
It doesn't reboot; the check reports when a reboot is required. The site's build exports the fingerprints of the recent commits on
`main` that changed the deployed files (`dashboard/src/data/pi-code.json.py`).
The Hardware analytics page finds the Pi's fingerprint in that list, so it can
count the updates the Pi is missing. A change to a file the Pi copies but never
runs, such as a test or a script for the laptop, isn't an update. The page
finds the Pi's code even when it came from a branch
that was later squash-merged.

If you set the `GITHUB_TOKEN` environment variable, the publisher starts the
deploy workflow after each snapshot, so the built site includes the newest
data.

### Live view on the home network

`pipeline/live.py` serves a local page with a scrolling spectrogram and
BirdNET's identifications, about half a second behind the microphone. It reads
the stream that the receiver forwards. It stores nothing. It's separate from
the dashboard's **Live** page, which shows published minutes from R2 a minute
or two behind. The Raspberry Pi services run the receiver with forwarding
off, so `live.py` isn't part of the Pi deployment.

To try `live.py` without a recorder, replay a recording into it with
`pipeline/live_fake_stream.py`.

## Data

### Database

The pipeline stores data in one SQLite database. `pipeline/schema.sql` defines
the tables:

- `detections`: one row per 3-second audio segment in which BirdNET detected
  a species. A row also holds the clip path and a person's review, if any.
- `recordings`: one row per recorded minute, with recorder telemetry such as
  background level, Wi-Fi signal, and dropped frames. The **Hardware
  analytics** page reads it.

The database path depends on the setup:

- Simulated data on a development computer: `data/detections.sqlite`, the
  default in `pipeline/db.py`.
- Real data on the indoor computer: `data/recorder.sqlite`, set by `--db` in
  the systemd services. A separate file keeps real data apart from simulated
  data on the same computer.

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

The repository includes the following files in `data/`. To regenerate them,
see
[Regenerate reference data](development.md#regenerate-reference-data).

| File | Contents |
| --- | --- |
| `occurrence.csv` | Species by week likelihoods for the station location, from BirdNET's location model |
| `species_images.json` | A photo URL, credit, and license for each species |
| `species_categories.csv` | A rough category for each species, such as songbirds or raptors |
| `photo_focus.json` | The focal point of each species photo, for cropping |
| `species_traits.json` | Each species' eBird code, for Birds of the World links, and its body mass and length |
| `avonet_mass.csv` | Body mass for every species, from AVONET (Tobias et al. 2022, CC BY 4.0) |
| `species_length_fixes.csv` | Hand corrections to lengths parsed from Wikipedia |
| `weather.csv`, `weather_hourly.csv` | Daily and hourly weather from Open-Meteo |

### R2 bucket

The publisher writes the following keys to the R2 bucket. The bucket name
comes from the `R2_BUCKET` environment variable, and the default is
`birdtracker-media`.

| Key | Contents |
| --- | --- |
| `live/` | Mirror of `data/live/` |
| `clips/` | Mirror of `data/clips/` |
| `data/detections.parquet` | Detections, as the dashboard reads them |
| `data/recordings.parquet` | Recorder telemetry |
| `data/detections.sqlite` | A database snapshot that the site build downloads |
| `data/snapshots/` | One snapshot per UTC day, for recovery, up to `SNAPSHOT_KEEP_DAYS` in `pipeline/publish.py` |

The Worker writes visitors' review verdicts to `reviews/`, and the recorder
pause to `control/pause.json`.

The publisher protects the bucket from an empty or damaged data folder. It logs
an error, and doesn't upload, when a snapshot or Parquet file falls below
`MIN_SIZE_RATIO` of the file it would replace, or when a snapshot fails SQLite's
quick check. A mirror also won't delete most of a prefix in one pass
(`MASS_DELETE_MIN`). The constants are in `pipeline/publish.py`. To recover, see
[Restore after losing the data folder](deploy.md#restore-after-losing-the-data-folder).

## Website

### Build

The workflow in `.github/workflows/pages.yml` builds and deploys the site, in
one job. It runs on a push to `main` that changes a path in its `paths` list,
on a schedule, on demand, and when the publisher starts it. During the build, it does the following:

1. Updates `data/weather.csv` from Open-Meteo. If the fetch fails, the build
   keeps the checked-in copy.
2. Downloads the database snapshot from R2. If no snapshot exists, it
   simulates a year of detections instead.
3. Builds the site. The Python data loaders in `dashboard/src/data/` export
   the database to Parquet and JSON files that the build adds to the site.
4. Deploys the site as the Worker's static assets.

### Password Worker

`deploy/password-worker.js` runs on the dashboard's subdomain. It serves the
built site only to visitors with a valid session cookie, so no public copy of
the site exists. It also serves the following routes to signed-in visitors:

| Route | Serves |
| --- | --- |
| `/api/live/NAME` | `live/NAME` from R2 |
| `/api/clips/KEY` | The clip at `KEY` from R2 |
| `/api/data/detections.parquet`, `/api/data/recordings.parquet` | The newest exports from R2 |
| `POST /api/reviews` | Saves a review verdict to R2 |
| `/api/pause` | The recorder pause; `POST` sets or ends it with the control password |
| `/__signout` | Signs out the current device |

In these routes, `NAME` is a file in `live/`, and `KEY` is a clip's key, which
starts with `clips/`.

For setup steps, see [Deploy](deploy.md).

### Pause the recorder

The Hardware analytics page can pause the recorder, for example when it's loud
indoors. A pause needs a sign-in and the separate `CONTROL_PASSWORD` secret,
and the Worker limits attempts per IP address like sign-in. It lasts one of
the durations in `PAUSE_MINUTES` in `deploy/password-worker.js`, and always
ends on its own. The Worker saves the end time to `control/pause.json`, the
publisher copies it to the indoor computer, and the receiver discards audio
recorded from when the pause was set until then. A new end keeps the pause's
start. A pause takes effect once the publisher next fetches it, within about
`--pause-seconds` plus its `--interval`.

### Pages

When a page opens, it loads the newest Parquet exports from `/api/data/`. If
that request fails, the page uses the copy built into the site. Pages also
fetch the most recent weather directly from Open-Meteo, and today's forecast
from the National Weather Service (`dashboard/src/components/nws.js`), whose
Seattle forecasters adjust the models by hand. Today's weather is the worst
of what Boeing Field (`KBFI`) has observed so far and what NWS still forecasts,
and the day view shows the station's latest observation. If NWS is unavailable,
today uses Open-Meteo's forecast. New data therefore appears without a rebuild. The site has the following pages:

- **Overview**: daily activity, species, and weather. One date selector sets
  the day that every chart ends on. The daily rhythm, activity over time, and
  the combined most heard and trends card each pick their own span (day, week,
  month, year, or all time) with `spanInput` in
  `dashboard/src/components/period-input.js`. The date and any span other than
  its default are kept in URL query parameters, so refreshing or sharing the URL
  restores the view. Week, month and year spans end on the selected date; their
  bounds use `TRAILING_DAYS`, defined in `dashboard/src/components/period.js`.
  `dashboard/src/components/period-state.js` validates the saved date against
  the available data.
- **Live**: published minutes with spectrograms, audio, and detections, where
  you can confirm or reject detections.
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
segment in which BirdNET detected a species. The dashboard converts rows into
easier numbers. Simulated data, not real recordings, set the following
choices, so check them against real recordings:

- **Minutes heard.** The dashboard counts clock minutes, not detections. A
  bird that calls for 20 minutes counts as about 20, not about 400.
- **Bouts on the daily timeline.** The dashboard draws a species' detections
  as one bar when they're closer together than `BOUT_GAP_MINUTES` in
  `dashboard/src/components/birds.js`. If birds that call every few minutes
  appear as strings of thin bars, raise the value. If separate visits merge
  into one long bar, lower it.
- **Default confidence threshold.** To find false positives, listen to a
  sample of clips near the Overview's default threshold.
- **Simulated bout lengths.** The bout lengths in `pipeline/simulate.py` are
  an estimate of real singing. Compare them with several real mornings.

A detection counts when its BirdNET confidence reaches its species' threshold
from `live/thresholds.json`, which the pages load from the Worker beside
`reviews.json`. A blocked species counts only the detections that a person
confirmed. Species without a learned threshold use the confidence control on
the Overview, Detections, and Species pages, or the file's default on the Live
page and the display. A confirmed review always counts, and a rejected one
never does. Without the file, every species uses the shared threshold. The
rule is `includedDetection` in `dashboard/src/components/detection-policy.js`,
and it matches `threshold()` in `pipeline/thresholds.py`. Species cards and the
Species page show each species' threshold, or that it's blocked, with its
review counts. People review the detections they doubt, not a random sample,
so a learned threshold is an estimate.

The dashboard links species photos from Wikimedia Commons instead of copying
them. Most photos are licensed CC BY-SA, so the dashboard shows each photo's
credit and license next to it. If you change the layout, keep the credit and
license visible.

## Design decisions

This section records decisions that shape the system and the reasons that the
repository documents for them.

- **Identify birds indoors.** Running BirdNET continuously outdoors on solar
  power through a Seattle winter needs a much larger panel and battery than
  recording does. The recorder records and sends audio, and the indoor
  computer runs BirdNET. For the power estimates, see the
  [recorder hardware options](design/hardware-design.html).
- **Serve the site from the Worker, not GitHub Pages.** GitHub Pages sites are
  public whatever the repository's visibility, so anyone who knows the address
  can bypass a password Worker placed in front of Pages. The Worker serves the
  site from its own static assets instead.
- **Run BirdNET without TensorFlow by default.** `birdnet-analyzer` imports
  TensorFlow on every start, which a 1 GB Raspberry Pi 3B+ can't afford. The
  `lite` engine runs the same model. In a comparison on five test recordings,
  it found the same 32 detections as `birdnet-analyzer`, with scores within
  0.005, and ran about six times faster.
- **Plain SQLite schema.** The schema avoids SQLite-specific features so that
  the same tables could move to Cloudflare D1. The pipeline doesn't use D1.

## Live species details and unidentified intervals

The Live popup's **More details** link opens the species page in a new tab, so
the Live player keeps playing. An earlier version embedded the species page in
an iframe pane; it was removed because embedding loads a second copy of the app
and breaks where the host forbids framing.
Incoming label text stays within the plot edge until its detection catches up;
underlines and seek positions retain their recording timestamps.

Live accepts optional `unidentified` intervals on strips, showing Unidentified
bird separately from species detections. These intervals have no species score,
species link or species review controls. Confident-only omits their Gantt row.
Older strips without the field remain compatible. The analyzer writes one
interval for each 3-second window that counts as unidentified birdsong
(`read_unidentified` in `pipeline/analyzer.py`), the same windows that the
per-minute `unidentified_windows` count includes.


## Overview data refresh

The Overview page checks published detection, recording and threshold file
versions at `OVERVIEW_REFRESH_MS` in
`dashboard/src/components/overview-refresh.js`. The password Worker answers
authenticated HEAD requests with R2 object metadata and no file body. Unchanged
ETags cause no table downloads or chart updates. Visibility changes and window
focus trigger an immediate check; hidden pages suspend periodic checks.

Changed resources load into one snapshot before the charts update. A failed
refresh keeps the last successful snapshot and retries. Built-in data is a
fallback for initial loading only. The calendar, confidence and sort controls,
category expansion choices and open options stay mounted during data updates.
The picker extends its available date bounds without resetting the selected
date or span. A brief scroll hold preserves the position through chart layout
and releases when you interact with the page.

The browser check interval is independent of the publisher's
`--detections-minutes` option in `pipeline/publish.py`. Checking more often does
not make the Pi upload new tables more often, and needs no Pi deployment.


## Live playback activity cues

Live species labels and the species rows below the spectrogram use a small
accent-green dot to identify detections at the playback position. The cue
follows the playhead during live viewing, historical playback and seeks.
`dashboard/src/components/live-activity.js` defines the detection window and
indexes its start times. Gaps inside a grouped label run don't count as active
calls. Multiple species can be active together.

The cue leaves confidence styling and manual reviews unchanged. Rejected
windows, non-bird sounds and unidentified labels don't light a species cue.
The dot sits outside the spectrogram label, leaving the name aligned with its
detection start. Viewport clamping and lane spacing reserve room for the dot
without shifting an otherwise aligned name. The pulse is steady
when playback is paused or reduced motion is requested. Activity changes use
`aria-current="time"` without announcing every playback frame.
