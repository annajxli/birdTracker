---
title: Live
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- The recorder, a minute or two behind: the analyzer draws a spectrogram strip of each minute
     of audio, saves its sound as MP3 and lists that minute's detections in live.json;
     pipeline/publish.py uploads them to R2 and the password Worker serves them under /api/live/.
     This page polls live.json, lays the strips out by their start time and names the birds above
     them. A playhead (the line) marks the moment being shown or heard. Live, it runs far enough
     behind the recording that the next minute has arrived before it gets there; clicking the
     spectrogram moves the playhead there, and the transport buttons (or space, arrow keys, L)
     unmute, step 10 s and return to live. Time always runs: the sound only mutes and unmutes
     (muted to start). The view keeps the playhead in place; scrolling by hand frees the view
     without stopping it. -->

```js
import {speciesHref} from "./components/birds.js";
```

```js
const POLL_SECONDS = 30, MIN_CONF = 0.6, HOUR = 3600e3;
// How much fits across the screen; the viewer's choice is remembered.
const SPANS = [[30, "30 sec"], [60, "1 min"], [300, "5 min"], [900, "15 min"], [3600, "1 hour"]];
const SPAN_KEY = "birdtracker-live-span";
const LIVE = "/api/live/";
const STALE_MINUTES = 10; // no new strip for this long: say the recorder is quiet
const RUN_GAP = 6e3; // detections of one species this close together are one run
const FOLLOW_MARGIN = 75e3; // how far the playhead starts behind the newest audio: about one strip's wait
const time = (d, seconds = false) => d.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", ...(seconds && {second: "2-digit"})});
```

<div class="live-head">
  <p class="sub live-status" id="live-status">Loading…</p>
  <div class="live-controls">
    <div class="live-transport" id="live-transport" hidden>
      <button type="button" class="live-button live-icon" id="live-back" title="Back 10 seconds (←)" aria-label="Back 10 seconds"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/></svg></button>
      <button type="button" class="live-button live-follow" id="live-follow" title="Back to live (L)">Back to live</button>
      <button type="button" class="live-button live-icon" id="live-fwd" title="Forward 10 seconds (→)" aria-label="Forward 10 seconds"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7l5 5-5 5M13 7l5 5-5 5"/></svg></button>
    </div>
    <div class="live-transport" id="live-audio" hidden>
      <button type="button" class="live-button live-icon live-sound" id="live-sound" title="Unmute (space)" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="speaker" d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="icon-off" d="M16 9.5l5 5M21 9.5l-5 5"/><path class="icon-on" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg><span class="live-sound-label"><span class="when-off">Unmute</span><span class="when-on">Mute</span></span></button>
      <button type="button" class="live-button live-boost" id="live-boost" title="Bird boost: quieter rumble, brighter birdsong (B)" aria-pressed="false">Bird boost</button>
      <button type="button" class="live-button live-boost" id="live-hiss" title="Less hiss: turns the treble down between calls (H)" aria-pressed="false">Less hiss</button>
    </div>
    <div class="period-segments live-span" id="live-span" role="group" aria-label="Time shown across the screen"></div>
    <button type="button" class="live-button live-full" id="live-full" title="Fullscreen (F)" aria-label="Fullscreen" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></button>
  </div>
</div>

<div class="live-frame">
  <div class="live-freq" id="live-freq" aria-hidden="true"></div>
  <div class="live-scroller" id="live-scroller" tabindex="0" aria-label="Spectrogram of the recorder's recent audio, newest at the right">
    <div class="live-track" id="live-track"></div>
  </div>
</div>
<div class="live-earlier"><button type="button" id="live-earlier" hidden>Show an earlier hour</button></div>

<div id="live-heard"></div>

```js
const scroller = document.getElementById("live-scroller");
const track = document.getElementById("live-track");
const status = document.getElementById("live-status");
const earlier = document.getElementById("live-earlier");
const heard = document.getElementById("live-heard");
const followButton = document.getElementById("live-follow");
const transport = document.getElementById("live-transport");
const audioControls = document.getElementById("live-audio");
const fwdButton = document.getElementById("live-fwd");
const soundButton = document.getElementById("live-sound");
const fullButton = document.getElementById("live-full");

let strips = []; // from live.json, oldest first
let shownFrom = null; // start of the earliest strip drawn (ms)
let updated = null;
let geo = null; // {t0, pps}: the drawn track's time at x = 0 and its scale
const x = (t) => ((t - geo.t0) / 1e3) * geo.pps;
const tAt = (px) => geo.t0 + (px / geo.pps) * 1e3;
const endOf = (s) => Date.parse(s.start) + s.seconds * 1e3;

// The playhead: the moment shown or heard, marked by a line. Time always runs: with the sound on
// it's the sound's own position, otherwise the wall clock minus `lag` (held at the newest audio
// if the next strip is late). Live means it's just behind the newest audio.
let live = true, lag = null, playhead = null;
// Tracking: the view scrolls to keep the playhead `anchor` of the way across it (where it was
// clicked, or PLAYHEAD_AT); scrolling by hand stops that until the next seek, step or Live.
// While live the playhead keeps to the right edge (LIVE_INSET px in), with nothing newer shown.
const PLAYHEAD_AT = 2 / 3, LIVE_INSET = 8, STEP = 10e3;
const liveAnchor = () => 1 - LIVE_INSET / scroller.clientWidth;
let tracking = true, anchor = PLAYHEAD_AT;
// Sound (muted to start): one audio element for the whole session, so browsers that only allow
// sound after a tap (Safari) keep allowing it from one minute to the next.
let soundOn = false, player = null, current = null, waitingFor = null;
let loads = 0, positioned = false; // the sound has loaded and been moved to its starting point
const playheadLine = Object.assign(document.createElement("div"), {className: "live-playhead"});

const LANE = 22, LANES = 4, SPEC_TOP = LANE * LANES + 6, AXIS_H = 22;
// The spectrogram's height: 160 px, or in fullscreen about half the screen.
let SPEC_H = 160;
const specHeight = () => (document.fullscreenElement ? Math.max(160, Math.round(window.innerHeight * 0.5)) : 160);
const MAX_KHZ = 12; // the strips' top row (spectrogram.py's MAX_HZ)

// Frequency labels, in their own column left of the strips (which scroll past them).
const drawFreqLabels = () => document.getElementById("live-freq").replaceChildren(
  ...[12, 8, 4, 0].map((khz) => {
    const label = document.createElement("span");
    label.textContent = String(khz);
    label.style.top = SPEC_TOP + SPEC_H * (1 - khz / MAX_KHZ) + "px";
    return label;
  }),
  Object.assign(document.createElement("span"), {className: "live-freq-unit", textContent: "kHz", style: `top: ${SPEC_TOP - 16}px`})
);
drawFreqLabels();

let span = 300;
try { span = SPANS.find(([s]) => s === Number(localStorage.getItem(SPAN_KEY)))?.[0] ?? span; } catch {}
const spanControl = document.getElementById("live-span");
spanControl.replaceChildren(); // the preview server re-runs this block on edits
for (const [seconds, label] of SPANS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.dataset.span = seconds;
  b.onclick = () => setSpan(seconds);
  spanControl.append(b);
}
const markSpan = () => { for (const b of spanControl.children) b.setAttribute("aria-pressed", String(Number(b.dataset.span) === span)); };
markSpan();

// Scale: `span` seconds across the visible width.
const pxPerSecond = () => scroller.clientWidth / span;

function setSpan(seconds) {
  if (seconds === span) return;
  span = seconds;
  try { localStorage.setItem(SPAN_KEY, String(span)); } catch {}
  markSpan();
  if (shownFrom !== null) shownFrom = Math.min(shownFrom, Date.parse(strips.at(-1)?.start ?? new Date()) - Math.max(HOUR, span * 1e3));
  draw();
}

// Detections at least `minConf` sure, joined into runs: one per species per stretch of song.
function runs(list, minConf = MIN_CONF) {
  const out = [];
  const open = new Map();
  for (const d of list.flatMap((s) => s.detections).filter((d) => d.confidence >= minConf).sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(d.at);
    const run = open.get(d.common_name);
    if (run && t - run.end <= RUN_GAP) { run.end = t + 3e3; run.best = Math.max(run.best, d.confidence); continue; }
    const r = {name: d.common_name, start: t, end: t + 3e3, best: d.confidence};
    open.set(d.common_name, r);
    out.push(r);
  }
  return out;
}

// Strips are masks (loudness in the alpha channel; spectrogram.py); each is painted through
// colorcet's CET-L5 colormap (near black for silence, through green to yellow-green for loud;
// sampled at 16 stops), with a square root so faint sound shows. Images are loaded once and kept.
const CET_L5 = d3.piecewise(d3.interpolateRgb, "001505 092205 083104 0b4004 104f05 145f06 187008 1c810a 21920c 25a40e 2ab610 2ec812 33db14 4bed15 92f915 d8ff14".split(" ").map((h) => "#" + h));
const lut = d3.range(256).map((i) => d3.rgb(CET_L5(Math.sqrt(i / 255))));
const images = new Map();
function loadImage(url) {
  if (!images.has(url)) images.set(url, new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  }));
  return images.get(url);
}
async function paintStrip(canvas, url, strip) {
  let img;
  try { img = await loadImage(url); } catch { return; }
  const ctx = canvas.getContext("2d", {willReadFrequently: true});
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const c = lut[px[i + 3]];
    px[i] = c.r; px[i + 1] = c.g; px[i + 2] = c.b; px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  // Dropouts the receiver filled with silence: hatched, so they don't pass for quiet audio. The
  // hatching is anchored to the track, so it runs on unbroken from one strip into the next.
  const left = parseFloat(canvas.style.left) || 0;
  for (const [a, b] of strip.gaps ?? []) {
    const x0 = Math.floor(a / strip.seconds * canvas.width), x1 = Math.ceil(b / strip.seconds * canvas.width);
    ctx.fillStyle = "#14110d";
    ctx.fillRect(x0, 0, x1 - x0, canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, canvas.height);
    ctx.clip();
    ctx.strokeStyle = "rgba(232, 224, 207, 0.28)";
    ctx.lineWidth = 1;
    for (let k = Math.floor((x0 + left - canvas.height) / HATCH) * HATCH - left; k < x1; k += HATCH) {
      ctx.moveTo(k, canvas.height);
      ctx.lineTo(k + canvas.height, 0);
    }
    ctx.stroke();
    ctx.restore();
  }
}
const HATCH = 7; // px between the hatching's lines

// Redraws the track; the moment at the right edge of the view stays put (while tracking, the
// next frame puts the playhead there anyway).
function draw() {
  const rightEdge = geo ? tAt(scroller.scrollLeft + scroller.clientWidth) : null;
  const shown = strips.filter((s) => Date.parse(s.start) >= shownFrom);
  track.replaceChildren();
  if (!shown.length) { track.style.width = "100%"; geo = null; return; }
  const pps = pxPerSecond();
  const t1 = endOf(shown.at(-1));
  // At least one full span before the newest audio, so the view can always be filled.
  const t0 = Math.min(Date.parse(shown[0].start), t1 - span * 1e3);
  geo = {t0, pps};
  const width = Math.max(scroller.clientWidth, x(t1) + LIVE_INSET); // room for the line at the newest audio
  track.style.width = width + "px";
  if (specHeight() !== SPEC_H) { SPEC_H = specHeight(); drawFreqLabels(); }
  track.style.height = SPEC_TOP + SPEC_H + AXIS_H + "px";

  for (const s of shown) {
    const el = document.createElement("canvas");
    el.className = "live-strip";
    // Whole pixels at both ends, so neighbouring strips meet without a hairline between them.
    const left = Math.round(x(Date.parse(s.start)));
    el.width = Math.max(1, Math.round(x(endOf(s))) - left);
    el.height = SPEC_H;
    Object.assign(el.style, {left: left + "px", width: el.width + "px", top: SPEC_TOP + "px", height: SPEC_H + "px"});
    paintStrip(el, LIVE + s.image, s);
    track.append(el);
  }
  // No audio at all between strips (the recorder was offline, or reconnecting for over 10 s):
  // hatched like the dropouts inside them.
  for (let i = 1; i < shown.length; i++) {
    const a = Math.round(x(endOf(shown[i - 1]))), b = Math.round(x(Date.parse(shown[i].start)));
    if (b - a < 1) continue;
    const gap = document.createElement("div");
    gap.className = "live-gap";
    Object.assign(gap.style, {left: a + "px", width: b - a + "px", top: SPEC_TOP + "px", height: SPEC_H + "px", backgroundPosition: `${-a}px 0`});
    track.append(gap);
  }
  // Time ticks under the strips, far enough apart that their labels don't touch.
  const label = span < 300 ? 100 : 80; // labels with seconds are wider
  const step = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((sec) => sec * pps >= label) * 1e3;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const tick = document.createElement("div");
    tick.className = "live-tick";
    tick.style.left = x(t) + "px";
    tick.style.top = SPEC_TOP + SPEC_H + "px";
    tick.textContent = time(new Date(t), step < 60e3);
    track.append(tick);
  }
  // Names above the strips, in lanes so they don't overlap; a run that finds no free lane is
  // left out. Every BirdNET detection is shown with its score as a percentage: ones at the
  // dashboard's threshold in bold, weaker ones faint with a question mark, so where BirdNET is torn between
  // species, the candidates show side by side. Confident runs are placed first, then the rest by
  // score, so a crowded stretch keeps its surest names.
  const lanes = Array.from({length: LANES}, () => []);
  const sure = (r) => r.best >= MIN_CONF;
  for (const r of runs(shown, 0).sort((a, b) => sure(b) - sure(a) || b.best - a.best)) {
    const label = `${sure(r) ? "" : "? "}${r.name} (${Math.round(r.best * 100)}%)`;
    const left = x(r.start), labelWidth = label.length * 7.8 + 12;
    const right = Math.max(left + labelWidth, x(r.end));
    const lane = lanes.findIndex((taken) => taken.every(([l, rr]) => right + 6 <= l || left >= rr + 6));
    if (lane < 0) continue;
    lanes[lane].push([left, right]);
    const a = document.createElement("a");
    a.className = sure(r) ? "live-name" : "live-name is-unsure";
    a.href = speciesHref(r.name);
    a.textContent = label;
    a.title = `${r.name}: ${time(new Date(r.start))}, confidence ${Math.round(r.best * 100)}%`;
    Object.assign(a.style, {left: left + "px", top: lane * LANE + "px"});
    a.style.setProperty("--run", Math.max(2, x(r.end) - left) + "px");
    track.append(a);
  }
  Object.assign(playheadLine.style, {top: SPEC_TOP - 6 + "px", height: SPEC_H + 6 + "px"}); // the spectrogram, and a little above
  track.append(playheadLine);
  if (!tracking && rightEdge !== null) scroller.scrollLeft = x(rightEdge) - scroller.clientWidth;
  else if (rightEdge === null) scroller.scrollLeft = scroller.scrollWidth;
}

// Each frame: move the playhead, draw its line and, while tracking, scroll to keep it in place.
function frame() {
  if (geo && strips.length) {
    const newest = endOf(strips.at(-1));
    if (playhead === null) { playhead = newest - FOLLOW_MARGIN; lag = Date.now() - playhead; }
    // The sound's position, once it has loaded and found its place (until then, where it was sent).
    if (soundOn && current && !player.paused && positioned && !player.seeking) playhead = Date.parse(current.start) + player.currentTime * 1e3;
    else if (!(soundOn && waitingFor !== null)) playhead = Math.min(Date.now() - lag, newest);
    lag = Date.now() - playhead; // so muting or a late strip doesn't jump
    playheadLine.style.left = x(playhead) + "px";
    if (tracking) scroller.scrollLeft = x(playhead) - (live ? liveAnchor() : anchor) * scroller.clientWidth;
  }
  showView();
  raf = requestAnimationFrame(frame);
}
let raf = requestAnimationFrame(frame);

function markLive() {
  followButton.classList.toggle("is-live", live);
  fwdButton.disabled = live; // nothing newer to step to
  followButton.textContent = live ? "Live" : "Back to live";
  followButton.setAttribute("aria-pressed", String(live));
  soundButton.setAttribute("aria-pressed", String(soundOn));
  soundButton.title = soundOn ? "Mute (space)" : "Unmute (space)";
  summarize(); // its hour ends at the playhead only while live
}

// Scrolling by hand (wheel, touch, dragging the scrollbar) frees the view; time runs on.
const freeView = () => { tracking = false; };
for (const type of ["wheel", "touchstart", "mousedown"]) scroller.addEventListener(type, freeView, {passive: true});

// Bird boost: the sound runs through two filters on its way out. A high-pass at 1 kHz takes away
// the low rumble (wind, traffic, the house, voices) that covers most songbirds, and a broad lift
// of 6 dB around 4 kHz brings out where they sing. Low-voiced birds (doves, owls, crows) go thin
// with it, so it's a switch, remembered per viewer. Set up on the first play (browsers only allow
// sound after a tap), on the one audio element.
// After it, always, leveling: the recorder keeps its gain fixed so stored audio keeps true
// loudness, which leaves it quiet (background about -60 dBFS, bird calls peaking around -42).
// MAKEUP_DB brings that up to an ordinary volume; a compressor above the background then holds
// loud sounds back (a voice near the mic ends up only a few dB above a bird call, not 20), so
// quiet birds come up without close voices blasting; a limiter at -3 dBFS catches the rest
// (a door, the board being handled), and a soft clipper rounds off the few clicks too sharp for
// it. The compressor's threshold sits above the boosted background, so it doesn't pump the hiss
// up between calls. Raising everything 30 dB raises that hiss too, though, so before the
// compressor a gentle gate (a downward expander) turns sound below GATE_DB down, by up to
// GATE_MAX_DB: the hiss between calls drops about 10 dB while the calls pass unchanged.
const MAKEUP_DB = 30, GATE_DB = -22, GATE_RATIO = 2.5, GATE_MAX_DB = 12;
const GATE = `class Gate extends AudioWorkletProcessor {
  constructor() { super(); this.env = 0; this.g = 1; }
  process(inputs, outputs) {
    const i = inputs[0][0], o = outputs[0][0];
    if (!i) return true;
    // A level follower (fast up, slow down), and the gain smoothed so it never clicks.
    const up = Math.exp(-1 / (0.005 * sampleRate)), down = Math.exp(-1 / (0.2 * sampleRate)), smooth = Math.exp(-1 / (0.01 * sampleRate));
    for (let n = 0; n < i.length; n++) {
      const v = Math.abs(i[n]);
      this.env = v > this.env ? up * this.env + (1 - up) * v : down * this.env + (1 - down) * v;
      const under = Math.max(0, ${GATE_DB} - 20 * Math.log10(this.env + 1e-9));
      this.g = smooth * this.g + (1 - smooth) * 10 ** (-Math.min(${GATE_MAX_DB}, under * (${GATE_RATIO} - 1)) / 20);
      o[n] = i[n] * this.g;
    }
    return true;
  }
}
registerProcessor("gate", Gate);`;
// Less hiss: the mic's hiss is steady and spread over the treble, where birds sing in short
// bursts. Above 2 kHz the sound is split into five bands (each split adds back exactly), and each
// band keeps a slow estimate of its own background. A band near its background is turned down by
// up to HISS_CUT_DB; one HISS_OPEN_DB above it passes untouched, with a linear knee in between.
// Gains open in 3 ms but close over 250 ms, so the hiss sits at a steady level instead of
// warbling, and the sound is delayed 16 ms so a call's first note finds its band already open.
// The node is always in place (switched by message), so turning it on or off never shifts timing.
const HISS_EDGES = [2000, 2800, 4000, 5600, 8000], HISS_CUT_DB = 10, HISS_KNEE_DB = 6, HISS_OPEN_DB = 12;
const HISS = `class Hiss extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = !!e.data; };
    // Second-order Butterworth low-passes, one per edge (the same as scipy's butter(2, f)).
    this.lp = ${JSON.stringify(HISS_EDGES)}.filter((f) => f < 0.45 * sampleRate).map((f) => {
      const w = 2 * Math.PI * f / sampleRate, a = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + a;
      return {b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, z1: 0, z2: 0};
    });
    const n = this.lp.length + 1;
    this.look = Math.max(1, Math.round(0.016 * sampleRate / 128)); // blocks of delay
    this.ring = Array.from({length: this.look + 1}, () => Array.from({length: n}, () => new Float32Array(128)));
    this.head = 0;
    this.bands = Array.from({length: n}, () => new Float32Array(128));
    this.env = new Float64Array(n); this.floor = new Float64Array(n).fill(NaN);
    this.gdb = new Float64Array(n); this.hist = Array.from({length: this.look + 1}, () => new Float64Array(n));
    this.applied = new Float64Array(n).fill(1);
    this.time = 0;
  }
  process(inputs, outputs) {
    const x = inputs[0][0], o = outputs[0][0];
    if (!x || !o) return true;
    const len = x.length, dt = len / sampleRate, k = (ms) => Math.exp(-dt * 1000 / ms);
    const lp = this.lp, nb = lp.length + 1, bands = this.bands;
    let power = 0;
    for (let i = 0; i < len; i++) {
      let rest = x[i];
      power += rest * rest;
      for (let j = 0; j < lp.length; j++) {
        const f = lp[j], low = f.b0 * rest + f.z1;
        f.z1 = f.b1 * rest - f.a1 * low + f.z2;
        f.z2 = f.b2 * rest - f.a2 * low;
        bands[j][i] = low;
        rest -= low;
      }
      bands[nb - 1][i] = rest;
    }
    // Muted, paused or a dropout comes through as exact zeros: hold everything rather than let
    // the silence drag the background estimate down.
    const live = power / len > 1e-14;
    if (live) this.time += dt;
    const hist = this.hist[this.head];
    for (let j = 0; j < nb; j++) {
      if (live && j > 0) { // band 0 (below 2 kHz) is left alone
        let p = 0;
        for (let i = 0; i < len; i++) p += bands[j][i] * bands[j][i];
        p = p / len + 1e-20;
        const c = p > this.env[j] ? k(3) : k(80);
        this.env[j] = this.env[j] ? c * this.env[j] + (1 - c) * p : p;
        const level = 10 * Math.log10(this.env[j]);
        if (Number.isNaN(this.floor[j])) this.floor[j] = level;
        const fast = this.time < 2; // settle quickly at the start
        this.floor[j] += level > this.floor[j] ? (fast ? 20 : 2) * dt : -(fast ? 20 : 6) * dt;
      }
      const over = (10 * Math.log10(this.env[j] || 1e-20)) - this.floor[j];
      const target = this.on && j > 0 && !Number.isNaN(over)
        ? -${HISS_CUT_DB} * Math.min(1, Math.max(0, (${HISS_OPEN_DB} - over) / (${HISS_OPEN_DB - HISS_KNEE_DB}))) : 0;
      const c = target > this.gdb[j] ? k(3) : k(250);
      this.gdb[j] = c * this.gdb[j] + (1 - c) * target;
      hist[j] = this.gdb[j];
    }
    // Write this block into the delay ring and play out the one from \`look\` blocks ago, with each
    // band's gain the most open of the last \`look\` blocks (so it has opened before a call starts),
    // ramped across the block so it never clicks.
    const slot = this.ring[this.head];
    for (let j = 0; j < nb; j++) slot[j].set(bands[j].subarray(0, len));
    this.head = (this.head + 1) % this.ring.length;
    const old = this.ring[this.head];
    o.fill(0);
    for (let j = 0; j < nb; j++) {
      let g = -Infinity;
      for (const h of this.hist) g = Math.max(g, h[j]);
      const to = 10 ** (g / 20), from = this.applied[j], band = old[j];
      for (let i = 0; i < len; i++) o[i] += band[i] * (from + (to - from) * (i + 1) / len);
      this.applied[j] = to;
    }
    return true;
  }
}
registerProcessor("hiss", Hiss);`;
const BOOST_KEY = "birdtracker-live-boost", HISS_KEY = "birdtracker-live-hiss";
let boost = false, hiss = false, audio = null; // audio: {context, source, chain, out, hiss}
try { boost = localStorage.getItem(BOOST_KEY) === "1"; } catch {}
try { hiss = localStorage.getItem(HISS_KEY) === "1"; } catch {}
const boostButton = document.getElementById("live-boost");
const hissButton = document.getElementById("live-hiss");
function route() {
  if (!audio) return;
  const into = boost ? audio.chain : audio.out;
  audio.source.disconnect();
  if (audio.hiss) {
    audio.hiss.disconnect();
    audio.source.connect(audio.hiss).connect(into);
  } else audio.source.connect(into);
}
function setHiss(on) {
  hiss = on;
  try { localStorage.setItem(HISS_KEY, on ? "1" : "0"); } catch {}
  hissButton.setAttribute("aria-pressed", String(on));
  audio?.hiss?.port.postMessage(on);
}
hissButton.setAttribute("aria-pressed", String(hiss));
hissButton.onclick = () => setHiss(!hiss);
function setBoost(on) {
  boost = on;
  try { localStorage.setItem(BOOST_KEY, on ? "1" : "0"); } catch {}
  boostButton.setAttribute("aria-pressed", String(on));
  route();
}
boostButton.setAttribute("aria-pressed", String(boost));
boostButton.onclick = () => setBoost(!boost);
const newPlayer = () => {
  const el = Object.assign(new Audio(), {preload: "auto", onended: () => { if (soundOn) playFrom(endOf(current)); }});
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (Context) {
    const context = new Context();
    const source = context.createMediaElementSource(el);
    const highpass = Object.assign(context.createBiquadFilter(), {type: "highpass"});
    highpass.frequency.value = 1000;
    highpass.Q.value = 0.7;
    const lift = Object.assign(context.createBiquadFilter(), {type: "peaking"});
    lift.frequency.value = 4000;
    lift.Q.value = 0.8;
    lift.gain.value = 6;
    const makeup = context.createGain();
    makeup.gain.value = 10 ** (MAKEUP_DB / 20);
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.3;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.25;
    const clipper = context.createWaveShaper();
    // Unchanged up to 0.7, then bending smoothly toward 0.95 (inputs past full scale stay there).
    clipper.curve = Float32Array.from({length: 1025}, (_, i) => {
      const v = (i - 512) / 512, a = Math.abs(v);
      return a <= 0.7 ? v : Math.sign(v) * (0.7 + 0.25 * Math.tanh((a - 0.7) / 0.25));
    });
    makeup.connect(compressor).connect(limiter).connect(clipper).connect(context.destination);
    // The gate goes in between makeup and compressor, and Less hiss right after the source, once
    // their code has loaded (a moment later).
    context.audioWorklet?.addModule(URL.createObjectURL(new Blob([GATE, "\n", HISS], {type: "text/javascript"}))).then(() => {
      makeup.disconnect();
      makeup.connect(new AudioWorkletNode(context, "gate")).connect(compressor);
      audio.hiss = new AudioWorkletNode(context, "hiss", {channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1]});
      audio.hiss.port.postMessage(hiss);
      route();
    }).catch(() => {}); // without them, the sound just keeps its hiss
    highpass.connect(lift).connect(makeup);
    audio = {context, source, chain: highpass, out: makeup};
    route();
  }
  return el;
};

// Play the minute under `t`, then each next one; if the next hasn't arrived yet, wait for it
// (poll() picks the sound up again).
function playFrom(t) {
  audio?.context.resume(); // a context made before the tap starts suspended
  const strip = strips.find((s) => s.audio && endOf(s) > t + 250);
  if (!strip) { waitingFor = t; showStatus(); return; }
  waitingFor = null;
  current = strip;
  const offset = Math.max(0, (t - Date.parse(strip.start)) / 1e3);
  const load = ++loads;
  positioned = false;
  player.src = LIVE + strip.audio;
  player.addEventListener("loadedmetadata", () => {
    if (load !== loads) return; // replaced by a later playFrom
    player.currentTime = Math.min(offset, player.duration || offset);
    positioned = true;
  }, {once: true});
  player.play().catch((error) => {
    if (error.name === "AbortError") return; // replaced by the next playFrom
    soundOn = false;
    markLive();
    status.textContent = "The browser stopped the sound. Press Unmute to start it again.";
  });
  showStatus();
}

// Move the playhead to `t` (within the audio there is), with the view keeping it `at` of the way
// across; the sound, if on, follows. Leaves live, unless that's where `t` is.
function seek(t, at = anchor) {
  if (!strips.length) return;
  const newest = endOf(strips.at(-1));
  t = Math.max(Date.parse(strips[0].start), Math.min(t, newest));
  if (t < shownFrom) { shownFrom = t - 60e3; draw(); }
  playhead = t;
  lag = Date.now() - t;
  live = false;
  tracking = true;
  anchor = at;
  if (soundOn) playFrom(t); else waitingFor = null;
  markLive();
  showStatus();
}
// Step 10 s, the line staying put; a step forward that would pass the live point goes live.
function step(ms) {
  if (!strips.length) return;
  const t = (playhead ?? endOf(strips.at(-1))) + ms;
  if (ms > 0 && t >= endOf(strips.at(-1)) - FOLLOW_MARGIN) { if (!live) goLive(); return; }
  seek(t, live ? liveAnchor() : anchor);
}

// Mute and unmute; either way the playhead runs on.
function toggleSound() {
  if (!strips.some((s) => s.audio)) return;
  player ??= newPlayer();
  if (soundOn) {
    soundOn = false;
    player.pause();
    waitingFor = null;
  } else {
    soundOn = true;
    playFrom(playhead ?? endOf(strips.at(-1)) - FOLLOW_MARGIN);
  }
  markLive();
  showStatus();
}

// Back to live: just behind the newest audio, the view tracking it (and the sound, if on).
function goLive() {
  if (!strips.length) return;
  live = true;
  tracking = true;
  playhead = endOf(strips.at(-1)) - FOLLOW_MARGIN;
  lag = Date.now() - playhead;
  if (soundOn) playFrom(playhead);
  markLive();
  showStatus();
}

followButton.onclick = () => { if (!live) goLive(); };
soundButton.onclick = toggleSound;
document.getElementById("live-back").onclick = () => step(-STEP);
fwdButton.onclick = () => step(STEP);
// Clicking these shouldn't leave them focused, where space would press them again.
for (const b of [followButton, soundButton, boostButton, hissButton, document.getElementById("live-back"), document.getElementById("live-fwd")]) b.onmousedown = (e) => e.preventDefault();

// Clicking the spectrogram moves the playhead there (the names above it are links to the species).
track.addEventListener("click", (event) => {
  if (!geo || event.target.closest("a")) return;
  const box = scroller.getBoundingClientRect();
  const at = (event.clientX - box.left) / scroller.clientWidth;
  seek(tAt(scroller.scrollLeft + event.clientX - box.left), at);
});

// The last hour as a chart: a row per species, in the order they were first heard (so a new bird
// is added at the bottom), with a cell for each clock minute it was heard in (the site's
// "minutes heard"); neighbouring minutes join into one bar, the latest drawn darker. On the
// right: the minutes in total and when it was last heard. The stretch the spectrogram shows is
// shaded; clicking the chart takes the spectrogram (and the sound, if on) to that moment.
let hourView = null; // {w0, w1}: the chart's time range
// Row order: first heard (the default; new birds join at the bottom), total minutes or last heard,
// either way round. Clicking a column's header sorts by it, again reverses it; First heard resets.
const SORT_KEY = "birdtracker-live-sort";
const SORTS = {first: (r) => r.first, minutes: (r) => r.minutes, last: (r) => r.last};
const FIRST_DIR = {first: 1, minutes: -1, last: -1}; // a column's first click: most minutes, latest first
let sort = {by: "first", dir: 1};
try { const saved = JSON.parse(localStorage.getItem(SORT_KEY)); if (SORTS[saved?.by] && Math.abs(saved.dir) === 1) sort = saved; } catch {}
function sortBy(by) {
  sort = by === "first" ? {by, dir: 1} : {by, dir: sort.by === by ? -sort.dir : FIRST_DIR[by]};
  try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch {}
  summarize();
}
const ganttTip = Object.assign(document.createElement("div"), {className: "live-gantt-tip", hidden: true});

// A sortable column's header: a button showing the order while it's the one in use.
function header(by, label, className = "") {
  const active = sort.by === by;
  const arrow = html`<span class="live-gantt-arrow" aria-hidden="true">${active ? (sort.dir > 0 ? "↑" : "↓") : "↕"}</span>`;
  const b = html`<button type="button" class=${`live-gantt-sort ${className}`} aria-pressed=${String(active)}
    title=${by === "first" ? "Order rows by when each bird was first heard (default)" : `Sort by ${label.toLowerCase()}${active ? ", click again to reverse" : ""}`}>${label}${arrow}</button>`;
  b.onclick = () => sortBy(by);
  return b;
}

function summarize() {
  // The hour ends at the moment shown while live (so the chart never gets ahead of the
  // spectrogram), else at the newest audio.
  const newest = strips.length ? endOf(strips.at(-1)) : Date.now();
  const w1 = live && playhead !== null ? Math.min(playhead, newest) : newest, w0 = w1 - HOUR;
  hourView = {w0, w1};
  const pct = (t) => ((t - w0) / HOUR) * 100 + "%";
  const confident = strips.flatMap((s) => s.detections).filter((d) => d.confidence >= MIN_CONF && Date.parse(d.at) >= w0 && Date.parse(d.at) <= w1);
  const rows = d3.groups(confident, (d) => d.common_name).map(([name, v]) => {
    const byMinute = d3.rollup(v, (w) => ({best: d3.max(w, (d) => d.confidence), first: d3.min(w, (d) => Date.parse(d.at))}),
      (d) => Math.floor(Date.parse(d.at) / 60e3) * 60e3);
    const bars = [];
    for (const m of [...byMinute.keys()].sort((a, b) => a - b)) {
      const bar = bars.at(-1), {best, first} = byMinute.get(m);
      if (bar && bar.end === m) { bar.end = m + 60e3; bar.minutes++; bar.best = Math.max(bar.best, best); }
      else bars.push({start: m, end: m + 60e3, minutes: 1, best, first}); // first: its first detection, where a click goes
    }
    return {name, bars, minutes: byMinute.size, first: d3.min(v, (d) => Date.parse(d.at)), last: d3.max(v, (d) => Date.parse(d.at))};
  }).sort((a, b) => sort.dir * (SORTS[sort.by](a) - SORTS[sort.by](b)) || a.first - b.first);

  if (!rows.length) {
    heard.replaceChildren(html`<p class="sub">No birds named in the last hour.</p>`);
  } else {
    const ticks = d3.timeMinute.every(15).range(new Date(w0), new Date(w1)).map(Number);
    const lanes = rows.map((r, i) => html`<div class="live-gantt-lane" data-name=${r.name} style=${`grid-row: ${i + 2}`}>${r.bars.map((b, j) =>
        html`<span class=${j === r.bars.length - 1 ? "live-gantt-bar is-last" : "live-gantt-bar"} data-first=${b.first} data-tip=${`${r.name}\n${time(new Date(b.start))}–${time(new Date(Math.min(b.end, w1)))} · ${b.minutes} min · best ${Math.round(b.best * 100)}%`}
          style=${{left: pct(Math.max(b.start, w0)), width: `calc(${pct(Math.min(b.end, w1))} - ${pct(Math.max(b.start, w0))})`}}></span>`)}</div>`);
    heard.replaceChildren(html`<div class="live-gantt">
      <p class="eyebrow">Heard in the last hour</p>
      <div class="live-gantt-grid">
        ${header("first", "First heard", "live-gantt-sort-first")}
        <span class="live-gantt-total live-gantt-head">${header("minutes", "Total")}${header("last", "Last")}</span>
        ${rows.flatMap((r, i) => [
          html`<a class="live-gantt-name" href=${speciesHref(r.name)} title=${r.name} style=${`grid-row: ${i + 2}`}>${r.name}</a>`,
          lanes[i],
          html`<span class="sub live-gantt-total" style=${`grid-row: ${i + 2}`}><span>${r.minutes} min</span><span>${time(new Date(r.last))}</span></span>`
        ])}
        <div class="live-gantt-overlay" aria-hidden="true" style=${`grid-row: 2 / span ${rows.length}`}>
          ${ticks.map((t) => html`<span class="live-gantt-grid-line" style=${{left: pct(t)}}></span>`)}
          <span class="live-gantt-view" id="live-gantt-view" hidden></span>
        </div>
        <div class="live-gantt-axis" aria-hidden="true" style=${`grid-row: ${rows.length + 2}`}>${ticks.map((t) => html`<span class=${new Date(t).getMinutes() % 30 ? "is-minor" : ""} style=${{left: pct(t)}}>${time(new Date(t))}</span>`)}</div>
      </div>
      ${ganttTip}
    </div>`);
    const grid = heard.querySelector(".live-gantt-grid");
    grid.onclick = (event) => {
      const lane = event.target.closest(".live-gantt-lane");
      if (!lane) return;
      const bar = event.target.closest(".live-gantt-bar");
      const box = lane.getBoundingClientRect();
      jumpTo(bar ? runStart(lane.dataset.name, Number(bar.dataset.first)) : w0 + ((event.clientX - box.left) / box.width) * HOUR);
    };
    grid.onpointermove = (event) => {
      const bar = event.target.closest(".live-gantt-bar");
      ganttTip.hidden = !bar;
      if (!bar) return;
      ganttTip.textContent = bar.dataset.tip;
      const host = heard.querySelector(".live-gantt").getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      ganttTip.style.left = Math.min(event.clientX - host.left, host.width - 200) + "px";
      ganttTip.style.top = b.bottom - host.top + 6 + "px";
    };
    grid.onpointerleave = () => { ganttTip.hidden = true; };
    showView();
  }
  earlier.hidden = !strips.length || Date.parse(strips[0].start) >= shownFrom;
}

// Shade, on the hour chart, the stretch the spectrogram shows now (called every frame).
function showView() {
  const view = document.getElementById("live-gantt-view");
  if (!view || !geo || !hourView) return;
  const {w0, w1} = hourView;
  const a = Math.max(w0, tAt(scroller.scrollLeft)), b = Math.min(w1, tAt(scroller.scrollLeft + scroller.clientWidth));
  view.hidden = b <= a;
  if (b <= a) return;
  view.style.left = ((a - w0) / (w1 - w0)) * 100 + "%";
  view.style.width = `max(2px, ${((b - a) / (w1 - w0)) * 100}%)`;
}

// Where the stretch of song holding the detection at `t` begins: weaker detections of the same
// species just before it count too, as they do for the names over the spectrogram.
function runStart(name, t) {
  const times = strips.flatMap((s) => s.detections).filter((d) => d.common_name === name).map((d) => Date.parse(d.at)).sort((a, b) => b - a);
  for (const at of times) if (at < t && t - at <= RUN_GAP + 3e3) t = at;
  return t;
}

// From the hour chart: the playhead to `t`, at its usual place in the view.
function jumpTo(t) {
  seek(t, PLAYHEAD_AT);
  document.querySelector(".live-head").scrollIntoView({block: "nearest", behavior: "smooth"});
}

function showStatus() {
  if (!strips.length) { status.textContent = "Nothing from the recorder yet. Strips appear here about a minute after it starts recording."; return; }
  const last = strips.at(-1);
  const end = new Date(Date.parse(last.start) + last.seconds * 1e3);
  const quiet = (Date.now() - end) / 60e3 > STALE_MINUTES;
  status.textContent = quiet && live && !soundOn
    ? `No audio from the recorder since ${time(end)}.`
    : soundOn && waitingFor !== null
    ? "Waiting for the next minute of audio…"
    : playhead !== null
    ? `${soundOn ? "Listening to" : "Showing"} ${time(new Date(playhead), true)}`
    : `Latest audio ${time(end)}`;
  status.classList.toggle("is-quiet", quiet);
}

async function poll() {
  try {
    const r = await fetch(LIVE + "live.json", {cache: "no-store"});
    if (r.status === 404) { strips = []; }
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);
    else {
      const j = await r.json();
      if (j.updated === updated) return;
      updated = j.updated;
      strips = j.strips ?? [];
    }
    if (shownFrom === null && strips.length) shownFrom = Date.parse(strips.at(-1).start) - HOUR;
    transport.hidden = !strips.length;
    audioControls.hidden = !strips.some((s) => s.audio);
    draw();
    markLive();
    if (soundOn && waitingFor !== null) playFrom(waitingFor);
    summarize();
    showStatus();
  } catch (e) {
    status.textContent = `Couldn't reach the recorder's data (${e.message}). Trying again shortly.`;
  }
}

// Fullscreen (button or F): the page without the site's header and footer.
const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
const markFull = () => {
  const on = Boolean(document.fullscreenElement);
  draw(); // the spectrogram's height follows
  fullButton.setAttribute("aria-pressed", String(on));
  fullButton.title = on ? "Exit fullscreen (F)" : "Fullscreen (F)";
  fullButton.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
};
fullButton.hidden = !document.documentElement.requestFullscreen;
fullButton.onclick = toggleFull;
// Keys: space (or M) mutes and unmutes, arrows step 10 s, L goes back to live, B and H switch Bird boost and Less hiss, F toggles fullscreen.
const keys = (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select")) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((k === " " && !e.target.closest?.("a")) || k === "m") toggleSound(); // space even with a button focused
  else if (k === "ArrowLeft") step(-STEP);
  else if (k === "ArrowRight") step(STEP);
  else if (k === "l") goLive();
  else if (k === "b") setBoost(!boost);
  else if (k === "h") setHiss(!hiss);
  else if (k === "f") toggleFull();
  else return;
  e.preventDefault();
};
document.addEventListener("keydown", keys);
document.addEventListener("fullscreenchange", markFull);

earlier.onclick = () => {
  tracking = false;
  const keep = scroller.scrollWidth - scroller.scrollLeft;
  shownFrom -= HOUR;
  draw();
  scroller.scrollLeft = scroller.scrollWidth - keep; // stay on the same audio
  summarize();
};

poll();
const timer = setInterval(poll, POLL_SECONDS * 1e3);
const clock = setInterval(showStatus, 1000); // the time shown
const hourTimer = setInterval(summarize, 5e3); // slide the hour chart along with the playhead
const resize = new ResizeObserver(() => draw());
resize.observe(scroller);
invalidation.then(() => { document.removeEventListener("keydown", keys); document.removeEventListener("fullscreenchange", markFull); clearInterval(timer); clearInterval(clock); clearInterval(hourTimer); resize.disconnect(); cancelAnimationFrame(raf); player?.pause(); });
```
