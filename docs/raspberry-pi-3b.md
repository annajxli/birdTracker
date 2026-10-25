# The indoor computer on a Raspberry Pi 3B+

The receiver, analyzer and publisher (`pipeline/receiver.py`, `analyzer.py`,
`publish.py`) can run on a Raspberry Pi 3B+ (quad Cortex-A53, 1 GB RAM)
instead of a laptop. Files for it are in [`deploy/pi/`](../deploy/pi/).

## What's different on the Pi

- **BirdNET without TensorFlow.** `birdnet-analyzer` imports TensorFlow and
  Keras on every start, which a 1 GB board can't afford, though the model is a
  TFLite file. `pipeline/birdnet_lite.py` runs the same model and location
  filter on `ai-edge-litert` and writes the same CSV. On the laptop it gave
  the same 32 detections as birdnet-analyzer over five test recordings
  (scores within 0.005), about 6× faster. It's the analyzer's default engine
  everywhere; `--engine analyzer` uses birdnet-analyzer instead.
- **No GitHub access needed.** `deploy/pi/push.sh` copies the pipeline, the
  three model files and the settings from the laptop over SSH, then runs
  `deploy/pi/install.sh` on the Pi (a virtualenv from
  `deploy/pi/requirements.txt`, and three systemd services that start at boot
  and restart if they crash).
- **Settings** live in `~/birdtracker/birdtracker.env` on the Pi: the R2 keys
  (from `publish.env`), the receiver token (from the firmware's `secrets.h`)
  and `BIRDNET_MODELS`. `push.sh` writes it the first time only.

## Setting it up

1. **SD card.** Raspberry Pi Imager → Raspberry Pi 3 → Raspberry Pi OS Lite
   (64-bit). In the settings: hostname `birdtracker`, a user, wifi, time zone
   `America/Los_Angeles`, SSH with public-key authentication only (Imager fills
   in the laptop's key; make one first with `ssh-keygen -t ed25519` if there
   isn't one). A 5 V 2.5 A supply; a heatsink; Ethernet if it's handy.
2. **A fixed address.** Reserve the Pi's address in the router (DHCP
   reservation). The recorder sends to it.
3. **Install,** from the laptop: `deploy/pi/push.sh <user>@birdtracker.local`.
   Run it again after any pipeline change to update the Pi.
4. **Point the recorder at it.** Set `RECEIVER_URL` in
   `firmware/recorder_test/secrets.h` to `http://<Pi address>:8765` and
   reflash the board.
5. **Move the data over** (optional, to keep history): copy
   `data/recorder.sqlite`, `data/clips/` and `data/live/` to
   `~/birdtracker/data/` on the Pi before starting it, then stop the laptop's
   receiver, analyzer and publisher.

Logs: `journalctl -u birdtracker-analyzer -f` (likewise `-receiver`,
`-publish`).

## Still to check on the Pi itself

- **Speed:** each minute of audio must be analyzed in well under a minute,
  alongside drawing its spectrogram and saving its Opus copy. If it can't
  keep up, use the INT8 model, or fewer threads competing with the receiver.
- **Temperature:** the 3B+ slows down when hot; check `vcgencmd measure_temp`
  under load.
- **SD card wear:** recordings are deleted right after analysis, but the
  database and live strips are written constantly; a high-endurance card or a
  USB SSD for `data/` lasts longer.
