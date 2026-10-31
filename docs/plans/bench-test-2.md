# Bench test 2: recorder power

This page plans the second bench test. Only the firmware for the
[recording check](#recording-check) is built, and nothing has run yet. The
firmware modes, the measurement script, and the receiver change don't exist.
When the test runs, its results go in a new record, `docs/bench-test-2.md`,
and this plan is deleted. For the first test, see
[Bench test 1](../bench-test-1.md).

## Goal

Find a recorder configuration that fits a Seattle winter solar budget without
losing audio, and choose the board.

The test answers the following questions:

- How much energy does each firmware mode use per winter day, measured at the
  battery input?
- Which mode, on which board, fits the budget in
  [Pass criteria](#pass-criteria)?
- Does that mode keep every sample, with correct timestamps, and give BirdNET
  the same audio as streaming?

## Baseline

The bench recorder streams audio to the receiver continuously, with Wi-Fi
power saving off (`WiFi.setSleep(false)` in
`firmware/recorder_test/recorder_test.ino`). On a 10,000 mAh power bank it ran
for about 33 hours, an average of about 0.95 W, or about 23 Wh a day. For how
that was measured, see [Status](../status.md#recorder-hardware).

That's about 16 times the estimate for build A in
[Recorder hardware options](../design/hardware-design.html), which records
from before sunrise to after sunset, sleeps at night, and sizes its solar
panel for about 1.4 Wh a day. The estimate's main assumptions are untested:
the radio is off most of the time, the CPU idles while I²S fills its buffers,
and the board sleeps deeply at night.

The following arithmetic shows why the upload format matters. Mono 16-bit
audio at 32 kHz is 64,000 bytes a second, or 3.84 MB a minute. At the
FireBeetle's measured bench upload rate of 2,187 kbit/s, a minute of WAV takes
about 14 seconds to upload. Uploading in bursts therefore turns the radio off
only about three-quarters of the time. A compressed file shortens each burst
in proportion to its size.

## Boards and parts

The test uses the boards and parts in
[Bench test 1](../bench-test-1.md#parts). Run the boards in this order:

1. **FireBeetle 2 ESP32-E.** It has the streaming baseline, so each mode
   compares with a known number.
2. **Seeed XIAO ESP32S3.** Its PSRAM can hold a minute of audio, so it can
   upload without the microSD card. Measure both.
3. **Raspberry Pi Pico 2 W.** A retest that records to microSD instead of its
   own flash. Check whether the isolated full-scale samples from bench test 1
   recur.

4. **Seeed XIAO nRF52840 Sense.** It sends over BLE to the nRF52840 USB dongle
   instead of Wi-Fi. For its firmware, see
   [Firmware for the XIAO nRF52840 Sense](#firmware-for-the-xiao-nrf52840-sense).

For the exclusions, see [Out of scope](#out-of-scope).

## Recording check

To keep the live recording running during the test, make the XIAO ESP32S3 a
working recorder first. One board can then record while the other is measured.
The sketch in `firmware/power_test/` streams with the same protocol as the
bench recorder.

To run the check, do the following:

1. Connect the Wi-Fi antenna to the XIAO's U.FL socket.
2. Connect the INMP441 as shown in the following table:

   | INMP441 | XIAO ESP32S3 |
   | --- | --- |
   | VDD | 3V3 |
   | GND | GND |
   | L/R | GND |
   | SCK | D0 (GPIO 1) |
   | WS | D1 (GPIO 2) |
   | SD | D2 (GPIO 3) |

3. Copy `firmware/power_test/secrets.example.h` to `secrets.h` in the same
   folder, and fill it in. Set `RECEIVER_URL` to the laptop, not the Pi.
4. On the laptop, start `pipeline/receiver.py` with `--token` set to the
   `RECEIVER_TOKEN` value.
5. In PlatformIO, open `firmware/power_test`, select `env:xiao_esp32s3`, and
   then click **Upload**.

The following table lists the checks:

| Check | Method | Pass criteria |
| --- | --- | --- |
| R1 | Read the serial log after a reset | The log shows `wifi up` and `clock set from NTP` |
| R2 | Stop streaming with `c`, run `l`, stay quiet, and then clap | RMS rises 20 dB or more, with no `CLIPPED` |
| R3 | Start streaming with `c`, and run for 1 hour | Every minute file arrives, and the log shows 0 dropped frames |
| R4 | Play the bench test 1 Merlin clip from a phone at about 1 m, and run `analyzer.py --once` | BirdNET finds Black-capped Chickadee |

## Firmware for the XIAO nRF52840 Sense

The Zephyr app in `firmware/power_test_nrf/` uses the same D pins as the XIAO
ESP32S3. So far it has the sleep and record states, chosen with the commands
listed at the top of `src/main.c`.

The nRF52840 has no audio clock and no 32-bit I²S frame, so `SAMPLE_RATE` in
`src/main.c` runs at about 31.7 kHz with 24-bit slots. Check the microphone
with the level meter first, because the INMP441 is specified for 64 clocks per
frame, and this frame has 48. If the level is wrong by a constant amount,
adjust `SAMPLE_SHIFT`.

To build the app, run the following command from a Zephyr workspace:

```bash
west build -b xiao_ble/nrf52840/sense PATH_TO_REPO/firmware/power_test_nrf
```

Replace `PATH_TO_REPO` with the path to this repository. To flash the board,
double-tap its reset button, and then copy `build/zephyr/zephyr.uf2` to the
drive that appears.

## Firmware modes

The ESP32 boards share the Arduino sketch in `firmware/power_test/`. The Pico
2 W uses the Pico SDK, and the XIAO nRF52840 Sense uses Zephyr. These are bench
tools. A production recorder uses ESP-IDF on an ESP32 or the Pico SDK on a
Pico, as [Recorder hardware](../hardware.md#build-the-bench-recorder)
describes.

| Mode | What the board does | What it isolates |
| --- | --- | --- |
| M1 Stream | Streams continuously, as deployed, with Wi-Fi power saving off | The baseline, measured at the battery input instead of the power bank |
| M1s Stream, modem sleep | M1 with Wi-Fi power saving on, and a larger send buffer to absorb the delays | Whether streaming alone can get close to the budget |
| M2 Record only | Reads the microphone and discards the audio, with the radio off | The floor: microphone, I²S, and CPU |
| M3 SD and bursts | Records 1-minute WAV files to microSD, and uploads the waiting files every N minutes, with N set to 1 and 5. Between bursts, the radio is either off or connected with modem sleep; measure both. | The main candidate |
| M4 Compressed bursts | M3 with FLAC files | Whether encoding costs less than the radio time it saves |
| M5 Night | Deep sleep, with the microphone's clock stopped and the microSD card unpowered if the board allows it, and a timer wake | The 14-hour winter night |

For M2 to M4, also measure the CPU at its lowest clock that keeps up, such as
80 MHz on the ESP32 boards.

Burst uploads use the receiver's existing `POST /upload` endpoint. Each
upload carries the board's health in an `X-Health` header, in the same
`key=value` format as the stream's health frames. The health adds
`samples_recorded` and `samples_dropped`, so the receiver can check
continuity.

A third marker pin goes high during microSD writes, beside the existing
recording and uploading markers. The sketch's `PIN_MARK_` constants name the
pins, and `docs/hardware.md` lists the wiring with the microSD breakout.

## Measurement setup

- The PPK2 runs as a source meter at 3.7 V into each board's battery input,
  so the measurement includes the board's regulator: the FireBeetle's JST-PH
  connector, the XIAO's battery pads, and the Pico's `VSYS` pin.
- The board's USB cable is unplugged. Serial logs go through the 3.3 V
  serial adapter, connected only by TX, RX, and ground.
- The marker pins connect to the PPK2's logic inputs, so the trace labels
  each state.
- A new script, `firmware/recorder_test/ppk2_measure.py`, drives the PPK2
  with the `ppk2-api` Python package. It records for a set time, averages
  the current to 1 ms, splits the trace by marker state, and prints the
  average current and power per state, and per full upload cycle. If the
  package can't read the logic inputs, export the trace from the Power
  Profiler app in nRF Connect for Desktop, and point the script at the
  CSV file instead.
- Each run lasts at least 10 minutes, or at least three full upload cycles,
  whichever is longer. Raw traces stay out of Git. The record keeps the
  script's summaries.

To project a winter day, the script adds each mode's power over the sizing
case in [Recorder hardware options](../design/hardware-design.html): about 10
hours of recording and 14 hours of night. The projection for build A is the
recording mode's average power for the recording hours, plus M5 for the
night.

## Tests

Run T1 to T6 on each board. Run T7 on the best configuration that passes T1
to T6.

| Test | What it checks | Method | Pass criteria |
| --- | --- | --- | --- |
| T1 | Power per mode | Measure M1, M1s, M2, M3 with each N and between-burst setting, M4, and M5 | A summary for each mode, with average power and the current in each marked state |
| T2 | Wi-Fi connect cost | In M3 with the radio off between bursts, measure the energy from wake to the first upload byte | A figure in millijoules per connect, used to choose N |
| T3 | Radio efficiency | In M3 and M4, measure the send energy per payload bit that the receiver gets intact, with and without T2's connect energy. Also record the payload bit rate and packets per second. | Figures in microjoules per bit, kbit/s, and packets per second for each board, comparable across BLE and Wi-Fi |
| T4 | Audio continuity | Run M3 or M4 for 2 hours with the receiver | Every minute file arrives. `samples_dropped` stays 0. Consecutive files' start times differ by the file length, within 10 ms. |
| T5 | Compression is lossless | In M4, also write each minute as WAV to the microSD card for 10 minutes, and compare the two on the indoor computer | The decoded FLAC samples equal the WAV samples exactly |
| T6 | BirdNET parity | Play the bench test 1 Merlin clip from a phone at about 1 m, in M1 and then in M3, on the same board | BirdNET finds the same species in the same 3-second windows. Don't compare confidence scores; hand-held playback can't repeat exactly. |
| T7 | A day on a battery | Run the chosen configuration for 24 hours from a power bank, through the inline USB power meter, on its real day and night schedule | The meter's daily energy agrees with the projection from T1 within 25%. T4's criteria hold for the whole day. |

## Pass criteria

- **Energy.** The projected winter day is at most 1.4 Wh at the battery
  input, the build A estimate that the solar sizing in
  [Recorder hardware options](../design/hardware-design.html) assumes. A day
  of up to 2 Wh is acceptable with a panel at the top of that page's range.
  Above 2 Wh, the configuration fails the solar budget. Its options are
  recording in slices outside the dawn chorus, as that page describes, or the
  cable from the house.
- **Audio.** T4 and T5 pass, and T6 finds the same species.
- **Board.** Of the boards that pass, choose the one with the lowest
  projected winter day. If two are within 10% of each other, choose the one
  with less firmware risk, such as more RAM or fewer workarounds.

## Steps

The steps say who does each one: *Claude* for code and documentation, and
*you* for the hardware at the bench.

1. *Claude:* add the modes, the microSD recording, the burst uploads, FLAC,
   deep sleep, the third marker pin, and the `X-Health` header to the bench
   sketch. Document the microSD wiring in `docs/hardware.md`.
2. *Claude:* make the receiver read `X-Health` on uploads and write the same
   `.json` sidecar that it writes for streamed minutes.
3. *Claude:* write `ppk2_measure.py`, and test it with a recorded trace.
4. *You:* wire the microSD breakout and the PPK2 to the FireBeetle, and run
   T1 to T6.
5. *Claude:* write the FireBeetle results in `docs/bench-test-2.md`. If no
   mode comes close to 2 Wh, stop and revisit the plan before you test the
   other boards.
6. *You:* repeat step 4 on the XIAO ESP32S3 and the Pico 2 W.
7. *You and Claude:* run T7 on the best configuration, then choose the board.
8. *Claude:* replace the estimates in
   [Recorder hardware options](../design/hardware-design.html) with the
   measurements, and delete this plan.

## Out of scope

- **Solar charging**, the charger's efficiency, and the battery gauge. A
  later test sizes the panel from this test's winning number.
- **Microphones.** Every board uses the same INMP441. For microphone
  changes, see [Microphone options](microphone-options.md).
- **Production firmware.** The modes show what's possible. The production
  firmware is written after the board is chosen.
