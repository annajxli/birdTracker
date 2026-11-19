# Microphone options

This page compares microphone changes for the outdoor recorder. None of these
options is built or tested, and none is shown to improve BirdNET
identification. Figures are manufacturer specifications, not measurements.
Prices are in USD, were checked October 26, 2026, and need checking again
before you order. For the recorder as built, see
[Recorder hardware](../hardware.md).

## Summary

| Option | Self-noise (EIN) | SNR | Price | Changes to the recorder |
| --- | --- | --- | --- | --- |
| INMP441 (baseline) | 33 dBA | 61 dBA | Already owned | None |
| Wind protection and mounting | No change | No change | About $10 to $30, estimated | Mechanical only |
| ICS-43434 breakout | 29 dBA | 65 dBA | $8.95, discontinued | Swap the breakout |
| PUI AOM-5024L-HD-R capsule on the ESP32 | About 14 dBA, derived | 80 dB | About $4, stock unconfirmed | Preamp, audio ADC, and firmware |
| Sonorous Objects SO.1 (EM272) on a Pi | 14 dBA | 80 dB | From $109.99, plus a USB interface | Moves recording to a Pi |

Lower self-noise matters only when the microphone's own noise, not wind,
traffic, or other ambient sound, limits what you hear. Evaluate wind,
vibration, clipping, and microphone noise separately before you choose.

## Options

- **Wind protection and mounting.** Foam or fur, a rain hood, and vibration
  isolation reduce low-frequency wind, vibration, and rain noise. Keep the
  sound port clear and dry. No electrical or firmware changes.
- **ICS-43434 breakout.** 4 dB lower noise than the INMP441, with similar
  sensitivity and overload point. Adafruit lists it as discontinued, so use it
  only for a comparison. It's the same standard I²S interface, so connect it
  to the pins that `PIN_BCLK`, `PIN_WS`, and `PIN_DIN` name, tie L/R to
  ground, and check bit alignment and gain with a known tone.
- **PUI AOM-5024L-HD-R electret capsule.** About 19 dB lower noise than the
  INMP441 if the front end is quiet enough. The datasheet's maximum SPL uses a
  different criterion from the INMP441's, so check loud-call headroom. It
  needs a bias resistor, an AC-coupled low-noise preamp, and an I²S audio ADC.
  Never connect the capsule directly to an ESP32 pin. In firmware, configure
  the ADC and recalculate gain and `SAMPLE_SHIFT`. This is a topology, not a
  finished circuit.
- **Sonorous Objects SO.1 (EM272) on a Pi.** An assembled, shielded
  microphone with the same noise advantage. It needs a USB audio interface
  with plug-in power (3.5 mm variant) or phantom power (XLR variant), and
  ALSA capture with 1-minute chunking on a Pi, with automatic gain control
  off. The ESP32 no longer records.

## Plan gain for an analog microphone

To choose the preamp gain, use the following formula, and leave headroom for
transients:

```
G <= V_FS_RMS / (S_V_PER_PA * 10^((L_MAX_SPL - 94) / 20))
```

Replace the following:

- `G`: the maximum voltage gain from the microphone to the ADC input.
- `V_FS_RMS`: the ADC's full-scale input, in volts RMS.
- `S_V_PER_PA`: the microphone's sensitivity, in volts RMS per pascal: about
  0.0398 for the EM272 (−28 dBV/Pa) and 0.0631 for the PUI capsule
  (−24 dBV/Pa).
- `L_MAX_SPL`: the loudest level, in dB SPL, that must record without
  clipping.

The EM272's 14 dBA self-noise is about 4 µV RMS at its output, and the PUI
capsule's is about 6.3 µV. Keep the preamp's input-referred noise well below
these.

## Firmware settings to check

In `firmware/recorder_test/recorder_test.ino`: `SAMPLE_RATE`, `SAMPLE_SHIFT`,
`HIGHPASS_HZ`, the `PIN_` constants, `micBegin()`, and `toPcm16()`.

## Compare microphones

1. Record with both microphones at the same time and place.
2. Analyze both with the same detector settings.
3. Count calls confirmed by ear, audible calls BirdNET misses, and false
   positives. Don't compare confidence values alone.
4. Include quiet dawns, wind, and loud nearby calls.

## Sources

- [INMP441 datasheet](https://microcontroller-course.web.cern.ch/Project_Material/resources/INMP441.pdf)
- [Adafruit ICS-43434 breakout, with the discontinuation notice](https://www.adafruit.com/product/6049)
- [ICS-43434 datasheet, version 1.2](https://cdn.sparkfun.com/assets/a/9/c/9/1/DS-000069-ICS-43434-v1.2.pdf)
- [DigiKey listing for the PUI AOM-5024L-HD-R](https://www.digikey.com/en/products/detail/pui-audio-inc/AOM-5024L-HD-R/7898328)
- [PUI AOM-5024L-HD-R datasheet](https://api.puiaudio.com/filename/AOM-5024L-HD-R.pdf)
- [Sonorous Objects SO.1 listing and specifications](https://sonorousobjects.nyc/products/so-1-omni-microphone)
- [Primo EM272Z1 capsule specifications](https://micbooster.com/product/primo-em272/)
