# Bench test 1: microphone, recording, and Wi-Fi upload

This page is a record of the first bench test. Its results were committed on
October 24, 2026. Don't update it to describe later changes. For the bench recorder as it is
now, see [Recorder hardware](hardware.md#build-the-bench-recorder).

## Goal

On the FireBeetle 2 ESP32-E and the Raspberry Pi Pico 2 W, get audio from an
INMP441 microphone into a WAV file, upload it over Wi-Fi to the indoor
computer, and run BirdNET on it.

The following were out of scope for this test:

- Power profiling, which needs the Power Profiler Kit II (PPK2).
- Recording to microSD, which needs the microSD breakout. The boards recorded
  to their own flash, 10 seconds at a time.

## Boards

The bench test series compares the following boards. Bench test 1 covered the
first two.

| Board | Chip | Reason to test it |
| --- | --- | --- |
| Raspberry Pi Pico 2 W | RP2350 and CYW43439 | Baseline, with no PSRAM |
| FireBeetle 2 ESP32-E | ESP32 | Low-power board design, with no PSRAM |
| Seeed XIAO ESP32S3 | ESP32-S3 with 8 MB PSRAM | Has PSRAM. The Sense version was out of stock, so this board uses an INMP441 and the microSD breakout. |
| Seeed XIAO nRF52840 Sense (optional) | nRF52840 | Lowest power class, with a BLE link to an nRF52840 USB dongle |

## Parts

The test series uses the following parts. Prices are estimates from the
planning stage.

| Part | Purpose | Estimated price |
| --- | --- | --- |
| FireBeetle 2 ESP32-E | Board under test | $15 |
| Seeed XIAO ESP32S3 | Board under test | $7 to $10 |
| Seeed XIAO nRF52840 Sense (optional) | Board under test, for the BLE comparison | $16 |
| Two INMP441 I²S microphone modules | One moves between boards so that every board uses the same microphone; one is a spare | $3 to $5 each |
| Adafruit 4682 microSD breakout (3 V) | Moves between boards | $3.50 |
| 32 GB microSD card | Moves between boards | $8 to $10 |
| Breadboard, jumper wires, and header pins | Wiring. The Pico 2 W needs headers unless it's the WH version. | $15 |
| Nordic Power Profiler Kit II (PPK2) | Powers a board and records its current from about 0.2 µA to 1 A, 100,000 times a second | $100 |
| JST-PH 2.0 two-pin pigtails | Connect the PPK2 to the boards' battery inputs | $8 |
| Inline USB-C power meter (optional) | Daily energy totals without a computer | $20 to $40 |
| 3.3 V USB-to-serial adapter or Raspberry Pi Debug Probe (optional) | Serial logs while the PPK2 powers a board and USB is unplugged | $5 to $12 |
| Foam microphone windscreens (optional) | Recording at an open window | $5 to $8 |

The estimated total was $175 to $190 for the required parts and $240 to $255
with the optional parts. The PPK2 is almost half of the cost, and it works
with every board.

The following notes explain some choices:

- The PPK2 came from an authorized distributor, such as Digi-Key or Mouser,
  because other marketplace listings are from third-party resellers.
- The INMP441 has the same wiring and I²S interface as the ICS-43434, so the
  final microphone is a drop-in replacement. The INMP441 is noisier, with an
  SNR of 61 dB instead of 65 dB, and draws about 1.4 mA instead of 0.5 mA.
  BirdNET picks up fewer distant birds with it.
- The PPK2 feeds the boards' battery inputs, so that the measurement includes
  each board's own regulator and charger.
- While the PPK2 powers a board, the board's USB cable is unplugged. The
  serial adapter connects only TX, RX, and ground, never its power pin.
- The 4-channel oscilloscope on hand replaces a logic analyzer for this test.
  I²S needs three channels and SPI needs four. The oscilloscope also shows
  the 3.3 V rail dipping during Wi-Fi bursts, which can cause resets.
- The PPK2 measures one board at a time, and the microphone and microSD
  breakout move between boards. As a result, the test can't record on two
  boards side by side.
- An nRF52840 USB dongle, already owned, is the BLE receiver on the indoor
  computer.

**Correction, October 26, 2026:** the statement above that BirdNET picks up
fewer distant birds with the INMP441 was never measured. The ICS-43434 is
discontinued. For a comparison of microphones and how to test one, see
[Microphone options](plans/microphone-options.md).

## Setup

The test used the steps in
[Build the bench recorder](hardware.md#build-the-bench-recorder), with a
laptop as the indoor computer. A phone made a reference recording and played a
bird recording at a fixed volume and distance.

## Tests

The test plan ran T1 to T4 on each board, and T5 as described in its row.

| Test | What it checks | Method | Pass criteria |
| --- | --- | --- | --- |
| T1 | The board starts and joins Wi-Fi | Reset the board and read the serial log | The log shows `wifi up`, the RSSI, and `clock set from NTP` |
| T2 | The microphone works, with a sensible level | Run `l`, then clap, whistle, and stay quiet | RMS rises 20 dB or more with sound. A quiet room reads about −70 to −50 dBFS. A clap at arm's length doesn't print `CLIPPED`. |
| T3 | Recording and upload | Run `r` | The log shows about 10 seconds of recording and an HTTP `201` status code. The file appears in `data/incoming/` and plays back cleanly in Audacity. |
| T4 | Upload throughput | Note the upload rate from T3 at the bench and near the planned mount | Well over 1,000 kbit/s at the bench |
| T5 | BirdNET on the recordings | Play the same bird recording from a phone at about 1 m, run `r`, and then run `analyzer.py --once` | Each board finds the same species as a phone recording of the same playback |

Don't compare confidence scores across boards in T5. Hand-held playback can't
match volume and position. A fair comparison needs both boards to record one
sound side by side.

The test plan listed these symptoms to watch for:

- **Recording takes much longer than 10 seconds.** Flash can't keep up with
  the microphone.
- **Pitch or speed is wrong in playback.** The sample rate setting or I²S
  timing is wrong.
- **Periodic clicks.** The board dropped samples while it wrote to flash.
- **The board resets during upload.** The USB port or the board's regulator
  sags under the Wi-Fi burst. An oscilloscope on 3V3 shows it.

## Results

| Result | FireBeetle 2 ESP32-E | Pico 2 W |
| --- | --- | --- |
| T1 Wi-Fi join time, RSSI | 1.8 s, −55 dBm. NTP missed its 15-second window at startup but set the clock later. | 5.8 to 14 s, −50 to −60 dBm. NTP sometimes missed the startup window. |
| T2 quiet and clap RMS (dBFS) | −55 to −64 quiet, −15.6 clap (peak 20,689 of 32,767, no clipping) | −55 to −65 quiet, −14.6 clap (peak 12,421, no clipping) |
| T3 record time for 10 s, upload status | 9.99 s, HTTP `201` status code. 32 kHz mono, no sample jumps found. | Recording 10 s to flash made the board stop responding: any flash write while I²S streams. Recording 5 s to RAM and then saving with the microphone stopped: 5.00 s, HTTP `201` status code. Three isolated full-scale samples in one file. |
| T4 upload rate, bench and near mount | 2,187 kbit/s at the bench. Not measured near the mount. | 831 kbit/s at the bench. Not measured near the mount. The arduino-pico `HTTPClient` failed partway through a file with HTTP `-3`, so a hand-written `POST` request replaced it. |
| T5 BirdNET species and confidence | Merlin clip from April 12, 2024, played from a phone: Black-capped Chickadee at 0.82, 0.63, and 0.86 in three segments. The original phone recording: 0.75, 0.68, 0.55, and lower. | Same clip: Black-capped Chickadee at 0.49, in one full 3-second window within 5 seconds. |
| Other notes | macOS needed WCH's CH34x driver (USB ID `1a86:7522`). | Flash writes freeze I²S, so the sketch adds a watchdog. Wi-Fi join and upload are slower. For continuous recording, the Pico needs SD (SPI) or RAM buffering instead of internal flash. |

## Plan for bench test 2

Bench test 2 uses the PPK2 and the microSD breakout to do the following:

- Record continuously to SD in files of 1 to 5 minutes, and upload them in
  batches.
- Measure a power profile for each state: recording, SD write, Wi-Fi connect,
  upload, and deep sleep. The marker pins label each state in the trace.
- Measure energy per uploaded MB over Wi-Fi, and over BLE on the nRF52840.
- Test the XIAO ESP32S3, and BLE to the nRF52840 dongle.
- Retest the Pico 2 W recording continuously to SD, and check whether the
  isolated full-scale samples recur. Its problems in bench test 1 came from
  recording to its own flash, which SD avoids.

The measurements replace the energy estimates in
[Recorder hardware options](design/hardware-design.html) and decide the board.

**Note, October 27, 2026:** the plan for bench test 2 moved to
[Bench test 2: recorder power](plans/bench-test-2.md), which replaces the
list above.
