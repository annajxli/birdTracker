# Bird Tracker

A backyard mic records birds, [BirdNET](https://github.com/birdnet-team/BirdNET-Analyzer)
identifies them, and a dashboard shows what was heard and when. The dashboard
runs on simulated Seattle data for now. See [docs/hardware.md](docs/hardware.md)
for the recorder hardware and how data will get from the yard to the dashboard.

## Layout

```
pipeline/
  schema.sql      detections table (SQLite now, Cloudflare D1 later)
  analyzer.py     watch for new recordings, run BirdNET, store detections and clips
  ingest.py       load BirdNET-Analyzer CSV results into the database
  occurrence.py   species x week likelihoods for our location, from BirdNET's location model
  simulate.py     a year of realistic fake detections, for building the dashboard
  species_images.py  photo + credit/license per species from Wikipedia/Commons
  species_categories.py  rough category per species (songbirds, raptors, ...) from the eBird taxonomy
  weather.py      daily high/low, rain and weather code from Open-Meteo
dashboard/        Observable Framework static site; Python data loaders read the database
data/
  occurrence.csv  output of occurrence.py (checked in)
  species_images.json  output of species_images.py (checked in)
  species_categories.csv  output of species_categories.py (checked in)
  weather.csv     output of weather.py; re-run when new detections arrive
  detections.sqlite  generated, not checked in
docs/hardware.md  hardware and data transfer plan
docs/palettes.html  theme palette options (Cedar & Olive was picked)
```

## Setup

Requires Python 3.11+ and Node 18+.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
npm --prefix dashboard install
```

## Generate data and run the dashboard

```bash
.venv/bin/python pipeline/simulate.py
```

```bash
npm --prefix dashboard run dev
```

Then open http://localhost:3000. To rebuild the species table for a different
location, run `pipeline/occurrence.py --lat … --lon …`. The first run downloads
the BirdNET model (~220 MB).

Species photos come from Wikimedia Commons and are linked, not copied. Most
are CC BY-SA, so the dashboard shows each photo's credit and license next to
it; keep that if you change the layout.

## Real recordings

`pipeline/analyzer.py` is the indoor half of the setup in `docs/hardware.md`.
The recorder drops audio files into `data/incoming/`, named by their UTC start
time (e.g. `20260512T131500Z.flac`). For each one the analyzer runs BirdNET
with the station's location and week, adds the detections to the database,
and cuts a 5-second Opus clip of the most confident detection of each species
per hour into `data/clips/`. Finished recordings move to `data/processed/` and
are deleted after `--keep-days` (default 3); unreadable or misnamed ones go to
`data/failed/`.

```bash
.venv/bin/python pipeline/analyzer.py --watch
```

Use `--once` to process what's waiting and exit. Clips aren't shown on the
dashboard yet; they'll be served from Cloudflare R2 once that's set up.

To load results from running BirdNET-Analyzer by hand instead:

```bash
.venv/bin/birdnet-analyze recordings/ -o results/ --lat 47.61 --lon -122.33 --rtype csv
```

```bash
.venv/bin/python pipeline/ingest.py results/*.BirdNET.results.csv --station backyard
```

`ingest.py` takes each recording's start time from its filename, e.g.
`20260512T131500Z.flac` (UTC), or from `--start`.

## Deploying

GitHub Actions builds the site and publishes it to GitHub Pages, on a
subdomain behind a shared password (a small Cloudflare Worker). Setup steps
are in [docs/deploy.md](docs/deploy.md).
