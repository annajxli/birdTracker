# Recorder hardware

This page describes the outdoor recorder: the decisions that are fixed, the
candidate builds, how to build the bench recorder, and candidate parts for
the outdoor build. For how the recorder's audio reaches the dashboard, see
[Architecture](architecture.md).

## Fixed decisions

The following decisions apply to every candidate build:

- The recorder only records audio and sends it indoors. BirdNET runs on the
  indoor computer.
- Seattle winters set the power budget.
- The recorder runs on solar power. A cable from the house is the fallback.
- The recorder records continuously through daylight by default, so solar
  sizing assumes continuous recording.

## Candidate builds

[Recorder hardware options](design/hardware-design.html) compares three
builds, with block diagrams, energy estimates, recording schedules, and the
options for each component:

- **A. Low-power microcontroller, one microphone.** For example, an ESP32-S3
  or nRF5340 with a digital MEMS microphone.
- **B. Low-power microcontroller, two microphones.** Build A with a stereo
  pair, for [counting individual birds](#counting-individual-birds).
- **C. Raspberry Pi Zero 2 W.** A Linux board with an analog microphone and a
  sound card. It has the best audio and needs the least firmware, at about 10
  times the energy of build A.

If a cable from the house (about 5 to 10 m) can reach the microphone, the
setup with the fewest parts is a microphone on the cable and a computer
indoors on wall power, with no solar power or Wi-Fi link.

The energy figures on that page are estimates. Bench tests replace them with
measurements. For bench results, see [Bench test 1](bench-test-1.md). For
microphone changes, such as a quieter capsule or better wind protection, see
[Microphone options](plans/microphone-options.md).

## Build the bench recorder

The bench recorder is an Arduino sketch in `firmware/recorder_test/` for two
boards: the FireBeetle 2 ESP32-E and the Raspberry Pi Pico 2 W. It's for bench
testing only. A production recorder uses ESP-IDF on an ESP32 or the Pico SDK
on a Pico.

On the FireBeetle, the sketch streams audio to the receiver as soon as it has
Wi-Fi and the time, so it records unattended. The receiver cuts the stream into
1-minute files. The Pico 2 W records short files and uploads them on command.

### Before you begin

Make sure that you have the following:

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

1. Install VS Code with the PlatformIO IDE extension. On first launch, the
   extension installs its toolchain. The first build for each board downloads
   that board's compiler and libraries, as listed in
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

To build with Arduino IDE 2 instead of PlatformIO, use the esp32 board package
from Espressif or the Raspberry Pi Pico/RP2040/RP2350 package from Earle
Philhower. For the Pico 2 W, set **Tools > Flash Size** to **4MB (FS: 2MB)**.

The recorder sets its clock from NTP, and the receiver names each minute file
from the recorder's timestamps. To keep timestamps correct, the recorder needs
NTP access.

## Placement and weatherproofing

Follow these guidelines when you mount a recorder outdoors:

- Mount the microphone 2 to 4 m above the ground, away from the house wall,
  HVAC units, and the street. Point it toward shrubs or trees that birds use.
- Point the microphone down, under a small rain hood. Rain that hits the
  microphone makes noise that hides birdsong.
- Use a foam windscreen with a fur cover on the microphone.
- Put the electronics in an IP65 enclosure.

## Outdoor build candidates

Choose outdoor parts after bench tests measure power. The candidate parts for
a low-power build are the following:

- 5 to 6 W, 6 V solar panel and mount
- BQ24074 solar charger board and a 10 kΩ NTC thermistor
- Protected 18650 cell of about 3.5 Ah, with a holder, or a one-cell LiPo
- 3.3 V buck-boost regulator module
- MAX17048 fuel gauge breakout and RV-3028 RTC breakout
- IP65 enclosure, cable glands, an acoustic vent membrane, a fur windscreen, a
  rain hood, desiccant, and M8 or M12 connectors for microphone pods

## Indoor computer

Any always-on computer on wall power can run the pipeline. On the development
Mac, BirdNET analyzed 2 minutes of audio in about 3 seconds. The pipeline also
runs on a Raspberry Pi 3B+ with the `lite` engine. For setup steps, see
[Set up the indoor computer](deploy.md#set-up-the-indoor-computer).

## Possible extensions

### Counting individual birds

BirdNET reports whether a species is present in each 3-second segment, not how
many birds are singing. Two wrens singing at once look the same as one. A
stereo recorder can set a lower bound on the count:

- **Method.** Two microphones 20 to 30 cm apart record one stereo file. A
  sound reaches one microphone up to about 1 ms before the other, and the
  delay gives its direction. This technique is called *time difference of
  arrival* (TDOA). If BirdNET detects the same species from two clearly
  different directions within a few seconds, at least two birds are present.
- **Result.** A minimum bird count per bout, and a marker on the daily
  timeline when two or more birds sing.
- **Hardware impact.** A second microphone costs little, but decide before you
  build: the board needs two microphone inputs. On an ESP32 or nRF5340, two
  I²S or PDM MEMS microphones share one bus. On a Pi, use a stereo USB
  interface. Both microphones need the same rain hood and windscreen.
- **Limits.** The method gives direction only, not distance, and only in the
  plane of the two microphones. Two birds in the same direction look like one.
  Reflections from the house and fences add false directions. Treat the result
  as a minimum, not a count.

Without stereo, a second song that starts before the first one ends also
shows two or more birds, if the species' song length is known. This approach
works with one microphone but is less reliable. Try it in the analysis first.

### More than one station

A second microphone in a different habitat, such as the front yard, picks up
birds that the first one misses. Two microphones that hear the same bird also
confirm each other's detections. Every detection has a `station_id`.
