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
| Indoor computer | Raspberry Pi 3B+ running the receiver, analyzer, and publisher. Deployed October 25, 2026. The deployed commit isn't recorded. | [Set up the indoor computer](deploy.md#set-up-the-indoor-computer) |
| Recorder | FireBeetle 2 ESP32-E with the bench firmware in `firmware/recorder_test/`, mounted outdoors. Deployed October 25, 2026. The firmware commit isn't recorded. | [Recorder hardware](hardware.md) |

## Deployment log

Add one dated line per deployment, newest first. Include the commit and the
host alias. Don't include secrets.

- October 25, 2026: Raspberry Pi 3B+ pipeline and outdoor FireBeetle 2 ESP32-E recorder. Commits not recorded.

## Open checks

### Indoor computer on a Raspberry Pi 3B+

- **Speed.** The analyzer must process each minute of audio, including its
  spectrogram and MP3 copies, in well under a minute. If the Pi can't keep up,
  reduce the threads that compete with the receiver. A smaller model is
  another option, but `birdnet_lite.py` supports only the FP32 model.
- **Temperature.** The 3B+ slows down when it's hot. Check
  `vcgencmd measure_temp` under load.
- **SD card wear.** The analyzer writes the database and live strips
  constantly. A high-endurance card or a USB SSD for `data/` lasts longer.

### Dashboard counting

Simulated data, not real recordings, set the counting choices. Check them
against real recordings. For details, see
[How the dashboard counts](architecture.md#how-the-dashboard-counts).

### Recorder hardware

Bench test 2 measures power and decides the board. For its plan, see
[Bench test 1](bench-test-1.md#plan-for-bench-test-2).

### Plans for more stations and microphones

Neither plan is built or tested:

- [Indoor computer options](plans/indoor-computer-options.md): copy the Pi 3B+
  setup after the indoor computer checks above pass.
- [Microphone options](plans/microphone-options.md): candidate microphones and
  how to compare them.

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
edge makes it follow again. The 3-day window loads up to three days of strips;
its performance with real data hasn't been checked. The overview's dates sit
higher, clear of the view outline, and the raster's unidentified tooltip reads
*Unidentified*. Not yet checked in a browser.

### Overview trailing selection

Overview date and span persist in URL parameters across refreshes. W/M/Y use
trailing ranges ending on the selected date, including blank history before
available recordings. Calendar selection chooses the end date. Dashboard tests
and the site build pass. Deployment follows the automatic main workflow.
