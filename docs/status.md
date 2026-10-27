# Status

This page is the only place in the repository that records what is deployed,
what is in progress, and what is unverified. Other pages describe how the
system works and link here for status. When you deploy, merge, or finish a
check, update this page in the same commit.

Last reviewed: October 26, 2026.

## Deployed

The following table lists the deployed components:

| Component | State | Source |
| --- | --- | --- |
| Website | Served by the password Worker at `birds.annajxli.com`. Set up October 23 to 24, 2026. GitHub Pages is off, DNS points to `100::`, **Always Use HTTPS** is on, and the `PASSWORD` and `SESSION_KEY` secrets are set. | [Deploy the website](deploy.md#deploy-the-website) |
| R2 bucket | `birdtracker-media`. | [Create the R2 bucket](deploy.md#create-the-r2-bucket) |
| Indoor computer | Raspberry Pi 3B+ (`pio`) running the receiver, analyzer, and publisher, at `c9d5827` since October 26, 2026. Its power supply is too weak: `vcgencmd get_throttled` reports under-voltage. | [Set up the indoor computer](deploy.md#set-up-the-indoor-computer) |
| Recorder | FireBeetle 2 ESP32-E with the bench firmware in `firmware/recorder_test/` at `6c6c8fe`, flashed October 25, 2026. On a power bank, in a screened window rather than outdoors, during rain since the evening of October 25. | [Recorder hardware](hardware.md) |

## Deployment log

Add one dated line per deployment, newest first. Include the commit and the
host alias. Don't include secrets.

- October 26, 2026: `c9d5827` to `pio`: counts of birdsong windows and unidentified birdsong per minute.
- October 26, 2026: `432e9b9` to `pio`: detection reviews applied by the publisher.
- October 25, 2026: `65f7b38` to `pio`: non-bird sounds veto birds and are listed on Live strips.
- October 25, 2026: `3f803ab` to `pio`: the Bird boost cleaning keeps BirdNET's detection windows.
- October 25, 2026: `7f9baf3` to `pio`: frame counts in `recordings.parquet`.
- October 25, 2026: `19f810c` to `pio`: a week of Live strips in day files. Recorder firmware `6c6c8fe` flashed: frame counts in its health reports.
- October 25, 2026: `e47e1f0` to `pio`: Live strips are made on a background thread.
- October 25, 2026: `54f3c1d` to `pio`: a cleaned Live MP3 for Bird boost.
- October 25, 2026: `8369752` to `pio`, and recorder firmware `8369752` flashed: the recorder's temperature, uptime, and signal strength.
- October 25, 2026: `d08bbd7` to `pio`: a recorder telemetry row per minute.
- October 25, 2026: `3598a74` to `pio`: BirdNET on TFLite in batches of 4.
- October 25, 2026: first Raspberry Pi 3B+ pipeline and outdoor FireBeetle 2 ESP32-E recorder. Earlier commits weren't recorded.

## Open checks

### Indoor computer on a Raspberry Pi 3B+

- **Speed.** The analyzer must process each minute of audio, including its
  spectrogram and MP3 copies, in well under a minute. On October 26, 2026, at
  `c9d5827`, it stored each minute's detections about 32 to 36 seconds after the
  minute ended, with no backlog, and used about 23% of the CPU over a minute. If the Pi can't keep up,
  reduce the threads that compete with the receiver. A smaller model is
  another option, but `birdnet_lite.py` supports only the FP32 model.
- **Temperature.** The 3B+ slows down when it's hot. Check
  `vcgencmd measure_temp` under load. On October 25 and 26, 2026, it read 53 to
  60 °C on an open riser. An enclosed cabinet needs a check of its own.
- **Power.** `vcgencmd get_throttled` reports under-voltage and throttling
  with the current power supply. Replace it with a 5 V, 2.5 A supply, and check
  again.
- **SD card wear.** The analyzer writes the database and live strips
  constantly. A high-endurance card or a USB SSD for `data/` lasts longer.

### Dashboard counting

Simulated data, not real recordings, set the counting choices. Check them
against real recordings. For details, see
[How the dashboard counts](architecture.md#how-the-dashboard-counts).

### Recorder hardware

Bench test 2 measures power and decides the board. For its plan, see
[Bench test 1](bench-test-1.md#plan-for-bench-test-2).

### Plans

None of these plans is built or tested:

- [Indoor computer options](plans/indoor-computer-options.md): copy the Pi 3B+
  setup after the indoor computer checks above pass.
- [Microphone options](plans/microphone-options.md): candidate microphones and
  how to compare them.
- [E-paper display](plans/eink-display.md): a color screen that shows what's
  being heard.
- [Painted species art](plans/species-art.md): paintings as the default species
  pictures.
- [Feeder camera](plans/feeder-camera.md): a window feeder with a camera, matched
  to detections.

## Work on other branches

The following branches change documentation that isn't on `main`. When you
merge one, move its documentation into the structure in
[AGENTS.md](../AGENTS.md#documentation), as the migration column says, and then
delete its row.

The following table lists the branches and where their documentation goes:

| Branch | State | Documentation migration |
| --- | --- | --- |
| `codex/publisher-usage-reduction` | Implemented, checked locally, not deployed. | `docs/publisher-handoff.md`: deployment steps into [Deploy](deploy.md); the deployment record into the [deployment log](#deployment-log). Additions to `docs/deploy.md` about publisher usage stay in `deploy.md`; the parts that describe behavior move to [Architecture](architecture.md). `docs/multi-station-plan.md`: see the next row. |
| `codex/privacy-and-home-server` | Contains the publisher branch. Evaluation only. Don't merge or deploy it whole: its privacy filter fails the synthetic chirp check. | `docs/multi-station-plan.md` to `docs/plans/multi-station.md`. `docs/home-server-spec.md` to `docs/plans/home-server.md`. `docs/privacy-filter.md` and `docs/privacy-public-results.json` to `docs/plans/privacy-filter.md` and its results file. `docs/station-isolation.md`: implemented behavior into [Architecture](architecture.md), station configuration into [Deploy](deploy.md), and rollout limits into this page. `CONTRIBUTING.md` into [AGENTS.md](../AGENTS.md). README additions into the README's documentation map. |
| `codex/ui-live-polish` | Live page changes. | `CONTRIBUTING.md` into [AGENTS.md](../AGENTS.md). |

### Live details update

The Live UI supports edge-clamped labels, centered mute text, and unidentified
intervals. The embedded species pane was removed; the popup's **More details**
link now opens the species page in a new tab. A native drawer, rendered from data
Live already loads, remains an option if a new tab proves clumsy. The analyzer export is a separate pending update;
no Pi deployment has happened, so existing production strips don't gain
unidentified intervals. Site deployment is automatic after merging this update.
Dashboard tests and build pass; browser interaction verification remains open.

The Live spectrogram's scroll range now matches the overview window: 1 hour at
the 1-minute span, 6 hours at 5 minutes, 24 hours at 15 minutes, and 3 days at
1 hour. Before, it started at the last hour and grew as you jumped back. The
**‹** and **›** buttons move the window, and playing past a stepped window's
edge makes it follow again. Only the part near the view is fetched and drawn:
older days' strips load as the view nears them, spectrograms paint near the
view, and labels away from it are skipped. Performance with real data hasn't
been checked. The overview's dates sit
higher, clear of the view outline, and the raster's unidentified tooltip reads
*Unidentified*. Not yet checked in a browser.

### Overview trailing selection

Overview date and span persist in URL parameters across refreshes. W/M/Y use
trailing ranges ending on the selected date, including blank history before
available recordings. Calendar selection chooses the end date. Dashboard tests
and the site build pass. Deployment follows the automatic main workflow.
