# Hardware and data flow

Recommendations for the outdoor recorder and for getting data from it to the
dashboard. Prices and power figures are rough estimates to size things, not
quotes. Measure your own setup once it's built.

**Block diagrams, choice-by-choice pros and cons, and parts lists** for the
low-power (ESP32-S3 / nRF5340, mono or stereo) and Pi builds are in
[hardware-design.html](hardware-design.html); open it in a browser.

## TL;DR

**Keep the outdoor box small and dumb. Do the bird ID indoors.**

- **Outside:** a Raspberry Pi Zero 2 W, a good mic, a small solar panel and a
  12 V LiFePO4 battery. It only records audio and uploads it over wifi.
- **Inside:** any always-on machine on wall power (a Pi 5, an old laptop, a
  NAS) runs BirdNET-Analyzer on the uploaded files. This is the Python code in
  this repo.
- **Cloud:** the indoor box sends detections (and optional clips) to a
  Cloudflare Worker, which stores them in D1 (and R2). The dashboard on
  Cloudflare Pages reads from there, behind Cloudflare Access.

```
 [mic] -> Pi Zero 2 W ---wifi, FLAC files---> indoor box ---HTTPS---> Cloudflare
          (solar)        (rsync, every min)   BirdNET +     (JSON)    Worker -> D1
                                               ingest.py              R2 (clips)
                                                                      Pages dashboard
```

The reason is **Seattle winters**. Running BirdNET 24/7 outdoors on solar is
much harder than recording on solar.

## Power: why not run BirdNET outside?

| Outdoor device | Avg draw | Per day | Solar needed for a Seattle winter |
| --- | --- | --- | --- |
| Pi 4/5 running BirdNET continuously | ~4–6 W | ~100–150 Wh | ~200–300 W panel + ~100 Ah battery, and it may still go dark in long gray spells |
| Pi Zero 2 W recording + uploading | ~0.7–1.2 W | ~20–30 Wh | ~50 W panel + 12 V 20 Ah LiFePO4 (~250 Wh, roughly 8–10 days of reserve) |
| ESP32-S3 + I2S MEMS mic, streaming | ~0.4–0.8 W | ~10–20 Wh | smaller still, but needs custom firmware |

In December Seattle averages roughly 1 "peak sun hour" a day, and much less
during a week of solid overcast. A 50 W panel then gives maybe 20–35 Wh on an
average day, which is about what a Zero 2 W uses. The battery covers the gray
stretches. The simulated data already includes winter days where the battery
runs out, so the dashboard has to cope with gaps.

**About the Eufy camera:** its staying at 100% all year is a good sign that the
spot gets usable winter light. But a battery camera sleeps most of the time and
only wakes on motion, so it averages roughly 0.1–0.3 W. That's 3–10× less
than even the Zero 2 W recorder, which never sleeps. So the spot is good, but
the recorder still needs its own bigger panel and battery. That spot makes the
50 W / 20 Ah setup above likely to have comfortable margin. It doesn't make
running BirdNET outdoors on a Pi 4/5 realistic.

**Before buying solar, check whether you can run a cable.** If the mic can be
within ~5–10 m of an outlet or a window, the cheapest and most reliable setup
is a mic on a long cable outside and a Pi indoors on wall power. Then there's no
solar and no wifi hop, and BirdNET can run right on that Pi.

## Recommended parts (solar version)

**Recorder**

- **Raspberry Pi Zero 2 W** (~$15) with a 32–64 GB high-endurance microSD. The
  SD card buffers audio while wifi is down.
- **Mic:** an EM272-capsule mic such as the Micbooster "Clippy EM272" (USB or
  3.5 mm with a USB sound card) is the standard pick among BirdNET-Pi users.
  It's quiet and sensitive enough for distant birds. A Boya BY-LM40 (~$20) plus
  a cheap USB sound card is a fine budget start.
- **Weatherproofing:** IP65 junction box for the electronics, foam windscreen
  plus a "dead cat" fur cover on the mic, and the mic facing down under a small
  rain hood. Rain hitting the mic makes noise that drowns out birds.
- **Placement:** 2–4 m up, away from the house wall, the HVAC unit and the
  street. Point it at the shrubs or trees where birds hang out.

**Power**

- 50 W 12 V panel, facing south and tilted steeply (~60°) for winter sun
  (~$60).
- 12 V 20 Ah LiFePO4 battery (~$80). It handles cold and lots of charge cycles
  better than lead-acid.
- Small MPPT charge controller, e.g. Victron SmartSolar 75/10 (~$60). It has
  Bluetooth, so you can check battery state.
- 12 V→5 V buck converter (~$10) to power the Pi.

**Indoor analyzer:** a Raspberry Pi 5 (4 GB+) or any always-on computer. On
this Mac, BirdNET analyzed 2 minutes of audio in about 3 s, so even a Pi
keeps up with 24/7 recording easily.

## Data transfer

### 1. Recorder → indoor box: chunked FLAC files over rsync (recommended)

- Record continuously in **1-minute FLAC files at 48 kHz mono** (BirdNET's
  native rate). Name each file with its UTC start time, e.g.
  `20260512T131500Z.flac`. `pipeline/ingest.py` already reads timestamps from
  that pattern.
- A cron job or systemd timer **pushes finished files with `rsync` over SSH**
  every minute, then deletes the local copies that were sent. rsync writes
  each file under a temporary name and renames it when complete, which is what
  the analyzer expects: it ignores names that don't end in an audio extension
  (e.g. `.flac.part`) and waits for a file's size to hold still. Anything
  else that copies files in should do the same.
- Why files instead of a live stream: wifi blips just delay uploads instead of
  losing audio, and a backlog catches up on its own.
- Bandwidth: 48 kHz 16-bit mono is ~8 GB/day raw, or ~3–4 GB/day as FLAC.
  That's fine on home wifi. It also costs power, so if the battery is tight,
  record at 48 kHz but only keep files around dawn, dusk and night peaks.
- **Clock:** timestamps come from the recorder, so keep its clock correct. Use
  NTP (`chrony`). A Zero has no real-time clock, so add a ~$5 RTC module if it
  will ever boot without wifi.

### 2. Indoor box: analyze, ingest, clip

A small Python service (to be built here) watches the incoming folder and, for
each file:

1. runs BirdNET-Analyzer (`--lat 47.61 --lon -122.33 --week N`)
2. ingests results the way `ingest.py` does
3. cuts a short clip (3–6 s, Opus, ~10–20 KB) for the best detection of each
   species per hour (`birdnet-segments` does this)
4. deletes raw audio after a few days unless something interesting was in it

### 3. Indoor box → Cloudflare: HTTPS POST to a Worker

- `POST /api/detections` with a JSON batch of rows (same columns as
  `pipeline/schema.sql`) and an `Authorization: Bearer <token>` header. The
  token is a Worker secret. The Worker inserts rows into **D1**. The
  `UNIQUE (station_id, detected_at, scientific_name)` key makes retries
  safe, so just resend on failure.
- Clips go to **R2** through the same Worker (`PUT /api/clips/<key>`). R2's free
  tier (10 GB) holds hundreds of thousands of short clips.
- I'd skip MQTT and similar. Plain HTTPS batches every few minutes are simpler
  and Cloudflare handles them natively.

### 4. Dashboard

- **Now:** the dashboard is a static site built from the SQLite database by
  Python data loaders.
- **Once real data flows:** either rebuild on a schedule (a GitHub Action reads
  D1 every hour or night and deploys to Pages; a deploy hook gives you a
  "refresh now" button), or have the page query the Worker directly for
  always-current data. Start with the scheduled rebuild because it's simpler,
  and switch if hourly feels stale.
- **Access:** put the Pages site behind **Cloudflare Access** (free for small
  groups) with a one-time code by email for the household. To share, add
  someone's email, or make a separate public page with no clips.

## Live listening (later)

Possible, but it costs power on the recorder. The recorder would also run an
audio stream (e.g. `mediamtx` serving RTSP, ~0.3–0.5 W extra). The indoor box
would expose it through a **Cloudflare Tunnel** behind the same Access login.
BirdNET-Go can analyze an RTSP stream directly and has a live-audio player, so
it's worth a look if you want this. A good approach is to make it on-demand:
the stream only runs while someone is listening.

## Does more than one station help?

Some, but it's not needed to start. A second mic covering different habitat
(front yard vs. back, trees vs. feeder) picks up birds the first one misses.
Two mics hearing the same bird also back up each other's detections. Everything
already has a `station_id`, so adding one later is just more data.

## Counting individual birds (stereo, later)

BirdNET says whether a species is in each 3-second segment, not how many are
singing, so two wrens singing at once look the same as one. A stereo
recorder can put a floor under that count:

- **How:** two mics about 20–30 cm apart, recorded as one stereo file. A sound
  reaches one mic up to ~1 ms before the other, and that delay gives its
  direction (cross-correlate the two channels around each detection, a
  standard technique called TDOA). If the same species is heard from two
  clearly different directions in the same few seconds, there are at least
  two birds.
- **What it would add:** a "min. birds" number per bout, and a "2+ singing"
  marker on the daily timeline.
- **Hardware impact:** cheap (~$10 for a second mic), but decide before
  building. The board needs two mic inputs: a stereo USB interface on a Pi,
  or two I2S/PDM MEMS mics on an ESP32 or nRF5340 (both support a stereo
  pair). Both mics need the same rain hood and wind fur.
- **Limits:** direction only, not distance, and only in the plane of the two
  mics; two birds in the same direction still look like one. Reflections off
  the house and fences add false directions. Treat it as a minimum, not a
  count.
- **Without stereo:** if a species' typical song length is known, a second
  song starting before the first ends also means 2+. That works with one mic
  but is fragile; worth trying in the analysis first.
