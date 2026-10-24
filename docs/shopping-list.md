# Shopping list

Parts for the recorder prototype. Options and reasoning are in
[hardware-design.html](hardware-design.html). Prices are rough.

## Local store (Vetco): benchtop test 1

- [ ] [FireBeetle 2 ESP32-E (D74)](https://vetco.net/products/vupn2235_firebeetle_2_esp32-e_battery_ready_-_iot_microcontroller_supports_wi-fi__bluetooth_d74), ~$15
- [ ] 2× [INMP441 I²S mic module](https://vetco.net/products/omnidirectional-microphone-module-inmp441-high-precision-i2s): one that moves between boards, one spare
- [ ] 1× [400-point breadboard](https://vetco.net/products/vupn6669_400-point_breadboard), ~$5: boards swap on and off it
- [ ] [M-M jumper wires (D77)](https://vetco.net/products/tea-a-2377_12_male-male_rainbow_breadboard_jumper_wire_for_arduino_-_10_pack_d77) and [M-F jumper wires (D78)](https://vetco.net/products/vupn6982_12_male-female_rainbow_breadboard_jumper_wire_for_arduino_-_10_pack_d78), a pack of each
- [ ] [40-pin male header strips](https://vetco.net/products/40-pin-breakable-male-single-row-header-connector-pc-mount-0-1-spacing), a couple (for the Pico 2 W, if it has no headers)
- [ ] 1× [32 GB microSD card](https://vetco.net/products/vetsd32_micro_sd_card_32_gb_with_adapter_32gb): moves between the breakout and the XIAO ESP32S3's own slot (fine for the bench; high-endurance cards for outdoors later)
- [ ] USB-C / micro-USB cables for flashing, if needed

## Online: benchtop test 1

**Digi-Key or Mouser** (not Amazon: the PPK2 listings there are third-party
resellers with muddled descriptions; buy from an authorized distributor)
- [ ] [Nordic Power Profiler Kit II](https://www.nordicsemi.com/ppk2) (part nRF-PPK2), ~$100

**Amazon**
- [ ] [Seeed Studio XIAO ESP32S3 Sense](https://www.amazon.com/Seeed-Studio-XIAO-ESP32-Sense/dp/B0C69FFVHH), ~$14–20 (also direct from [Seeed](https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html))
- [ ] 1× [Adafruit 4682 microSD breakout, 3 V](https://www.amazon.com/Micro-SDIO-Card-Breakout-Board/dp/B09K6XVS9R): pick the listing branded Adafruit; several look-alike listings use the same name. Moves between the Pico 2 W, the FireBeetle and the XIAO nRF52840 (the XIAO ESP32S3 Sense has its own slot). Also at [Adafruit](https://www.adafruit.com/product/4682), ~$3.50
- [ ] JST-PH 2.0 2-pin pigtails, a small pack of male/female pairs (e.g. [this 20-pair kit](https://www.amazon.com/XUGERIP-JST-2-0mm-Pin-Connector/dp/B0D9R33S9T)), to connect the PPK2 to the battery inputs. Any brand is fine; check it has wires on both genders
- [ ] *Optional:* Seeed Studio XIAO nRF52840 Sense, ~$16 (search Amazon for the Seeed-branded listing, or [Seeed direct](https://www.seeedstudio.com/Seeed-XIAO-BLE-Sense-nRF52840-p-5253.html)), for the BLE comparison
- [ ] *Optional:* inline USB-C power meter (e.g. FNIRSI FNB58), ~$20–40
- [ ] *Optional:* foam mic windscreens, a small pack

## Bench tools: benchtop test 1

Already have: multimeter, soldering iron, phone (for playing reference bird
recordings at a fixed volume and distance, so comparisons are repeatable),
and an oscilloscope.

- [ ] *Optional:* **USB-to-serial adapter, 3.3 V** (CP2102 or FTDI, ~$5–10), or a
      [Raspberry Pi Debug Probe](https://www.raspberrypi.com/products/debug-probe/)
      (~$12; also does SWD debugging on the Pico 2 W). While the PPK2 powers
      a board, its USB cable must be unplugged, or USB powers the board and
      spoils the measurement. Log messages then come out over this adapter:
      connect only TX, RX and ground, never its power pin. Not essential:
      without it, the firmware can write its log to the SD card or send it
      with each upload instead, and the PPK2's logic inputs show which state
      the board is in.
- [ ] *Skip for now:* **8-channel 24 MHz logic analyzer** ("Saleae-compatible" clone, ~$10–15,
      used with the free sigrok PulseView app). Decodes the mic's I²S and the
      SD card's SPI traffic across all the lines at once. Skip it if your
      oscilloscope has I²S/SPI decoding and enough channels (I²S needs 3).
      Run the SD bus at 4 MHz or slower while debugging with a cheap
      analyzer.

**The oscilloscope** (Rigol DHO804 upgraded to DHO924: 4 channels, deep
memory) covers the logic analyzer's job for this test: I²S needs 3 channels
and SPI 4, both far below its bandwidth. Capture traces and decode them
afterwards, on the scope if its decoder supports the protocol, or by
exporting CSV into PulseView. It's also the tool for checking the 3.3 V rail
dipping during wifi bursts (a cause of random resets).

### Estimated cost

| | Items | Est. |
| --- | --- | --- |
| Vetco | FireBeetle $15, 2× INMP441 ~$10, breadboard $5, jumpers $9, headers ~$2, microSD card ~$9 | **~$50** |
| Online, required | PPK2 ~$100 + shipping (Digi-Key/Mouser), XIAO ESP32S3 Sense ~$14–20, microSD breakout ~$5–10, JST-PH pigtail pack ~$8 (Amazon) | **~$135–150** |
| Bench tools (optional) | Serial adapter or Debug Probe ~$10 | ~$0–10 |
| **Total, required** | | **~$185–200** |
| Online, optional | XIAO nRF52840 Sense $16, USB-C meter ~$30, windscreens ~$8 | ~$55 |
| **Total with everything** | | **~$250–265** |

The PPK2 is almost half the cost; it's also reusable for every board after this one. INMP441 and microSD card prices at Vetco are guesses; the rest are from the linked pages.

**Shared parts:** the PPK2 measures one board at a time, so boards are
tested one after another, and the mic and microSD breakout move between them
(6 wires each), along with the one microSD card and breadboard. The cost is
no side-by-side recordings on two boards at once.

Details and reasoning for every item are below.

## Benchtop test 1: data acquisition, uplink, power profiling

**Goal:** on each microcontroller, record from the same mic to microSD,
upload the files to the indoor computer (wifi; BLE on the nRF), and profile
power through every state (recording, writing, uploading, sleeping). No
solar yet: boards run from a bench supply that also measures current.

**Boards compared**

| Board | Chip | Have? | Why it's in the test |
| --- | --- | --- | --- |
| Raspberry Pi Pico 2 W | RP2350 + CYW43439 | have | Baseline; no PSRAM |
| FireBeetle 2 ESP32-E | ESP32 | buy | Low-power board design; no PSRAM |
| Seeed XIAO ESP32S3 Sense | ESP32-S3, 8 MB PSRAM | buy | The current pick; has microSD slot and a PDM mic on its add-on board |
| Seeed XIAO nRF52840 Sense | nRF52840 | buy (optional) | Lowest-power class; BLE uplink to the nRF52840 dongle |
| nRF52840 USB dongle | nRF52840 | have | BLE receiver on the indoor computer |

### Measuring power

- [ ] **Nordic Power Profiler Kit II (PPK2)** (~$100). The key item. It
      powers the board itself (0.8–5 V, standing in for the battery) and
      records current from ~0.2 µA to 1 A, 100,000 times a second, so it
      captures deep sleep, recording and short wifi bursts in one trace.
      Works with any board, not just Nordic. Its 8 logic inputs can log
      which state the firmware is in (one GPIO per state), so the trace
      labels itself.
- [ ] **JST-PH 2.0 pigtail cables** (~$6 for a pack). To feed the PPK2 into
      the FireBeetle's and XIAOs' battery inputs, so the measurement
      includes the board's own regulator and charger, as it would on a
      battery.
- [ ] *Optional:* **inline USB-C power meter** (~$20–40, e.g. FNIRSI FNB58).
      Quick whole-day Wh totals without a computer attached. Includes the
      USB-serial chip's draw, so it reads high on some boards.

### Data acquisition

- [ ] **FireBeetle 2 ESP32-E** (~$15; item D74 at your store).
- [ ] **Seeed XIAO ESP32S3 Sense** (~$14).
- [ ] *Optional:* **Seeed XIAO nRF52840 Sense** (~$16), for the BLE
      comparison.
- [ ] **2× INMP441 I²S MEMS mic modules** (local store, ~$3–5 each): one
      that moves between boards, so every board is tested with the same mic,
      plus a spare in case a clone module is bad. Same wiring and I²S
      interface as the ICS-43434, so swapping later is a drop-in. Noisier
      (SNR 61 vs 65 dB) and draws ~1.4 mA vs ~0.5 mA: fine for testing
      acquisition, uplink and board power, but expect BirdNET to pick up
      fewer distant birds than the final mic will. (The XIAO boards'
      built-in mics are worth recording too, as a comparison.)
- [ ] *Later:* ICS-43434 breakouts (online) for the audio-quality test.
- [ ] **1× microSD breakout (SPI, 3.3 V)** (~$3.50). Moves between the
      Pico 2 W, the FireBeetle and the XIAO nRF52840; the XIAO ESP32S3 Sense
      has its own slot. All the boards use 3.3 V logic, so the cheaper
      3 V-only breakout is fine.
- [ ] **1× 32 GB microSD card** (~$8–10), moved between boards.
- [ ] **1× half-size breadboard, M-M and M-F jumper wires, header pins**
      (~$15), if you don't have them. The Pico 2 W needs headers unless
      it's the "WH".
- [ ] **USB-C / micro-USB cables** for flashing each board, if needed.
- [ ] **Foam mic windscreens** (~$5 for a pack), for recording at an open
      window.

**Rough total:** see "Estimated cost" at the top (~$185–200 required,
~$250–265 with the optional items).

**Nothing to buy for the uplink:** wifi goes to the existing router; the
indoor computer runs a small upload receiver (to be written) that drops
finished files into `data/incoming/` for `analyzer.py`.

### What the test measures

1. Average current while recording only (wifi off), per board.
2. Energy per uploaded MB over wifi (and BLE on the nRF), including
   connect time.
3. microSD write bursts and idle current.
4. Deep-sleep current with the SD card powered off.
5. BirdNET results from each board's files vs a phone recording at the
   same window, same time.

These replace the estimates on the hardware page with measurements and
decide the board.

## Later: outdoor build (after measuring)

Hold off until the bench numbers are in; sizes may change.

- [ ] 5–6 W, 6 V solar panel + mount
- [ ] BQ24074 solar charger board + 10 k NTC thermistor
- [ ] Protected 18650 cell (~3.5 Ah) + holder, or a 1-cell LiPo
- [ ] 3.3 V buck-boost regulator module
- [ ] MAX17048 fuel gauge breakout, RV-3028 RTC breakout
- [ ] IP65 enclosure, cable glands, acoustic vent membrane, fur windscreen,
      rain hood, desiccant, M8/M12 connectors for mic pods

## Already have

- Raspberry Pi Pico 2 W
- nRF52840 USB dongle
