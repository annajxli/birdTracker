# Status

This page is the only place in the repository that records what is deployed,
what is in progress, and what is unverified. Other pages describe how the
system works and link here for status. When you deploy, merge, or finish a
check, update this page in the same commit.

## Deployed

| Component | State | Setup |
| --- | --- | --- |
| Website | Served by the Cloudflare Worker from its static assets. GitHub Pages is off. | [Deploy the website](deploy.md#deploy-the-website) |
| R2 bucket | `birdtracker-media` | [Create the R2 bucket](deploy.md#create-the-r2-bucket) |
| Indoor computer | Raspberry Pi 3B+ running the receiver, analyzer, and publisher. The Hardware analytics page shows its code version and health. | [Set up the indoor computer](deploy.md#set-up-the-indoor-computer) |
| Recorder | FireBeetle 2 ESP32-E with the bench firmware in `firmware/recorder_test/`, on a power bank, indoors at a screened window. The flashed firmware predates over-the-air updates. | [Recorder hardware](hardware.md) |

## Open checks

- **Pi 3B+ speed and temperature.** The analyzer must finish each minute well
  within a minute, with no backlog. Check `vcgencmd measure_temp` under load,
  and again if the Pi moves into an enclosed cabinet.
- **SD card wear.** The analyzer writes the database and Live strips
  constantly. A high-endurance card or a USB SSD for `data/` lasts longer.
- **Publisher usage.** Compare several complete UTC days of
  `data/publish-usage.json` with R2's metrics in the Cloudflare dashboard.
- **Per-species thresholds.** Compare each learned threshold with a sample of
  detections just above and below it. If needed, adjust `MIN_REVIEWS` or
  `TARGET_PRECISION` in `pipeline/thresholds.py`.
- **Dashboard counting.** Simulated data set the counting choices in
  [How the dashboard counts](architecture.md#how-the-dashboard-counts). Check
  them against real recordings.
- **Recorder updates over Wi-Fi.** To turn on over-the-air updates, the
  watchdog, and the microphone stall restart, flash the FireBeetle once over
  USB. Then check that a real update installs, a broken image rolls back, a
  stopped microphone restarts the board, and a recorder without internet
  takes its time from the receiver.
- **Recorder power.** Streaming continuously over Wi-Fi, the bench recorder
  averaged about 0.95 W, far above the solar budget.
  [Bench test 2](plans/bench-test-2.md) measures power and chooses the board.

## Plans

None of these plans is built or tested:

- [Bench test 2: recorder power](plans/bench-test-2.md)
- [Microphone options](plans/microphone-options.md)
- [E-paper display](plans/eink-display.md)
- [Painted species art](plans/species-art.md)
- [Feeder camera](plans/feeder-camera.md)
- [Multi-station expansion](plans/multi-station.md)
