# Status

This page is the only place in the repository that records what is deployed,
what is in progress, and what is unverified. Other pages describe how the
system works and link here for status. When you deploy, merge, or finish a
check, update this page in the same commit.

Last reviewed: October 27, 2026.

## Deployed

The following table lists the deployed components:

| Component | State | Source |
| --- | --- | --- |
| Website | Served by the password Worker at `birds.annajxli.com`. Set up October 23 to 24, 2026. GitHub Pages is off, DNS points to `100::`, **Always Use HTTPS** is on, and the `PASSWORD` and `SESSION_KEY` secrets are set. | [Deploy the website](deploy.md#deploy-the-website) |
| R2 bucket | `birdtracker-media`. | [Create the R2 bucket](deploy.md#create-the-r2-bucket) |
| Indoor computer | Raspberry Pi 3B+ (`pio`) running the receiver, analyzer, and publisher, at `cbc9041` since October 27, 2026. Its power supply is too weak: `vcgencmd get_throttled` reports under-voltage. | [Set up the indoor computer](deploy.md#set-up-the-indoor-computer) |
| Recorder | FireBeetle 2 ESP32-E with the bench firmware in `firmware/recorder_test/` at `6c6c8fe`, flashed October 25, 2026. On a power bank, in a screened window rather than outdoors, during rain since the evening of October 25. | [Recorder hardware](hardware.md) |

## Deployment log

Add one dated line per deployment, newest first. Include the commit and the
host alias. Don't include secrets.

- October 27, 2026: `cbc9041` (`main`) to `pio` with `push.sh`: the fix for reading the next install time. Verified the same morning: the three services are active, and the update check reports `next_install` as `2026-11-01T11:30:00Z`. To roll back, run `push.sh` from `d1aa066`.
- October 27, 2026: `d1aa066` (`main`) to `pio` with `push.sh`: the weekly install limited to security updates (`unattended-upgrades` with `deploy/pi/52birdtracker-unattended-upgrades`). Verified the same morning: the three services are active, both timers are scheduled, the apt configuration allows only `trixie-security`, and a dry run of `unattended-upgrade` found nothing to install. To roll back, run `push.sh` from `07141fd`.
- October 27, 2026: `07141fd` (`main`) to `pio` with `push.sh pio@192.168.0.113`: the weekly operating system install (`birdtracker-upgrade.timer`, running `apt-get full-upgrade`), and the Overview and Hardware analytics changes through #27. Verified the same morning: the three services are active, both timers are scheduled (install Sunday, November 1, 2026, at 3:30 AM PST), `deployed.json` reports `07141fd` with no uncommitted changes, and the update check found 0 upgradable packages. The check's `next_install` was empty, from a bug in reading the timer; the fix is on `claude/next-install-json`. To roll back, run `push.sh` from `b77256c`.
- October 26, 2026: `b77256c` (branch `claude/pi-update-check`) to `pio` with `push.sh`: the deployed code version in `deployed.json`, and the weekly operating system update check (`birdtracker-updates.timer`). Verified the same evening: the three services are active, the timer is scheduled, the first check finished in about a minute and found 21 upgradable packages, 11 of them security updates, with no reboot required, and `status.json` includes `code` and `updates`. The Hardware analytics page doesn't show them yet. To roll back, run `push.sh` from `301a84b`.
- October 26, 2026: `a9b92cd` to `pio` with `push.sh`, no service overrides. That commit was later rebased; its deployed code matches the merge of `claude/publisher-deploy`: the publisher checks reviews and uploads Live day files at its `--reviews-seconds` and `--history-seconds` defaults, and counts R2 usage. Includes `main`'s spectrogram fix. Verified the same evening: a new minute's spectrogram, MP3s, and `live.json` reached R2 about a minute after the minute ended, as before, with `live.json` last; `days.json` and the day file updated 5 minutes after the first pass; a test review put straight into `reviews/` was applied within 5 minutes; `data/publish-usage.json` is valid, grew, and kept its totals across a publisher restart, and no usage file is in the bucket. Not verified: a review sent through the website. Playback in a browser was verified later on October 26. To roll back, run `push.sh` from `c9d5827`.
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
- **Operating system updates.** On October 26, 2026, the first weekly check
  found 21 upgradable packages, 11 of them security updates. A one-time
  `apt-get full-upgrade` installed all 21 at 3:00 AM on October 27, 2026. It
  needed no reboot, the kernel stayed at `6.18.50+rpt-rpi-v8`, the three
  services kept running, and the check afterward found no updates. The weekly
  security install, `birdtracker-upgrade.timer`, first runs on November 1,
  2026. Check it with `journalctl -u birdtracker-upgrade`. For details, see
  [Update the operating system](deploy.md#update-the-operating-system).
- **Publisher usage.** After several complete UTC days on `a9b92cd` or later, compare
  the call counts and upload bytes in `data/publish-usage.json` with R2's
  metrics in the Cloudflare dashboard. Review listings should drop to about
  one per `--reviews-seconds` interval. Don't count the deployment day, which
  is partial.
- **SD card wear.** The analyzer writes the database and live strips
  constantly. A high-endurance card or a USB SSD for `data/` lasts longer.

### Dashboard counting

Simulated data, not real recordings, set the counting choices. Check them
against real recordings. For details, see
[How the dashboard counts](architecture.md#how-the-dashboard-counts).

### Recorder hardware

The recorder's power bank ran out at 4:21 AM on October 27, 2026, and the
recorder streamed again from 7:50 AM on a replacement. The Live page shows the
time between as a gap.

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
- [Multi-station expansion](plans/multi-station.md): more stations, their
  storage and cost, and a possible home server.

## Work on other branches

No other branch has documentation waiting to merge. On October 26, 2026, the
unmerged `codex/live-unidentified-export`, `codex/solar-activity-context`, and
`codex/privacy-and-home-server` branches were deleted without merging; their
privacy filter, station isolation, home-server spec, and time-of-day context
aren't on `main`. If a branch adds documentation that isn't on `main`, list it
here with where its documentation goes when it merges.

### Live details update

The Live UI supports edge-clamped labels, centered mute text, and unidentified
intervals. The embedded species pane was removed; the popup's **More details**
link now opens the species page in a new tab. A native drawer, rendered from data
Live already loads, remains an option if a new tab proves clumsy. The analyzer doesn't export unidentified
intervals: the branch with that export was deleted unmerged, so Live strips
don't include them. Site deployment is automatic after merging this update.
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
