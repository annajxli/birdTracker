# Indoor computer options

This page compares indoor computers for more stations. To build another
station, copy the working Raspberry Pi 3B+ setup, after the indoor computer
checks on the [Status](../status.md#indoor-computer-on-a-raspberry-pi-3b) page
pass. None of the other boards on this page is benchmarked with this pipeline.
For the indoor computer as deployed, see
[Set up the indoor computer](../deploy.md#set-up-the-indoor-computer).

## Recommendation

The Pi 3B+ is the only board that's known to run the whole pipeline, so
copying its hardware and software is the safe choice. Choose another board
only for a reason that you can measure:

- **Pi 4 2 GB:** more memory headroom for later features, such as a privacy
  model. That headroom isn't proven to matter for this project.
- **Pi 4 1 GB:** a cheaper board with a faster CPU and about the same memory
  as the 3B+. It's a candidate to test for lower cost, not a reason to replace
  a working 3B+.
- **Pi 5 1 GB:** more compute, but it doesn't relieve the memory limit.

Compare the complete price of each build, not the board's model number or its
launch price. Don't buy boards for several stations until one candidate runs
the full pipeline for a sustained period without swapping, running out of
memory, overheating, or a growing processing or upload backlog.

## Candidates

The following table lists the candidate boards. Prices are Raspberry Pi's
official USD list prices from its February 2026 and October 2026 posts.
Retailers can charge more. The prices exclude the power supply, case and
cooling, high-endurance microSD card, shipping, tax, and the outdoor recorder.

| Board | RAM | List price | Role |
| --- | --- | --- | --- |
| Pi 3B+ | 1 GB | Not in the price posts | Runs the full pipeline. Copy this setup. |
| Pi 4 1 GB | 1 GB | $35 | Cheaper candidate to test |
| Pi 4 2 GB | 2 GB | $67.50 | Candidate with memory headroom |
| Pi 5 1 GB | 1 GB | $45 | More compute, same memory limit |
| Pi 5 2 GB | 2 GB | $77.50 | More compute and memory headroom |
| Pi Zero 2 W | 512 MB | Not in the price posts | Reduced pipeline only. See [the Zero 2 W limits](#pi-zero-2-w-limits). |

## Pi Zero 2 W limits

The Pi Zero 2 W has a quad-core 1 GHz Cortex-A53 and 512 MB of RAM. It's a
plausible receiver, buffer, and uploader, but not a drop-in replacement for the
full pipeline, for the following reasons:

- **Memory.** The comment on `BATCH` in `pipeline/birdnet_lite.py` records
  the model's peak memory on the development laptop. That peak is a large
  share of 512 MB, before the operating system, receiver, publisher, and Live
  media jobs. A laptop measurement doesn't predict the peak on a Pi.
- **Speed.** Live rendering and cleaning are already expensive on the faster
  3B+.
- **Swap.** Swap doesn't replace enough working memory for a continuous
  pipeline, and it adds SD card wear.

A reduced configuration could use a smaller or quantized model, a batch of
one, jobs that run one at a time, and less Live processing. No such
configuration is chosen or tested, and `birdnet_lite.py` supports only the
model that `MODEL` names. Any reduced configuration needs measurements of
throughput, memory, and backlog on the board itself.

Another design records, buffers, and filters audio on the Zero, and runs
BirdNET and media processing on a larger computer at home. This design changes
how audio moves and what must stay available, and the privacy filter must run
before any audio leaves the house, so it must pass validation first. Don't
send raw audio off site to work around the Zero's memory limit.

## Comparison with BirdNET-Pi

This comparison reviews documentation and source code, as of October 26, 2026.
It isn't a benchmark on the same hardware.

[BirdNET-Pi's overview page](https://birdnet-web.tucmi.de/birdnet-pi/) links to
the Nachtzuster fork of the backend and to a fork with an enhanced interface.
It recommends a Pi 4B or Pi 5, and allows a Pi 3B+ or Zero 2 W with a
lightweight operating system. The
[Nachtzuster repository](https://github.com/Nachtzuster/BirdNET-Pi) describes
TFLite inference and efficiency improvements to its services, and includes a
complete local web application.

Bird Tracker already uses lightweight inference. `pipeline/analyzer.py` uses
the `lite` engine by default, which `pipeline/birdnet_lite.py` implements with
`ai-edge-litert`. The model file is `MODEL`, and the batch size is `BATCH`. The
Pi's dependencies are in `deploy/pi/requirements.txt`. BirdNET-Pi therefore
isn't evidence of a smaller neural network for the Pi. Before you claim memory
or speed gains, compare the model versions, precision, batch size, and runtime
settings.

Bird Tracker also resamples audio, writes the database, encodes media, draws
spectrograms, and publishes to a separately hosted website. Its non-bird
suppression and activity counting differ from a classifier wrapper. Switching
to BirdNET-Pi means adapting it to the ESP32 recorder, to the publishing
formats, and to the privacy step before upload, so it isn't a drop-in
replacement. Switching has no demonstrated performance advantage.

An [older Zero 2 W setup guide](https://github.com/mcguirepr89/BirdNET-Pi/wiki/RPi0W2-Installation-Guide)
is in an archived repository and was last edited in February 2023, so it might
be out of date. It increases swap, lengthens recording chunks, and turns off
optional services. It shows that BirdNET-Pi can run on a Zero 2 W with those
limits, not that the board has headroom for this project's full workload.

## Benchmark plan

To compare boards, run the same recordings on each target board with the full
media pipeline on, and do the following:

1. Run with a batch of one and with the value of `BATCH`.
1. Run each model precision that the model supports.
1. Measure peak resident memory, swap activity, wall time per minute of audio,
   backlog, temperature, and missed samples.
1. Before you accept quantization or a preprocessing change, compare the
   detections that you confirm by ear.

## Sources

- [Raspberry Pi price post, February 2026](https://www.raspberrypi.com/news/more-memory-driven-price-rises/)
- [Raspberry Pi price post, October 2026](https://www.raspberrypi.com/news/price-increases-for-2gb-raspberry-pi-4-and-raspberry-pi-5/)
- [Raspberry Pi Zero 2 W product brief](https://datasheets.raspberrypi.com/rpizero2/raspberry-pi-zero-2-w-product-brief.pdf)
- [BirdNET-Pi overview](https://birdnet-web.tucmi.de/birdnet-pi/)
- [Nachtzuster BirdNET-Pi repository](https://github.com/Nachtzuster/BirdNET-Pi)
- [Older BirdNET-Pi Zero 2 W setup guide](https://github.com/mcguirepr89/BirdNET-Pi/wiki/RPi0W2-Installation-Guide)
