# Per-species confidence thresholds

This page proposes a confidence threshold for each species, learned from
people's reviews, instead of one shared threshold. Nothing on it is built. The
reviews it learns from are collected, as
[Architecture](../architecture.md) describes.

## Why one threshold doesn't fit

The dashboard counts a detection when its BirdNET confidence reaches one
threshold for every species: `LIVE_MIN_CONF` in `pipeline/analyzer.py`, the
`MIN_CONF` constants in `dashboard/src/live.md` and
`dashboard/src/display.md`, and the confidence control on the Overview and
Detections pages. A confirmed review always counts, and a rejected one never
does (`includedDetection` in `dashboard/src/components/detection-policy.js`).

The reviews on the indoor computer on October 27, 2026, show how far apart
species are:

| Species | Confirmed | Rejected | Lowest confirmed confidence | Highest rejected confidence |
| --- | --- | --- | --- | --- |
| Northern Saw-whet Owl | 0 | 210 | | 0.99 |
| House Finch | 12 | 0 | 0.27 | |
| Peregrine Falcon | 0 | 10 | | 0.91 |
| Common Loon | 0 | 9 | | 0.88 |
| Northern Pygmy-Owl | 0 | 4 | | 0.52 |
| American Crow | 3 | 0 | 0.47 | |
| Bushtit | 2 | 0 | 0.34 | |

House Finch is right far below the shared threshold, so the dashboard misses
many of its calls. Northern Saw-whet Owl, Peregrine Falcon, and Common Loon
are wrong even at high confidence, so no threshold below 1 removes them. A
recurring sound near the recorder probably matches the owl.

## How thresholds are learned

For each species, a learner reads the reviewed detections and picks one of
three outcomes:

- **Learned threshold.** The species has at least `MIN_REVIEWS` reviews, and
  some threshold *t* keeps at least `TARGET_PRECISION` of the reviewed
  detections at *t* or above correct. The threshold is the lowest such *t*,
  and never below BirdNET's own cutoff, `--min-conf` in
  `pipeline/analyzer.py`. With the reviews above and a precision target of
  90%, House Finch would get a threshold of about 0.27.
- **Blocked.** The species has at least `MIN_REVIEWS` reviews, and no
  threshold reaches `TARGET_PRECISION`. Its detections count only when a
  person confirms one. Northern Saw-whet Owl, Peregrine Falcon, and Common
  Loon would be blocked.
- **Default.** The species has too few reviews. It keeps the shared
  threshold.

Starting values: `MIN_REVIEWS` of 10 and `TARGET_PRECISION` of 0.9, as
constants in the learner. Bushtit and American Crow stay on the default until
they have more reviews.

People review the detections they doubt, not a random sample, so a learned
threshold can be too strict or too loose. To check it, the Live page can ask
for a review of a few detections a day just above and below each learned
threshold, as a later step.

## Where thresholds are applied

1. **The learner** runs in the publisher on the indoor computer, where the
   database is, each time it applies new reviews. It writes
   `live/thresholds.json`: for each species with a learned threshold or a
   block, the outcome, the review counts, and when it was learned. The
   publisher uploads it with `reviews.json`.
2. **The analyzer** reads the same file, so that a window counts as
   unidentified birdsong only when no species reaches its own threshold.
   Without this, a House Finch call at 0.3 counts as unidentified.
3. **The dashboard** loads `thresholds.json` beside `reviews.json`.
   `includedDetection` uses a species' learned threshold, blocks blocked
   species, and uses the confidence control for default species. The species
   card or the Hardware analytics page lists the learned thresholds and
   blocks, so a reader can see why a species appears or doesn't.

A species' threshold changes only when its reviews change, so counts on past
days change too. That's intended: a review corrects the past as well as the
future.

## Steps

1. Write the learner in `pipeline/thresholds.py`, with tests for the three
   outcomes and for the review counts above.
2. Call it from the publisher, and upload `thresholds.json`.
3. Use the file in the analyzer's unidentified-birdsong count.
4. Use the file in `includedDetection`, the Live page, and the display, and
   list the thresholds on a dashboard page. This step belongs to whoever owns
   the dashboard pages.
5. Deploy, and record in [Status](../status.md) each species' outcome on the
   deployment day.
6. After two weeks of reviews, compare each learned threshold with a sample
   of detections just above and below it, and adjust `MIN_REVIEWS` or
   `TARGET_PRECISION` if needed.

## Out of scope

- **Retraining BirdNET** or training a custom classifier on reviewed clips.
- **Location and season.** BirdNET's location filter already limits species
  by week. The learner doesn't change it.
- **The birdsong bar,** `ANY_BIRD` in `pipeline/analyzer.py`. It needs
  labels for windows that BirdNET doesn't name, which reviews don't give.
