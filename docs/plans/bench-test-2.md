# Bench test 2: recorder power

This page plans the second bench test. Nothing on it is built or run: the
firmware modes, the measurement script, and the receiver change don't exist.
When the test runs, its results go in a new record, `docs/bench-test-2.md`,
and this plan is deleted. For the first test, see
[Bench test 1](../bench-test-1.md).

## Goal

Find a recorder configuration that fits a Seattle winter solar budget without
losing audio, and choose the board.

## Baseline

The bench recorder streams continuously with Wi-Fi power saving off
(`WiFi.setSleep(false)` in `firmware/recorder_test/recorder_test.ino`). On a
10,000 mAh power bank it ran about 33 hours, an average of about 0.95 W, or
about 23 Wh a day. That's about 16 times the build A estimate in
[Recorder hardware options](../design/hardware-design.html), about 1.4 Wh a
day, which assumes the radio is mostly off, the CPU idles while I²S fills its
buffers, and the board sleeps deeply at night.

Mono 16-bit audio at 32 kHz is 3.84 MB a minute. At the FireBeetle's bench
upload rate of 2,187 kbit/s, a minute of WAV takes about 14 seconds to upload,
so burst uploads turn the radio off only about three-quarters of the time.
Compression shortens each burst in proportion.

## Boards

Using the parts from [Bench test 1](../bench-test-1.md#parts), test in this
order:

1. **FireBeetle 2 ESP32-E**, which has the streaming baseline.
2. **Seeed XIAO ESP32S3**, whose PSRAM can hold a minute of audio. Measure
   with and without the microSD card.
3. **Raspberry Pi Pico 2 W**, recording to microSD instead of its own flash.
   Check whether the isolated full-scale samples from bench test 1 recur.

## Firmware modes

A constant in the bench sketch selects the mode.

| Mode | What the board does | What it isolates |
| --- | --- | --- |
| M1 Stream | Streams with Wi-Fi power saving off | The baseline, at the battery input |
| M1s Stream, modem sleep | M1 with power saving on and a larger send buffer | Whether streaming alone can approach the budget |
| M2 Record only | Reads the microphone and discards audio, radio off | The floor |
| M3 SD and bursts | Records 1-minute WAVs to microSD and uploads every N minutes (N = 1 and 5), with the radio off or in modem sleep between bursts | The main candidate |
| M4 Compressed bursts | M3 with FLAC | Whether encoding costs less than the radio time it saves |
| M5 Night | Deep sleep with a timer wake, microphone clock stopped | The 14-hour winter night |

For M2 to M4, also measure the lowest CPU clock that keeps up. Bursts use the
receiver's `POST /upload`, with health, including `samples_recorded` and
`samples_dropped`, in an `X-Health` header in the stream's `key=value` format.
A third marker pin marks microSD writes.

## Measurement setup

- The PPK2 sources 3.7 V into each board's battery input, so the measurement
  includes the board's regulator. USB is unplugged, and serial logs go through
  a 3.3 V adapter (TX, RX, and ground only).
- The marker pins connect to the PPK2's logic inputs.
- A new script, `firmware/recorder_test/ppk2_measure.py`, uses `ppk2-api` to
  record, split the trace by marker state, and print average power per state
  and per upload cycle. If it can't read the logic inputs, it reads a CSV
  exported from the Power Profiler app.
- Each run lasts at least 10 minutes or three upload cycles. Raw traces stay
  out of Git.

A winter day projection is about 10 hours in the recording mode plus 14 hours
in M5.

## Tests

Run T1 to T6 on each board, and T7 on the best passing configuration.

| Test | Method | Pass criteria |
| --- | --- | --- |
| T1 Power per mode | Measure every mode and setting | Average power and current per marked state |
| T2 Wi-Fi connect cost | In M3 with the radio off, measure wake to first upload byte | Millijoules per connect |
| T3 Upload energy | In M3 and M4 | Millijoules per uploaded MB |
| T4 Continuity | M3 or M4 for 2 hours | Every minute arrives, `samples_dropped` stays 0, and start times differ by the file length within 10 ms |
| T5 Lossless compression | In M4, also write WAV for 10 minutes and compare | Decoded FLAC equals WAV exactly |
| T6 BirdNET parity | Play the bench test 1 clip at about 1 m in M1 and M3 | Same species in the same 3-second windows |
| T7 A day on a battery | 24 hours from a power bank through the USB power meter, on the real schedule | Daily energy within 25% of the T1 projection, and T4 holds |

## Pass criteria

- **Energy.** A projected winter day of at most 1.4 Wh at the battery input.
  Up to 2 Wh is acceptable with a panel at the top of the design page's
  range. Above that, the options are recording in slices outside the dawn
  chorus, or the cable from the house.
- **Audio.** T4, T5, and T6 pass.
- **Board.** The lowest projected winter day. Within 10%, choose less firmware
  risk.

If no FireBeetle mode comes close to 2 Wh, revisit the plan before you test
the other boards. Afterward, replace the estimates in
[Recorder hardware options](../design/hardware-design.html) with the
measurements.

## Out of scope

BLE (unless no Wi-Fi board passes), solar charging and the battery gauge,
microphone changes ([Microphone options](microphone-options.md)), and
production firmware.
