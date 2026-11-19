# Multi-station expansion

This page proposes recording at more than one location. Nothing on it is
built. Estimates date from October 26, 2026.

## Deployment model

Each location has its own microphone, microcontroller, and indoor computer.
The recorder streams over local Wi-Fi to that computer, which runs BirdNET and
publishes compressed media and metadata. Raw audio stays on the local network.
Each indoor computer needs a durable upload buffer, so an internet outage
doesn't lose work.

```text
Station A: mic → microcontroller → local Pi ─┐
Station B: mic → microcontroller → local Pi ─┼→ shared storage → one website
Station C: mic → microcontroller → local Pi ─┘
```

For each new station, copy the working Raspberry Pi 3B+ setup. Other boards
aren't benchmarked with this pipeline. A Pi Zero 2 W, with 512 MB of RAM,
isn't a drop-in replacement: the model's peak memory is a large share of that.
Before you switch boards, measure peak memory, swap, time per minute of audio,
backlog, and temperature on the board itself.

## Station isolation

The `detections` and `recordings` tables have `station_id`, but the publisher
and website use single-station paths. Before a second station connects:

- Put each station's media, exports, snapshots, reviews, and cleanup under an
  immutable ID, such as `stations/ID/live/`. A publisher never mirrors or
  deletes another station's files, and its credentials reach only its own
  prefix.
- Keep a station registry with ID, display name, coordinates, time zone, and
  active dates, separate from device identity, so replacing a board doesn't
  start a new history.

## Website

- A location selector in the header, kept across pages and in URLs, with an
  All locations summary of freshness, coverage, species, activity, and health.
- Comparisons that normalize for recording effort and show offline periods as
  missing: species by location as a heatmap, and activity by location over a
  shared period.

## Privacy filtering before upload

Each station's computer mutes human voices before any recording-derived
material is uploaded. This is a prerequisite for additional sites.

- Detect speech and other human vocalizations with a local voice activity
  detector, and replace those intervals, with padding, by silence. Keep
  duration and timestamps.
- Apply the same intervals to playback, clips, and spectrograms, and render
  them only after redaction.
- Publish only from a sanitized queue. If detection fails or is uncertain,
  hold the audio locally.
- Test with distant, quiet, overlapping, broadcast, and non-English voices,
  and with bird calls that resemble voices. Don't store spoken test audio in
  the repository or the cloud.
- Show redacted intervals in the Live page and coverage data, so they aren't
  mistaken for outages.

## Storage and cost

For continuous 32 kHz, 16-bit mono recording, each station sends about
5.5 GB of raw audio a day over local Wi-Fi and uploads about 1.1 GB of
playback MP3s. A planning budget per station is 10 GB of storage, with seven
days of playback, and 600,000 R2 Class A operations a month.

At [R2 pricing](https://developers.cloudflare.com/r2/pricing/) checked October
26, 2026, the free tier covers about one station. Beyond it, storage costs
$0.015 per GB-month and Class A operations $4.50 per million, so 3 to 5
stations cost roughly $5 to $10 a month, plus $5 a month if website traffic
needs [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/).
Check usage with `data/publish-usage.json` before you rely on these numbers.

Ways to reduce cost, to measure first:

1. Tune metadata and review polling.
2. Apply Bird boost in the browser instead of uploading cleaned audio.
3. Bundle media into 5-minute units.
4. Keep less history in the cloud than locally.

## Home server alternative

A home server could receive every station's results and replace R2, or also
serve the website. Keep analysis and buffering on each station's computer, so a
server outage doesn't stop recording. Five stations upload about 5.5 GB of
playback audio a day. Plan authenticated uploads, per-station isolation,
retries, disk monitoring, and backups, and keep each station's SQLite
database as its source of truth.

## Rollout

1. Measure publisher usage on the existing station.
2. Build and validate privacy filtering before upload.
3. Choose R2 or a home server.
4. Add the station registry and isolated publishing.
5. Add a second station, and test interrupted uploads.
6. Add the website selector and comparisons.
