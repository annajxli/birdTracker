# Microphone options

This page compares microphone changes for the outdoor recorder. None of these
options is built or tested, and none is shown to improve BirdNET
identification. The figures are manufacturer specifications and planning
arithmetic, not measurements. For the recorder as built, see
[Recorder hardware](../hardware.md).

Prices are in USD, exclude tax and shipping, and were checked October 26, 2026.
Check price and stock again before you order.

## Summary

The following table compares the options with the INMP441 that the bench
recorder uses:

| Option | Self-noise (EIN) | SNR | Price | Changes to the recorder |
| --- | --- | --- | --- | --- |
| INMP441 (baseline) | 33 dBA | 61 dBA | Already owned | None |
| Wind protection and mounting | No change | No change | About $10 to $30, an estimate | Mechanical only |
| ICS-43434 breakout | 29 dBA | 65 dBA | $8.95, discontinued | Swap the breakout |
| PUI AOM-5024L-HD-R capsule on the ESP32 | About 14 dBA, derived | 80 dB | See [the PUI section](#pui-aom-5024l-hd-r-capsule-on-the-esp32) | Preamp, audio ADC, and firmware changes |
| Sonorous Objects SO.1 (EM272) on a Pi | 14 dBA | 80 dB | From $109.99, plus a USB interface | Moves recording to a Pi |

A lower self-noise matters only when the microphone's own noise, not wind,
traffic, or other ambient sound, limits what you hear. Evaluate wind,
mechanical vibration, clipping, and microphone noise separately before you
choose a replacement.

## Wind protection and mounting

- **Price:** about $10 to $30 for basic wind protection and mounting materials.
  This is a budgeting estimate, not a quoted kit or a fit for a specific
  enclosure.
- **Expected effect:** less low-frequency wind energy, vibration, and rain
  impact noise, which can mask or clip calls. It doesn't change electronic
  self-noise. The benefit depends on the existing mounting and weather
  protection.
- **Hardware changes:** add acoustically transparent foam or fur, a rain hood,
  and vibration isolation. Keep the microphone's sound port unobstructed, and
  don't let water pool at it. No electrical changes.
- **Firmware changes:** none. To compare, record at the same gain and
  placement before and after the change.

## ICS-43434 breakout

- **Price and sourcing:** $8.95 at Adafruit. Adafruit lists the breakout as
  discontinued and suggests the SPH0645LM4H as a replacement. Because the chip
  is discontinued, use it only for a small comparison, not as a standard part
  for more stations.
- **Expected effect:** the datasheet's equivalent input noise is 29 dBA,
  4 dB lower than the INMP441's 33 dBA. Faint calls can stand out more in quiet
  conditions, and wind or traffic can erase the difference. Sensitivity and
  overload point are similar, so this isn't a gain or headroom upgrade.
- **Hardware changes:** replace the breakout. On the FireBeetle, connect 3.3 V
  and ground, and connect the clock, word-select, and data pins to the pins
  that `PIN_BCLK`, `PIN_WS`, and `PIN_DIN` in
  `firmware/recorder_test/recorder_test.ino` name. Tie the L/R pin to ground
  for the left channel. Go by the labels on the breakout, not the order of its
  pins. If the breakout has no 100 nF bypass capacitor on VDD, add one. No
  preamp, ADC, or master clock is needed.
- **Firmware changes:** none expected, because the interface is the same
  standard I²S as the INMP441's: 24-bit samples in 32-bit left-channel slots.
  Check the bit alignment and gain with a known tone before you trust
  `toPcm16()`. With 64 bit clocks per frame at a 32 kHz sample rate, the bit
  clock is 2.048 MHz. Check it on the oscilloscope.

## PUI AOM-5024L-HD-R capsule on the ESP32

- **Price and sourcing:** sold by DigiKey US. The price and stock weren't
  confirmed: one check showed $4.58 in stock, and another showed $3.67 with no
  stock and a 24-week lead time. Check before you order. The price excludes
  the preamp, ADC, circuit board, connector, and enclosure.
- **Expected effect:** the datasheet gives 80 dB SNR at −24 dBV/Pa, which
  implies about 14 dBA equivalent input noise, about 19 dB lower than the
  INMP441's. A quiet enough front end can keep the structure of faint calls.
  It doesn't change the acoustic ratio of birdsong to traffic. The datasheet
  gives a maximum of 110 dB SPL at under 3% THD. The INMP441 datasheet gives a
  maximum acoustic input of 120 dB SPL and 3% THD at 105 dB SPL. These use
  different criteria, so check loud-call headroom instead of assuming it
  improves.
- **Hardware changes:** replace the digital microphone with an electret front
  end:
  - Connect the capsule's negative terminal to analog ground.
  - Bias the positive terminal through a resistor from a quiet supply. The
    datasheet's current specification uses 2.2 kΩ and 3 V. Choose the bias for
    your circuit from the datasheet, and don't treat those values as a
    universal requirement.
  - AC-couple the positive terminal into a low-noise preamp, and feed the
    preamp into an audio ADC with a standard I²S output and 3.3 V logic. Choose
    the coupling capacitor from the preamp's input resistance and the
    low-frequency corner that you want.
  - If the ADC can run as an I²S target, connect its bit clock, word clock,
    and data output to the pins that `PIN_BCLK`, `PIN_WS`, and `PIN_DIN` name.
    If it needs a master clock or an I²C or SPI configuration bus, add them,
    with its reference, bias, and supply filtering.
  - Never connect the capsule directly to an ESP32 pin.
- **Firmware changes:** configure the ADC's word format, clocks, and channel
  mapping, and its registers if it has them. Recalculate the analog gain and
  `SAMPLE_SHIFT` against the ADC's full scale, instead of reusing the MEMS
  values. Keep the upload format and sample timing.

This section describes a circuit topology, not a circuit that's ready to
build. To finish it, choose a preamp and an ADC, and use the exact capsule
datasheet and the ADC's input common-mode, impedance, full-scale, and clock
requirements.

## Sonorous Objects SO.1 (EM272) on a Pi

- **Price and sourcing:** made in New York City. The listing starts at
  $109.99, without a USB interface. Its variants showed both "in stock" and
  "sold out", so confirm the 3.5 mm or XLR variant that you want, and its price,
  before you order.
- **Expected effect:** the manufacturer lists 80 dB SNR and 14 dBA self-noise,
  about the same 19 dB advantage over the INMP441 as the PUI capsule, if the
  interface is quiet enough. It's an assembled, shielded microphone, so you
  don't design a capsule front end. Neither the packaging nor USB capture
  improves detection by itself compared with a correctly built electret
  circuit.
- **Hardware changes:**
  - Add a USB audio interface with a real microphone input. For the 3.5 mm
    variant, the input must supply plug-in power. A line input or a headphone
    adapter doesn't work. Check the cable's pinout against the interface's
    jack.
  - The XLR variant uses a cable that contains special circuitry so that the
    microphone runs on 48 V phantom power. It needs an interface with phantom
    power.
  - Connect the interface to the Pi's USB port. The ESP32 no longer records
    this microphone.
  - Keep the microphone cable shielded and away from Wi-Fi and clock circuits.
- **Software changes:** add ALSA capture and 1-minute chunking on the Pi, and
  feed the files into the analyzer and the privacy step that runs before
  upload. Choose a sample rate that the interface supports, resample
  explicitly if you need to, set the hardware gain, and turn off automatic
  gain control and noise suppression. This changes the recording
  architecture, because the ESP32 can't receive USB audio.

## Plan gain and noise for an analog microphone

To choose the preamp gain for an analog microphone, use the following
formula, and then leave extra headroom for transients:

```
G <= V_FS_RMS / (S_V_PER_PA * 10^((L_MAX_SPL - 94) / 20))
```

Replace the following:

- `G`: the maximum linear voltage gain from the microphone to the ADC input.
- `V_FS_RMS`: the ADC's full-scale input, in volts RMS.
- `S_V_PER_PA`: the microphone's sensitivity, in volts RMS per pascal. At
  94 dB SPL, which is 1 Pa, this is the microphone's output voltage.
- `L_MAX_SPL`: the loudest sound pressure level, in dB SPL, that must record
  without clipping.

The following values apply to the two analog options:

- **EM272 at −28 dBV/Pa:** `S_V_PER_PA` is about 0.0398, or 39.8 mV RMS at
  94 dB SPL. Its 14 dBA self-noise is about 4 µV RMS, A-weighted, at the
  microphone's output.
- **PUI capsule at −24 dBV/Pa:** `S_V_PER_PA` is about 0.0631. Its derived
  14 dBA input noise is about 6.3 µV RMS, A-weighted, at the output.

To keep the microphone's advantage, keep the preamp's input-referred noise well
below these values, with the same weighting and bandwidth. Don't compare an
analog sensitivity in dBV/Pa directly with a digital sensitivity in dBFS.

## Firmware settings to check

The FireBeetle settings are in `firmware/recorder_test/recorder_test.ino`.
For any microphone change, check the following:

- `SAMPLE_RATE`
- `SAMPLE_SHIFT`, the digital gain
- `HIGHPASS_HZ`
- The pin constants `PIN_BCLK`, `PIN_WS`, and `PIN_DIN`. The FireBeetle and
  the Pico 2 W use different pins.
- `micBegin()`, the I²S configuration
- `toPcm16()`, the conversion to 16-bit PCM

## Compare microphones

To decide whether a microphone helps, compare it with the INMP441 as follows:

1. Record with both microphones at the same time and place, at matched
   acoustic levels.
1. Analyze both recordings with the same detector settings.
1. Count calls that you confirm by ear, audible calls that BirdNET misses, and
   false positives. Don't compare confidence values alone.
1. Include quiet dawn recordings, wind, and loud nearby calls.

Keep the privacy step that runs before upload in the recording path for every
test.

## Sources

- [INMP441 datasheet](https://microcontroller-course.web.cern.ch/Project_Material/resources/INMP441.pdf)
- [Adafruit ICS-43434 breakout, with the discontinuation notice](https://www.adafruit.com/product/6049)
- [ICS-43434 datasheet, version 1.2](https://cdn.sparkfun.com/assets/a/9/c/9/1/DS-000069-ICS-43434-v1.2.pdf)
- [DigiKey listing for the PUI AOM-5024L-HD-R](https://www.digikey.com/en/products/detail/pui-audio-inc/AOM-5024L-HD-R/7898328)
- [PUI AOM-5024L-HD-R datasheet](https://api.puiaudio.com/filename/AOM-5024L-HD-R.pdf)
- [Sonorous Objects SO.1 listing and specifications](https://sonorousobjects.nyc/products/so-1-omni-microphone)
- [Primo EM272Z1 capsule specifications](https://micbooster.com/product/primo-em272/)
