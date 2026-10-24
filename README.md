# Bird Tracker

A backyard mic records birds, [BirdNET](https://github.com/birdnet-team/BirdNET-Analyzer)
identifies them, and a dashboard shows what was heard and when. The dashboard
runs on simulated Seattle data for now. See [docs/hardware.md](docs/hardware.md)
for the recorder hardware and how data will get from the yard to the dashboard.

## Layout

```
pipeline/
  schema.sql      detections table (SQLite now, Cloudflare D1 later)
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

## Real BirdNET results

```bash
.venv/bin/birdnet-analyze recordings/ -o results/ --lat 47.61 --lon -122.33 --rtype csv
```

```bash
.venv/bin/python pipeline/ingest.py results/*.BirdNET.results.csv --station backyard
```

`ingest.py` takes each recording's start time from its filename, e.g.
`20260512T131500Z.flac` (UTC), or from `--start`.

## Deploying

`npm --prefix dashboard run build` writes a static site to `dashboard/dist`. It
can go to Cloudflare Pages (`npx wrangler pages deploy dashboard/dist`) behind
Cloudflare Access. Not set up yet.
