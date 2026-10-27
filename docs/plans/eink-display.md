# E-paper display

This page proposes a color e-paper screen that shows what the station hears.
Nothing on this page is built, bought, or tested. Prices are estimates that
weren't checked against a store; check them before you order.

## How it works

The indoor computer draws the screen, and the screen only shows it:

1. A new `display.py` on the indoor computer renders an 800 × 480 image from
   data it already has: detections, weather, and recorder health.
2. The receiver's HTTP server serves the image on the home network, for
   example at `http://pio.local:8765/display.png`.
3. The display wakes on a timer, downloads the image over Wi-Fi, draws it,
   and goes back to deep sleep.

This design keeps layout changes on the indoor computer, so the display's
firmware never changes. The image doesn't leave the home network, so the
display doesn't need the website's password. Because the display is awake
only for a few seconds per refresh, a battery lasts for months.

## Hardware

A 7.3-inch, 800 × 480 Spectra 6 panel shows six colors: black, white, red,
yellow, blue, and green. A refresh takes about 15 to 20 seconds, which suits
an image that changes every few minutes.

The following table lists the candidates:

| Option | What it includes | Price, estimated |
| --- | --- | --- |
| Seeed reTerminal E1002 | Spectra 6 panel, ESP32-S3, battery, and case | About $100 to $130 |
| Waveshare 7.3-inch Spectra 6 panel with an ESP32 driver board | Panel and driver board; you add firmware and a case | About $90 |
| Pimoroni Inky Impression 7.3-inch | Spectra 6 panel as a Raspberry Pi HAT; needs a Pi Zero | About $90, plus the Pi |

The reTerminal E1002 needs the least work. A monochrome 7.5-inch panel, such
as the one in TRMNL, refreshes faster but can't show the
[painted species art](species-art.md) in color.

## Layout

The following sketch shows the proposed layout:

```
┌──────────────────────────────────────────────────────────────┐
│ LAST HEARD                          │ TODAY · 23 species      │
│ Dark-eyed Junco          [picture]  │ Dark-eyed Junco   41 min│
│ 7:42 AM · 3 min ago                 │ Anna's Hummingbird 18   │
│                                     │ Bushtit            12   │
│ new today: Varied Thrush            │ … 19 more               │
├──────────────────────────────────────────────────────────────┤
│ birdsong by hour  ▁▂▅█▇▅▃▂▂▃▄▃▂▁   sunrise ─────── sunset   │
│ 52°F light rain · recorder ok · updated 7:45 AM             │
└──────────────────────────────────────────────────────────────┘
```

- The largest area shows the last bird heard, its picture, how long ago, and
  species heard for the first time that day.
- A list shows the day's species by minutes heard, the same unit as the
  website.
- The bottom row shows birdsong by hour with sunrise and sunset, the weather,
  and whether the recorder is healthy.
- After dark, the screen can show the night's owls instead.

## Steps

1. Write `display.py` and serve its image from the receiver. Render a mock
   from real data to agree on the layout before buying hardware.
2. Set up the display to download the image on a timer.
3. Optionally, print a stand or frame.
