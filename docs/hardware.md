# Recorder hardware

This page describes the outdoor recorder: its requirements, the candidate
builds, and how to build the bench recorder. For how its audio reaches the
dashboard, see [Architecture](architecture.md).

## Requirements

- The recorder only records audio and sends it indoors, where BirdNET runs.
- It runs on solar power through a Seattle winter, recording continuously
  through daylight. A cable from the house is the fallback.

## Candidate builds

[Recorder hardware options](design/hardware-design.html) compares three
builds, with energy estimates and component options:

- **A. Low-power microcontroller, one microphone.** For example, an ESP32-S3
  or nRF5340 with a digital MEMS microphone.
- **B. Low-power microcontroller, two microphones.** Build A with a stereo
  pair, for [counting individual birds](#counting-individual-birds).
- **C. Raspberry Pi Zero 2 W.** A Linux board with an analog microphone and a
  sound card. It has the best audio and needs the least firmware, at about 10
  times the energy of build A.

If a cable from the house (about 5 to 10 m) can reach the microphone, the
simplest setup is a microphone on the cable and an indoor computer, with no
solar power or Wi-Fi link.

The energy figures are estimates until bench tests measure them. See
[Bench test 1](bench-test-1.md) and
[Microphone options](plans/microphone-options.md).

## Build the bench recorder

The bench recorder is an Arduino sketch in `firmware/recorder_test/` for the
FireBeetle 2 ESP32-E and the Raspberry Pi Pico 2 W, for bench testing only. A
production recorder uses ESP-IDF on an ESP32 or the Pico SDK on a Pico. The
FireBeetle streams to the receiver as soon as it has Wi-Fi and the time. The
Pico 2 W records short files and uploads them on command.

### Before you begin

- A FireBeetle 2 ESP32-E or a Raspberry Pi Pico 2 W.
- An INMP441 I²S microphone module, a breadboard, and jumper wires.
- A USB cable that carries data, not a charge-only cable: USB-C for the
  FireBeetle, or micro-USB for the Pico 2 W.
- A computer running the receiver, on the same Wi-Fi network as the board.
  For more information, see [Development](development.md#run-the-pipeline-without-a-recorder).

### Wire the microphone

Connect the INMP441 as shown in the following table. FireBeetle pins show the
board's label and, in parentheses, the GPIO number that the sketch's `PIN_`
constants use.

| INMP441 | FireBeetle 2 ESP32-E | Pico 2 W |
| --- | --- | --- |
| VDD | 3V3 | 3V3(OUT), pin 36 |
| GND | GND | GND |
| L/R | GND (left channel) | GND |
| SCK | D3 (GPIO 26) | GP16 |
| WS | D2 (GPIO 25) | GP17 |
| SD | A2 (GPIO 34) | GP18 |
| Marker: recording | D6 (GPIO 14) | GP14 |
| Marker: uploading | D7 (GPIO 13) | GP15 |

The wiring has the following constraints:

- On the FireBeetle, if you change the `PIN_` constants, you can use any free
  GPIO.
- On the Pico 2 W, WS must be the pin after SCK.
- The marker pins are optional. They go high while the board records or
  uploads, for an oscilloscope or a power profiler's logic inputs.
- Microphone wires must be shorter than about 15 cm.

If the microphone records silence or a constant value, check that L/R is
connected to GND and that WS is on the right pin. To check power, measure
3.3 V at VDD with a multimeter.

### Install the tools

1. Install VS Code with the PlatformIO IDE extension. The first build for each
   board downloads the toolchain and libraries in
   `firmware/recorder_test/platformio.ini`.
2. If the FireBeetle doesn't appear as a serial port on macOS, install WCH's
   CH34x driver.

### Configure and flash the board

1. Copy `firmware/recorder_test/secrets.example.h` to `secrets.h` in the same
   folder. Git ignores `secrets.h`.
2. In `secrets.h`, set the Wi-Fi network name and password, `RECEIVER_URL`, and
   `RECEIVER_TOKEN`. The token must match the receiver's `--token` value.
3. In VS Code, open the `firmware/recorder_test` folder.
4. In the PlatformIO environment switcher, select `env:firebeetle` or
   `env:pico2w`.
5. Connect the board, and then click **Upload**. If your computer doesn't
   detect the Pico 2 W, hold **BOOTSEL** while you connect it, and then
   upload again.
6. Open the **Serial Monitor**. The sketch sets the baud rate to 115200.

The sketch accepts the following serial commands. While the FireBeetle
streams, which it does from startup when `STREAM_ON_BOOT` is `true`, only `c`
and `i` work. To use the other commands, stop streaming with `c` first.

| Command | Action |
| --- | --- |
| `l` | Shows the microphone's peak and RMS level for 10 seconds |
| `r` | Records a short file and uploads it |
| `u` | Uploads the last recording again |
| `i` | Shows Wi-Fi, time, and free flash |
| `c` | Starts or stops streaming (FireBeetle only) |

### Update the FireBeetle over Wi-Fi

After you flash the FireBeetle once over USB with a firmware that supports
over-the-air updates, you can update it without a cable. For how updates and
rollback work, see
[Recorder firmware updates](architecture.md#recorder-firmware-updates).

1. Make sure that `secrets.h` has the same `RECEIVER_TOKEN` as the indoor
   computer's `birdtracker.env`.
2. In PlatformIO, select `env:firebeetle`, and then click **Build**. Don't
   click **Upload**. The build writes
   `firmware/recorder_test/.pio/build/firebeetle/firmware.bin`.
3. To copy the image to the indoor computer, run `deploy/pi/push.sh` from the
   same checkout. For more information, see
   [Update the services](deploy.md#update-the-services).
4. Wait for the recorder's next update check. The recorder stops streaming
   while it downloads the image and restarts, so the Live page shows a short
   gap. To check the update, open the Serial Monitor over USB and send `i`,
   which shows the start of the running firmware's SHA-256. `push.sh` prints
   the start of the image's SHA-256 when it copies the image.

If the new image doesn't stream, the recorder goes back to the previous image
on its own. To install a firmware that has no over-the-air updates, or to
recover a board that doesn't start, flash it over USB.

To build with Arduino IDE 2 instead of PlatformIO, use the esp32 board package
from Espressif or the Raspberry Pi Pico/RP2040/RP2350 package from Earle
Philhower. For the Pico 2 W, set **Tools > Flash Size** to **4MB (FS: 2MB)**.

The recorder sets its clock from NTP, and the receiver names each minute file
from the recorder's timestamps. If the FireBeetle can't reach NTP, it takes the
time from the receiver. For the conditions, see
[Receiver](architecture.md#receiver).

## Placement and weatherproofing

- Mount the microphone 2 to 4 m above the ground, away from the house wall,
  HVAC units, and the street. Point it toward shrubs or trees that birds use.
- Point the microphone down, under a small rain hood. Rain that hits the
  microphone makes noise that hides birdsong.
- Use a foam windscreen with a fur cover on the microphone.
- Put the electronics in an IP65 enclosure.

## Outdoor build candidates

Choose outdoor parts after bench tests measure power. Candidate parts for a
low-power build:

- 5 to 6 W, 6 V solar panel and mount
- BQ24074 solar charger board and a 10 kΩ NTC thermistor
- Protected 18650 cell of about 3.5 Ah, with a holder, or a one-cell LiPo
- 3.3 V buck-boost regulator module
- MAX17048 fuel gauge breakout and RV-3028 RTC breakout
- IP65 enclosure, cable glands, an acoustic vent membrane, a fur windscreen, a
  rain hood, desiccant, and M8 or M12 connectors for microphone pods

## Possible extensions

### Counting individual birds

BirdNET reports whether a species is present, not how many birds sing. Two
microphones 20 to 30 cm apart can set a lower bound: the delay between them
(*time difference of arrival*, up to about 1 ms) gives a sound's direction,
and the same species from two clearly different directions within a few
seconds means at least two birds. The board then needs two microphone inputs,
such as two I²S or PDM MEMS microphones on one bus, so decide before you
build. The method gives direction only, in one plane, and reflections add
false directions, so treat the result as a minimum.

With one microphone, overlapping songs of a species with a known song length
also show two or more birds, less reliably.

### More than one station

See [Multi-station expansion](plans/multi-station.md). Every detection has a
`station_id`.
