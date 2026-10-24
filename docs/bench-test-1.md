# Bench test 1: mic, recording, wifi upload

**Goal for today:** on the FireBeetle 2 ESP32-E and the Pico 2 W, get audio
from the INMP441 mic into a WAV file, upload it over wifi to the indoor
computer, and run BirdNET on it. Power profiling waits for the PPK2; SD cards
wait for the breakout (recordings go to the boards' own flash for now: 10 s at
a time).

Firmware: [`firmware/recorder_test/`](../firmware/recorder_test/).
Receiver: [`pipeline/receiver.py`](../pipeline/receiver.py).

## Equipment for today

- FireBeetle 2 ESP32-E, Pico 2 W, INMP441 (+ spare), breadboard, jumper wires
- **USB cables that carry data**, not charge-only ones (USB-C for the
  FireBeetle, micro-USB for the Pico 2 W)
- Laptop (the indoor computer for now), on the same wifi as the boards
- Phone: a reference recording, and for playing a bird recording at a fixed
  volume and distance
- Multimeter: check the mic gets 3.3 V
- Oscilloscope (only if there's no audio): look at the mic's clock and data
  lines

Not today: PPK2, microSD breakout, nRF52840 dongle (it's for the BLE test).

## Software to install

1. **VS Code** with the **PlatformIO IDE** extension (Extensions → search
   "PlatformIO IDE"). On first launch it installs its own toolchain; give it
   a few minutes. The first build of each board downloads that board's
   compiler and libraries automatically (`firmware/recorder_test/platformio.ini`
   says which).
2. **USB serial driver**, only if the FireBeetle doesn't show up as a port:
   it uses a CH340/CH9102 USB chip; recent macOS includes the driver.
3. **The repo's Python environment** (already set up): runs the receiver and
   BirdNET.
4. **Audacity** (optional): look at and listen to the recordings.
5. **nRF Connect for Desktop** (optional today): needed later for the PPK2's
   Power Profiler app and for flashing the nRF52840 dongle.

*Alternative to PlatformIO:* Arduino IDE 2 with the **esp32** (Espressif,
3.x) and **Raspberry Pi Pico/RP2040/RP2350** (Earle Philhower) board
packages, from these board-manager URLs:
`https://espressif.github.io/arduino-esp32/package_esp32_index.json` and
`https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`.
For the Pico 2 W pick Tools → Flash Size → **4MB (FS: 2MB)**.

This Arduino-framework sketch is for bench testing only. If the recorder
ends up on the Pico, its real firmware will be written with the Pico SDK
(the VS Code Pico extension); on the ESP32, with ESP-IDF.

## Wiring the INMP441

| INMP441 | FireBeetle 2 ESP32-E | Pico 2 W |
| --- | --- | --- |
| VDD | 3V3 | 3V3(OUT), pin 36 |
| GND | GND | GND |
| L/R | GND (left channel) | GND |
| SCK | D3 (GPIO 26) | GP16 |
| WS | D2 (GPIO 25) | GP17 (must be SCK + 1) |
| SD | A2 (GPIO 34) | GP18 |
| marker: recording | D6 (GPIO 14) | GP14 |
| marker: uploading | D7 (GPIO 13) | GP15 |

FireBeetle pins show the board's silkscreen label (D3) with the GPIO number the
sketch's `PIN_` constants use. Any free GPIO works on the FireBeetle (change the
`PIN_` constants); on the Pico, WS must be the pin after SCK. Marker pins are
optional today; they're for the scope and, later, the PPK2. Keep mic wires
short (under ~15 cm).

## Setup

1. Copy `firmware/recorder_test/secrets.example.h` to `secrets.h` and fill
   in the wifi name and password, the laptop's LAN address (System Settings →
   Wi-Fi → Details → IP address), and a token of your choosing.
2. Start the receiver on the laptop, with the same token:
   ```
   .venv/bin/python pipeline/receiver.py --token <token>
   ```
   If macOS asks whether Python may accept incoming connections, allow it.
3. In VS Code, open the `firmware/recorder_test` folder. In PlatformIO's
   environment switcher (bottom status bar), pick **env:firebeetle** or
   **env:pico2w**.
4. Plug in the board and click **Upload** (→). For the Pico 2 W, if it
   isn't detected, hold BOOTSEL while plugging it in, then upload again.
5. Open the **Serial Monitor** (plug icon; 115200 baud is set). Commands:
   `l` level meter, `r` record + upload, `u` upload again, `i` info.

## Tests

Do T1–T4 on each board.

| # | Test | How | Pass |
| --- | --- | --- | --- |
| T1 | Boots and joins wifi | Reset; read the serial log | "wifi up", RSSI printed, "clock set from NTP" |
| T2 | Mic alive, sensible level | `l`, then clap, whistle, stay quiet | RMS jumps 20+ dB with sound; quiet room roughly −70 to −50 dBFS; no "CLIPPED" on a clap at arm's length. Silence or a constant value: check wiring (L/R to GND, WS on the right pin) |
| T3 | Record + upload | `r` | "recorded … in ~10 s", "HTTP 201"; the file appears in `data/incoming/`; it plays back cleanly in Audacity (no clicks, right speed) |
| T4 | Throughput | Note the upload kbit/s from T3, at the bench and (if you can) carried near the planned mount spot | Bench: well over 1,000 kbit/s. Note the RSSI too |
| T5 | BirdNET on the files | Play the same bird recording from the phone at ~1 m for each board, `r`, then run `analyzer.py --once` | Same species found on each board as on a phone recording of the same playback. Don't compare confidences across boards: hand-held playback can't match volume and position; that needs both boards recording one sound side by side |

Things to watch for:
- **Recording takes much longer than 10 s:** the flash can't keep up with
  the mic; note it (SD will fix this, and it matters for continuous use).
- **Pitch or speed wrong in playback:** sample-rate setting or I²S timing.
- **Clicks every so often:** samples dropped while writing to flash.
- **Board resets during upload:** the USB port or the board's regulator
  sagging under the wifi burst; the scope on 3V3 shows it.

## Results

Fill in as you go.

| | FireBeetle 2 ESP32-E | Pico 2 W |
| --- | --- | --- |
| T1 wifi join time, RSSI | 1.8 s, −55 dBm; NTP missed its 15 s window at boot but set later | 5.8–14 s, −50 to −60 dBm; NTP also sometimes misses the boot window |
| T2 quiet / clap RMS (dBFS) | −55 to −64 / −15.6 (peak 20,689 of 32,767, no clip) | −55 to −65 / −14.6 (peak 12,421, no clip) |
| T3 record time for 10 s, upload HTTP code | 9.99 s, HTTP 201; 32 kHz mono, no sample jumps found | 10 s to flash **hangs the board** (any flash write while I²S streams); recording 5 s to RAM, then saving with the mic stopped: 5.00 s, HTTP 201. 3 isolated full-scale samples in one file |
| T4 upload kbit/s (bench / near mount) | 2,187 / not yet | 831 / not yet (arduino-pico's HTTPClient failed mid-file, HTTP −3; replaced by a hand-written POST) |
| T5 BirdNET species + confidence vs phone | Merlin clip 2024-04-12 1632 played from a phone: Black-capped Chickadee 0.82 / 0.63 / 0.86 in 3 segments (original phone recording: 0.75 / 0.68 / 0.55 / …) | Same clip: Black-capped Chickadee 0.49 (one full 3 s window in 5 s) |
| Problems / notes | Mac needed WCH's CH34x driver (USB ID 1a86:7522) | Flash writes freeze I²S (watchdog added); HTTPClient stream upload fails; slower wifi join and upload. For continuous recording the Pico needs SD (SPI) or RAM buffering, not internal flash |

## Next (bench test 2)

With the PPK2 and the microSD breakout: continuous recording to SD in 1–5
minute files, batch uploads, and a power profile per state (recording,
SD write, wifi connect, upload, deep sleep) using the marker pins, then the
XIAO ESP32S3 Sense, and BLE to the nRF52840 dongle.
