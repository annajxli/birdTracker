# Multi-station expansion plan

Planning baseline: October 26, 2026. This is a proposal, not a description of
an already deployed multi-station system. Keep planning decisions and revised
estimates in this document as the design develops.

## Deployment model

Each physically separate location has its own microphone, microcontroller and
indoor Raspberry Pi. The microcontroller streams over local Wi-Fi to that Pi;
the Pi runs BirdNET, stores results and publishes compressed media and metadata.
Raw continuous audio stays on the local network. Each Pi needs a durable upload
retry buffer so an internet outage doesn't lose completed work. Its size, retry
state and disk-full policy still need implementation and testing.

```text
Station A: mic → microcontroller → local Pi ─┐
Station B: mic → microcontroller → local Pi ─┼→ shared storage → one website
Station C: mic → microcontroller → local Pi ─┘
```

The existing detections and recordings tables already contain `station_id`.
The publisher and website still use single-station paths. Before connecting a
second station, isolate its media, exports, snapshots, reviews and cleanup under
an immutable station ID, such as `stations/<id>/live/`. A publisher must never
mirror or delete another station's files. Use credentials restricted to each
station's destination, or an authenticated upload service that enforces that
boundary. Review matching must include station identity too.

A station registry should hold ID, editable display name, coordinates, time
zone and active dates. Names can change without rewriting history. Coordinates
feed BirdNET, sunrise/sunset and weather; store timestamps in UTC and display
local time. Separate station identity from device identity so replacing a board
or Pi doesn't create a new location's history.

## Website proposal

Replace the header location text with a selector containing All locations,
each named station, and Manage locations. Preserve selection across pages and
include it in shareable URLs. Keep Overview, Live, Species and Hardware scoped
to the selected station. Live playback initially shows one station at a time.

All locations should summarize each station's recording freshness, coverage,
species, birdsong activity and hardware health. Shared name editing requires a
persistent authenticated write endpoint, not browser-only preferences.

Start comparison work with:

- Species by location: a heatmap of the fraction of recorded days a species was
  heard, with coverage visible.
- Activity by location: aligned plots over a shared period, including birdsong
  minutes per recorded hour and daily timing.

Normalize for recording effort, show offline periods as missing, and keep
confidence settings and microphone placement/settings comparable. Date selection
across different time zones must explicitly distinguish local calendar dates
from simultaneous UTC intervals. Publish small comparison summaries rather than
loading every station's full history into the browser.

## Privacy: filter human-like audio on each Pi before upload

User requirement: privacy filtering happens locally on each station's Pi,
**before any recording-derived material is uploaded**. Treat this as a rollout
prerequisite for additional sites, not an optional website playback setting.
This is a planned requirement; the current publisher does not implement it.

Add a local privacy stage before media is written into a publishable directory:

```text
recording → local human-voice detection → redaction → derived media → upload queue
                                      ↘ uncertain/failed: hold locally
```

Detect speech-like and other human vocal activity, then replace affected time
intervals with silence, with padding around the boundaries. Preserve duration
and timestamps so detections, playback and coverage remain aligned. Don't rely
on a gain reduction, denoising or Bird boost to make voices private. Start with
whole-interval muting rather than source separation that could leave intelligible
speech behind. The policy for laughter, shouting, singing and whistles should
be explicit; default conservatively for human vocalizations.

Apply the same redaction intervals to original playback, cleaned playback,
selected clips, and their spectrograms. Render derived assets only after
redaction; filtering the MP3 alone would still expose content in clips or images.
Here “original playback” means the privacy-filtered source before Bird boost,
not the raw mic recording. Don't upload transcripts or voice embeddings.

A recording becomes eligible for publishing only after the privacy stage marks
it complete. If detection fails, times out, is unavailable, or leaves a segment
uncertain, withhold the affected audio and derived media from upload. The
publisher should consume a dedicated sanitized output queue and have no raw-file
fallback. Recovery and retries must go through the same gate. Each station's Pi
owns this stage even if the destination is a home server instead of R2.

The existing BirdNET non-bird labels can contribute a signal, but are not by
themselves a validated privacy filter. Evaluate a dedicated local voice activity
detector and conservative combinations of signals on the actual Pi. No detector
guarantees that all human speech is caught. Test distant/quiet voices, voices
mixed with birds, short fragments, multiple speakers, television/radio, and
non-English speech, alongside bird calls that resemble voices. Measure missed
human audio, unnecessary muting of birds, processing time and memory; avoid
saving spoken test content in the repo or cloud.

Keep any raw audio needed for local analysis briefly on the Pi under an explicit
retention policy, then delete it; set a disk limit and decide whether owners may
opt out of local raw retention entirely. Record only operational audit fields
such as privacy-stage version, completion status and redacted seconds. Explain
redacted intervals in the Live UI and coverage data so they aren't mistaken for
network dropouts or an absence of birds. Decide how to flag/suppress bird
identifications in redacted intervals, especially human whistles misidentified
as birds. Revisit previously uploaded media separately: this new stage cannot
retroactively protect existing cloud copies.

## Retention and transfer assumptions

For continuous 32 kHz, 16-bit mono recording:

| Item | Per-station planning estimate |
| --- | ---: |
| Raw audio over local Wi-Fi | 5.5 GB/day |
| Original plus cleaned playback uploads | Approximately 1.1 GB/day |
| Seven days of both playback versions | Approximately 8 GB stored |
| Total storage allowance including other files | 10 GB |
| Upload/list API operations | 600,000/month |

The compressed estimate comes from the current MP3 encoding settings, not a
measurement of the account. Spectrogram sizes, clips, indexes and database
snapshots vary. Long-term selected clips and detection history grow beyond the
10 GB allowance; it is a starting budget, not a permanent cap.

Keep detections and coverage long term, summarize old telemetry, keep selected
clips, and expire continuous playback/spectrograms after seven days. Raw files
are currently deleted after analysis by default. Preserve files needed for any
pending publishing job before removing its source.

## Cloudflare cost model

Rates checked October 26, 2026 against [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
Recheck before purchasing or changing deployment plans. USD, before tax.
Allowances are shared across the account, including unrelated workloads.

| Resource | Included | Beyond included usage |
| --- | ---: | ---: |
| R2 Standard storage | 10 GB-month/month | $0.015/GB-month |
| R2 Class A (writes/listings) | 1 million/month | $4.50/million |
| R2 Class B (reads) | 10 million/month | $0.36/million |
| R2 egress bandwidth | Free | Free |
| Workers Free | 100,000 requests/day | Upgrade needed when limits are exceeded |
| Workers Paid | $5/month minimum; 10 million requests/month and 30 million CPU ms/month included | $0.30/million additional requests; $0.02/million additional CPU ms |

R2 rounds usage up to billing units, including whole million-operation units.
A small write overage can therefore add $4.50. R2 charges don't require a paid
Workers plan. This design runs inference on the Pi, not paid cloud inference.

The following steady-state 30-day model uses 10 GB stored and 600,000 Class A
operations per station; Class B stays within the allowance and Workers stays
free. These are scenarios, not measured bills.

| Stations | Storage | Storage charge | Class A charge | Total/month |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 10 GB | $0.00 | $0.00 | $0.00 |
| 2 | 20 GB | $0.15 | $4.50 | $4.65 |
| 3 | 30 GB | $0.30 | $4.50 | $4.80 |
| 5 | 50 GB | $0.60 | $9.00 | $9.60 |
| 10 | 100 GB | $1.35 | $22.50 | $23.85 |
| 20 | 200 GB | $2.85 | $49.50 | $52.35 |
| 50 | 500 GB | $7.35 | $130.50 | $137.85 |

Storage is approximately `max(0, ceil(10 × stations) - 10) × $0.015`;
Class A is `max(0, ceil(0.6 × stations) - 1) × $4.50`.
Actual storage is the month's average daily peak, so initial ramp-up differs.

Website traffic is separate from station count: direct Pi-to-R2 uploads do not
consume Worker requests. At an illustrative 5–10 requests/minute, a Live tab
left open 24 hours generates 7,200–14,400 Worker requests/day. Measure actual
browser traffic; audio ranges, polling and navigation affect this. Paid Workers
would add at least $5/month for the account, not per station.

Hardware, electricity, ISP service, domain registration, growing archives and
any other account usage are excluded. A starting budget for 3–5 stations is
$10–15/month, allowing for the Worker plan if needed. One station is approximately
within the free tier under this model, not guaranteed free indefinitely.

## Local reductions and measurement

The first implementation is in the local publisher changes documented in
[Publisher](../architecture.md#publisher): five-minute
review checks, five-minute historical index updates, and local daily usage
counters. This does not yet bundle audio, remove cleaned audio or change retention,
and isn't evidence of a particular measured saving.

Collect several complete days of `data/publish-usage.json` and compare with R2
metrics. The local counters record SDK API calls and attempted upload bytes;
they exclude automatic HTTP retries, downloads and website traffic. Track both
station publishing costs and viewer costs when evaluating the total.

Further options, in order of investigation:

1. Tune metadata and review polling from measured usage while preserving current
   playback freshness.
2. Test browser-side Bird boost against Pi-cleaned audio. Uploading only original
   audio could nearly halve continuous audio storage/bandwidth; equivalent sound
   quality and browser performance are unproven.
3. Bundle media and indexes into five-minute units. This reduces object writes
   but can delay availability. Keeping immediate minute files and later bundles
   adds writes, so that hybrid needs measurement rather than assumed savings.
4. Retain seven days locally but only one or two in cloud storage, if losing
   remote access to older continuous playback is acceptable.
5. Publish incremental data or partitioned exports as histories grow, with
   checkpoints and recovery so missed updates don't silently lose data.

A target of 200,000 Class A operations/month/station could fit about five
stations within the write allowance, but is an unvalidated optimization target.
Storage would still exceed the free allowance. Shorter retention alone reduces
storage, not the number of new uploads.

## Home server alternative

A home server can receive media/results from all station Pis, replace R2 as the
archive, and optionally serve the website. Keep analysis and buffering local to
each station so a central outage doesn't stop recording everywhere.

| Arrangement | Cloudflare's role | Main implication |
| --- | --- | --- |
| R2 plus Worker website | Storage and authenticated delivery | Current cloud model; independent of home server uptime |
| Home archive, cloud website | Website plus a route to home-hosted media | Media availability depends on home server and connectivity |
| Home archive and website | Optional public connection/authentication layer | R2 can be removed; home server handles serving and storage |
| Entirely self-hosted | None required | Must provide remote connectivity, TLS, authentication and maintenance |

Removing R2 removes its charges; keeping Cloudflare elsewhere does not guarantee
zero Cloudflare cost. Choose the remote access mechanism and verify its limits,
pricing and suitability for continuous audio before committing. No particular
Tunnel or other access product is selected in this plan.

Size the server for aggregate incoming media, playback traffic, retention and
backups. At current encoding, five stations upload roughly 5.5 GB/day of playback
audio before images and other data. Seven days of dual audio alone is about
40 GB; 30 days is about 165 GB. Long-term clips and backups add more. Home upload
bandwidth determines how many remote listeners can be served; home download
bandwidth receives the stations' uploads.

Plan authenticated encrypted uploads, per-station isolation, durable acknowledgments,
retry/backfill, disk monitoring, backups and recovery. Use the existing Pi local
SQLite databases as the source of truth initially; do not have multiple Pis
write one database file over the network. A home server isn't itself a backup.

## Rollout

1. Deploy and measure the initial publisher reductions on the existing station.
2. Implement and validate Pi-side privacy filtering and the sanitized upload gate.
3. Choose R2 or a home archive from observed usage and desired availability.
4. Implement station registry, isolated publishing and station-aware reads/reviews.
5. Add a second physical station, test interrupted uploads and independent cleanup.
6. Add the website selector, shared name editing and All locations summary.
7. Build comparisons using real coverage from both locations.

Pi-side privacy filtering, home hosting, media bundling, browser Bird boost and multi-station support remain
proposals. No home server or additional station has been provisioned by this work.
