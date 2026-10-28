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
import {detectionStarts, speciesActivity, detectingAt} from "./components/live-activity.js";
import {UNIDENTIFIED, unidentifiedDetections, unidentifiedRuns} from "./components/live-unidentified.js";
import {liveLabelLeft} from "./components/live-label-position.js";
import {includedDetection, detectionPlaybackStart, shownInGantt} from "./components/detection-policy.js";
import {speciesHref, speciesCards, loadPhotos, loadCategories, postReview, thresholdText} from "./components/birds.js";
```

```js
const POLL_SECONDS = 30, MIN_CONF = 0.6, HOUR = 3600e3;
// How much fits across the screen; the viewer's choice is remembered.
const SPANS = [[60, "1 min"], [300, "5 min"], [900, "15 min"], [3600, "1 hour"]];
const SPAN_KEY = "birdtracker-live-span";
const LIVE = "/api/live/";
const STALE_MINUTES = 10; // no new strip for this long: say the recorder is quiet
const RUN_GAP = 6e3; // detections of one species this close together are one run
const FOLLOW_MARGIN = 75e3; // how far the playhead starts behind the newest audio: about one strip's wait
const time = (d, seconds = false) => d.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", ...(seconds && {second: "2-digit"})});
```

<div class="live-head">
  <p class="sub live-status" id="live-status">Loading…</p>
  <button type="button" class="live-button live-full" id="live-full" title="Fullscreen (F)" aria-label="Fullscreen" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></button>
</div>

<div class="live-overview-row" id="live-overview-row" hidden>
  <button type="button" class="live-button live-icon" id="live-days-back" title="Earlier days (shift ←)" aria-label="Earlier days"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
  <div class="live-overview" id="live-overview"><div class="live-overview-dates" id="live-overview-dates"></div><div class="live-overview-bars" id="live-overview-bars"></div><div class="live-overview-days" id="live-overview-days"></div><div class="live-overview-view" id="live-overview-view"></div><div class="live-overview-head" id="live-overview-head"></div></div>
  <button type="button" class="live-button live-icon" id="live-days-fwd" title="Later days (shift →)" aria-label="Later days"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
</div>

<div class="live-controls">
    <div class="live-transport" id="live-transport" hidden>
      <button type="button" class="live-button live-icon" id="live-back" title="Back 10 seconds (←)" aria-label="Back 10 seconds"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/></svg></button>
      <button type="button" class="live-button live-icon live-pause" id="live-pause" title="Pause (K)" aria-label="Pause" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="icon-pause" d="M9 6v12M15 6v12"/><path class="icon-play" d="M8 5.5v13l10-6.5z"/></svg></button>
      <button type="button" class="live-button live-follow" id="live-follow" title="Back to live (L)">Back to live</button>
      <button type="button" class="live-button live-icon" id="live-fwd" title="Forward 10 seconds (→)" aria-label="Forward 10 seconds"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7l5 5-5 5M13 7l5 5-5 5"/></svg></button>
    </div>
    <div class="live-transport" id="live-audio" hidden>
      <button type="button" class="live-button live-icon live-sound" id="live-sound" title="Unmute (space)" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="speaker" d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="icon-off" d="M16 9.5l5 5M21 9.5l-5 5"/><path class="icon-on" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg><span class="live-sound-label"><span class="when-off">Unmute</span><span class="when-on">Mute</span></span></button>
      <button type="button" class="live-button live-boost" id="live-boost" title="Bird boost: cleaner sound, brighter birdsong, calls up front (B)" aria-pressed="false">Bird boost</button>
    </div>
    <div class="period-segments live-span" id="live-span" role="group" aria-label="Time shown across the screen"></div>
  </div>
<div class="live-frame">
  <div class="live-freq" id="live-freq" aria-hidden="true"></div>
  <div class="live-scroller" id="live-scroller" tabindex="0" aria-label="Spectrogram of the recorder's recent audio, newest at the right">
    <div class="live-track" id="live-track"></div>
  </div>
</div>

<div class="live-gantt-heading">
  <p class="eyebrow" id="live-heard-heading">Heard in the last hour</p>
  <label class="live-gantt-filter"><input type="checkbox" id="live-confident-only"> Confident detections only</label>
</div>
<div id="live-heard"></div>

```js
const scroller = document.getElementById("live-scroller");
const track = document.getElementById("live-track");
const status = document.getElementById("live-status");
const heard = document.getElementById("live-heard");
const heardHeading = document.getElementById("live-heard-heading");
const confidentOnly = document.getElementById("live-confident-only");
confidentOnly.onchange = () => summarize();
const followButton = document.getElementById("live-follow");
const transport = document.getElementById("live-transport");
const audioControls = document.getElementById("live-audio");
const fwdButton = document.getElementById("live-fwd");
const soundButton = document.getElementById("live-sound");
const fullButton = document.getElementById("live-full");

let strips = []; // from live.json (the last 24 h) plus any older days loaded, oldest first
let older = []; // strips from earlier days' files (live/days/), kept across polls
let stripObserver = null;
// Opened from a detection elsewhere (live?t=2026-10-26T14:35:39Z): go there once the audio list
// is in, loading that day's strips if it's older than the last 24 hours.
let pendingJump = Date.parse(new URLSearchParams(location.search).get("t") ?? "") || null;
// Listeners' verdicts on detections: the Pi's (live/reviews.json, refreshed with each poll) and
// this page's own, shown at once while the Pi catches up. A rejected detection counts nowhere.
let serverReviews = {};
const localReviews = new Map();
const reviewKey = (d) => `${d.at}|${d.scientific_name}`;
const reviewOf = (d) => (localReviews.has(reviewKey(d)) ? localReviews.get(reviewKey(d)) : serverReviews[reviewKey(d)] ?? null);
const counts = (d) => reviewOf(d) !== "rejected";
// Per-species thresholds learned from those verdicts (live/thresholds.json, refreshed with each
// poll): a species without one uses the file's default, or MIN_CONF without the file.
let thresholdsFile = null;
const minConf = () => thresholdsFile?.default ?? MIN_CONF;
const accepted = (d) => includedDetection({confidence: d.confidence, review: reviewOf(d), scientific_name: d.scientific_name}, minConf(), thresholdsFile?.species);
const mergeStrips = (a, b) => [...new Map([...a, ...b].map((s) => [s.start, s])).values()].sort((p, q) => p.start.localeCompare(q.start));
let updated = null;
let geo = null; // {t0, t1, pps}: the drawn track's time at x = 0, its last audio, and its scale
let drawnWindow = null; // the overview window [w0, w1] the track was last drawn for
const x = (t) => ((t - geo.t0) / 1e3) * geo.pps;
const tAt = (px) => geo.t0 + (px / geo.pps) * 1e3;
const endOf = (s) => Date.parse(s.start) + s.seconds * 1e3;
// A time, with its date when that isn't today (Pacific).
const dayTime = (d) => (d.toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"}) === new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"})
  ? time(d) : `${d.toLocaleDateString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric"})}, ${time(d)}`);
// Where the recorder's audio stopped, when nothing has come for STALE_MINUTES; else null.
const offlineSince = () => (strips.length && Date.now() - endOf(strips.at(-1)) > STALE_MINUTES * 6e4 ? endOf(strips.at(-1)) : null);

// The playhead: the moment shown or heard, marked by a line. Time always runs: with the sound on
// it's the sound's own position, otherwise the wall clock minus `lag` (held at the newest audio
// if the next strip is late). Live means it's just behind the newest audio.
let live = true, lag = null, playhead = null;
let paused = false; // time stops: the playhead holds still (and the sound, if on, pauses)
// Tracking: the view scrolls to keep the playhead `anchor` of the way across it (where it was
// clicked, or PLAYHEAD_AT); scrolling by hand stops that until the next seek, step or Live.
// While live the playhead keeps to the right edge (LIVE_INSET px in), with nothing newer shown.
const PLAYHEAD_AT = 2 / 3, LIVE_INSET = 8, STEP = 10e3;
const liveAnchor = () => 1 - LIVE_INSET / scroller.clientWidth;
// Live, the view ends at the newest audio, with the stretch the playhead hasn't reached dimmed;
// in a short span the playhead is kept at least this far in from the left instead.
const LIVE_PLAYHEAD_MIN = 0.2;
let tracking = true, anchor = PLAYHEAD_AT;
// Sound (muted to start): one audio element for the whole session, so browsers that only allow
// sound after a tap (Safari) keep allowing it from one minute to the next.
let soundOn = false, player = null, current = null, waitingFor = null;
let loads = 0, positioned = false; // the sound has loaded and been moved to its starting point
let activityLabels = [], activityRows = [], activityIndex = new Map();
let activityTick = null;
const playheadLine = Object.assign(document.createElement("div"), {className: "live-playhead"});
const aheadShade = Object.assign(document.createElement("div"), {className: "live-ahead"}); // live: newer audio than the playhead

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
  drawOverview(); // a new span has a new overview window, and the track follows it
  draw();
}

// Detections at least `minConf` sure, joined into runs: one per species per stretch of song.
// Each run keeps its detections (`dets`, for reviewing it) and its verdict: "rejected" when all
// of them are, "confirmed" when any is.
function runs(list, minConf = MIN_CONF) {
  const out = [];
  const open = new Map();
  for (const d of list.flatMap((s) => s.detections).filter((d) => d.confidence >= minConf || reviewOf(d) === "confirmed").sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(d.at);
    const run = open.get(d.common_name);
    if (run && t - run.end <= RUN_GAP) { run.end = t + 3e3; run.best = Math.max(run.best, d.confidence); run.dets.push(d); continue; }
    const r = {name: d.common_name, start: t, end: t + 3e3, best: d.confidence, dets: [d]};
    open.set(d.common_name, r);
    out.push(r);
  }
  for (const r of out) {
    const v = r.dets.map(reviewOf);
    r.review = v.every((x) => x === "rejected") ? "rejected" : v.includes("confirmed") ? "confirmed" : null;
  }
  return out;
}

// Non-bird sounds (strip.sounds, when the analyzer sends them) grouped like bird runs.
function soundRuns(list) {
  const out = [], open = new Map();
  for (const d of list.flatMap((s) => s.sounds ?? []).sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(d.at), run = open.get(d.sound);
    if (run && t - run.end <= RUN_GAP) { run.end = t + 3e3; run.best = Math.max(run.best, d.confidence); continue; }
    const r = {name: d.sound, start: t, end: t + 3e3, best: d.confidence};
    open.set(d.sound, r);
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
    const pattern = ctx.createPattern(hatchTile, "repeat");
    pattern.setTransform(new DOMMatrix().translate(-left, 0));
    ctx.fillStyle = pattern;
    ctx.fillRect(x0, 0, x1 - x0, canvas.height);
  }
}
// One hatching tile for the dropouts inside strips and the gaps between them, so they look
// the same in every browser (a CSS gradient's thin lines rasterize differently from canvas).
const HATCH = 7; // px between the hatching's lines
const hatchTile = (() => {
  const c = Object.assign(document.createElement("canvas"), {width: HATCH, height: HATCH});
  const g = c.getContext("2d");
  g.fillStyle = "#14110d";
  g.fillRect(0, 0, HATCH, HATCH);
  g.strokeStyle = "rgba(232, 224, 207, 0.28)";
  g.lineWidth = 1;
  g.beginPath();
  for (const o of [-HATCH, 0, HATCH]) { g.moveTo(o, HATCH); g.lineTo(o + HATCH, 0); }
  g.stroke();
  return c;
})();
const hatchImage = `url(${hatchTile.toDataURL()})`;

// Redraws the track; the moment at the right edge of the view stays put (while tracking, the
// next frame puts the playhead there anyway).
function draw() {
  const rightEdge = geo ? tAt(scroller.scrollLeft + scroller.clientWidth) : null;
  // The strips in the overview's window, so the scroll range is always what the overview shows.
  const w = ov ?? ovWindow();
  const shown = strips.filter((s) => endOf(s) > w.w0 && Date.parse(s.start) < w.w1);
  drawnWindow = [w.w0, w.w1];
  track.replaceChildren();
  activityLabels = [];
  activityIndex = speciesActivity(strips, reviewOf);
  activityTick = null;
  if (!strips.length) { track.style.width = "100%"; geo = null; return; }
  const pps = pxPerSecond();
  // The whole window scrolls, loaded or not: older days load as the view nears them (loadNearView).
  // Offline, it runs on to now, so the stretch without audio shows.
  const offline = offlineSince();
  const t1 = Math.min(w.w1, offline ? Date.now() : endOf(strips.at(-1)));
  // At least one full span before the newest audio, so the view can always be filled.
  const t0 = Math.min(w.w0, t1 - span * 1e3);
  geo = {t0, t1, pps};
  const width = Math.max(scroller.clientWidth, x(t1) + LIVE_INSET); // room for the line at the newest audio
  track.style.width = width + "px";
  if (specHeight() !== SPEC_H) { SPEC_H = specHeight(); drawFreqLabels(); }
  track.style.height = SPEC_TOP + SPEC_H + AXIS_H + "px";

  // Strips are painted only as they come near the view, so days of them stay light.
  stripObserver?.disconnect();
  stripObserver = new IntersectionObserver((entries) => {
    for (const {target: el, isIntersecting} of entries) {
      if (!isIntersecting) continue;
      stripObserver.unobserve(el);
      el.width = el.dataset.w; el.height = SPEC_H;
      paintStrip(el, LIVE + el.strip.image, el.strip);
    }
  }, {root: scroller, rootMargin: "0px 1500px"});
  for (const s of shown) {
    const el = document.createElement("canvas");
    el.className = "live-strip";
    // Whole pixels at both ends, so neighbouring strips meet without a hairline between them.
    const left = Math.round(x(Date.parse(s.start)));
    const w = Math.max(1, Math.round(x(endOf(s))) - left);
    el.width = 1; el.height = 1; el.dataset.w = w; el.strip = s;
    Object.assign(el.style, {left: left + "px", width: w + "px", top: SPEC_TOP + "px", height: SPEC_H + "px"});
    track.append(el);
    stripObserver.observe(el);
  }
  // No audio at all between strips (the recorder was offline, or reconnecting for over 10 s):
  // hatched like the dropouts inside them.
  // A gap reaching into a day not loaded yet isn't known to be silent, so it stays blank.
  for (let i = 1; i < shown.length; i++) {
    if (!loadedBetween(endOf(shown[i - 1]), Date.parse(shown[i].start))) continue;
    const a = Math.round(x(endOf(shown[i - 1]))), b = Math.round(x(Date.parse(shown[i].start)));
    if (b - a < 1) continue;
    const gap = document.createElement("div");
    gap.className = "live-gap";
    Object.assign(gap.style, {left: a + "px", width: b - a + "px", top: SPEC_TOP + "px", height: SPEC_H + "px", backgroundImage: hatchImage, backgroundPosition: `${-a}px 0`});
    track.append(gap);
  }
  // Since the audio stopped: hatched the same way, with when it stopped.
  if (offline && t1 > offline) {
    const a = Math.round(x(Math.max(offline, t0))), b = Math.round(x(t1));
    const gap = document.createElement("div");
    gap.className = "live-gap is-offline";
    Object.assign(gap.style, {left: a + "px", width: b - a + "px", top: SPEC_TOP + "px", height: SPEC_H + "px", backgroundImage: hatchImage, backgroundPosition: `${-a}px 0`});
    gap.append(Object.assign(document.createElement("span"), {className: "live-offline-label", textContent: `No audio since ${dayTime(new Date(offline))}`}));
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
  // species, the candidates show side by side. Confident runs are placed first, then non-bird
  // sounds, then the rest by score, so a crowded stretch keeps its surest names.
  // Text lanes are assigned using visible, edge-clamped positions below.
  // Unidentified runs have no detections (`dets`), so no species threshold: never sure.
  const sure = (r) => includedDetection({confidence: r.best, review: r.review, scientific_name: r.dets?.[0]?.scientific_name}, minConf(), thresholdsFile?.species);
  const birdRuns = runs(shown, 0).sort((a, b) => b.best - a.best);
  const placeBird = (r) => {
    const label = r.unidentified ? UNIDENTIFIED : `${sure(r) ? "" : "? "}${r.name} (${Math.round(r.best * 100)}%)`;
    const left = x(r.start);
    const lane = 0;
    // A click jumps to the run's first detection; hovering opens the species card (details).
    const a = document.createElement("button");
    a.type = "button";
    a.className = `live-name${sure(r) ? "" : " is-unsure"}${r.review ? ` is-${r.review}` : ""}`;
    if (!r.unidentified) {
      a.dataset.species = r.name;
      activityLabels.push({node: a, starts: detectionStarts(r.dets, reviewOf)});
    }
    a.run = r;
    const text = document.createElement("span");
    text.className = "live-name-text";
    text.textContent = r.review === "confirmed" ? `${label} ✓` : r.review === "rejected" ? `${label} ✗` : label;
    a.append(text);
    a.setAttribute("aria-label", r.unidentified ? `${UNIDENTIFIED}, ${time(new Date(r.start))}: play from here` : `${r.name}, ${time(new Date(r.start))}, confidence ${Math.round(r.best * 100)}%: play from here`);
    a.onmousedown = (e) => e.preventDefault(); // stay unfocused, so space still mutes
    a.onclick = (event) => {
      event.stopPropagation(); // don't let the track seek again at the label's click position
      seek(detectionPlaybackStart(r.start), PLAYHEAD_AT);
    };
    Object.assign(a.style, {left: left + "px", top: lane * LANE + "px"});
    a.style.setProperty("--run", Math.max(2, x(r.end) - left) + "px");
    a.labelGeometry = {start: left, end: x(r.end)};
    track.append(a);
  };
  birdRuns.filter(sure).forEach(placeBird);
  // Non-bird sounds BirdNET heard (dog, voices, engines...), placed after the confident birds
  // and before the unsure ones: muted, with a sound icon, so they never read as birds. A click
  // jumps there too.
  for (const r of soundRuns(shown).sort((a, b) => b.best - a.best)) {
    const label = `${r.name} (${Math.round(r.best * 100)}%)`;
    const left = x(r.start);
    const lane = 0;
    const a = document.createElement("button");
    a.type = "button";
    a.className = "live-name is-sound";
    a.innerHTML = `<span class="live-name-text"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg></span>`;
    a.querySelector(".live-name-text").append(label);
    a.setAttribute("aria-label", `${r.name} (not a bird), ${time(new Date(r.start))}, confidence ${Math.round(r.best * 100)}%: play from here`);
    a.onmousedown = (e) => e.preventDefault();
    a.onclick = (event) => {
      event.stopPropagation(); // don't let the track seek again at the label's click position
      seek(detectionPlaybackStart(r.start), PLAYHEAD_AT);
    };
    Object.assign(a.style, {left: left + "px", top: lane * LANE + "px"});
    a.style.setProperty("--run", Math.max(2, x(r.end) - left) + "px");
    a.labelGeometry = {start: left, end: x(r.end)};
    track.append(a);
  }
  birdRuns.filter((r) => !sure(r)).forEach(placeBird);
  unidentifiedRuns(shown).forEach(placeBird);
  Object.assign(playheadLine.style, {top: SPEC_TOP - 6 + "px", height: SPEC_H + 6 + "px"}); // the spectrogram, and a little above
  Object.assign(aheadShade.style, {top: SPEC_TOP + "px", height: SPEC_H + "px"});
  track.append(aheadShade, playheadLine);
  if (!tracking && rightEdge !== null) scroller.scrollLeft = x(rightEdge) - scroller.clientWidth;
  else if (rightEdge === null) scroller.scrollLeft = scroller.scrollWidth;
  positionNames();
  drawOverview();
}

// An overview above the spectrogram whose range follows the span: 1 min shows an hour in minute
// bars, 5 min six hours in 5-minute bars, 15 min a day in 15-minute bars, 1 hour three days
// (Pacific midnights) in half hours. Bars are taller the more of their time had a bird at the
// dashboard's threshold, short for audio with none, a stub where there's no audio. The window
// follows the playhead until ‹ › (or shift ← →) move it, a window (or, for three days, a day) at
// a time, back through the KEEP_DAYS kept; going live lets it follow again. Times in the strips
// loaded come from them; three-day views fill older hours from live/days.json's hourly counts.
// The spectrogram's view is outlined and the playhead marked; click to jump there.
const overview = document.getElementById("live-overview");
const overviewRow = document.getElementById("live-overview-row");
const KEEP_DAYS = 7;
const OV_FOR = {60: [HOUR, 60e3], 300: [6 * HOUR, 5 * 60e3], 900: [24 * HOUR, 15 * 60e3], 3600: [72 * HOUR, 30 * 60e3]};
let ov = null, daysIndex = null, ovEnd = null; // ovEnd: where ‹ › left the window; null: following
const pacificDate = (t) => new Date(t).toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
const pacificHour = (t) => +new Date(t).toLocaleString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23"});
const midnight = (date) => { const t = Date.parse(date + "T08:00:00Z"); return t - pacificHour(t) * HOUR; };
const dayShift = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const loadedDays = new Set(); // UTC dates of live/days/ files fetched
// Whether every day file between a and b has been fetched (live.json holds the last 24 hours).
const loadedBetween = (a, b) => d3.utcDay.range(d3.utcDay.floor(new Date(a)), new Date(Math.min(b, Date.now() - 23 * HOUR)))
  .every((d) => loadedDays.has(d.toISOString().slice(0, 10)));
async function loadDay(date) { // the UTC-dated files covering a Pacific day
  const [w0, w1] = [midnight(date), midnight(dayShift(date, 1))];
  const files = [...new Set([new Date(w0).toISOString().slice(0, 10), new Date(w1 - 1).toISOString().slice(0, 10)])].filter((f) => !loadedDays.has(f));
  for (const f of files) {
    loadedDays.add(f);
    try {
      const r = await fetch(`${LIVE}days/${f}.json`, {cache: "no-store"});
      if (r.ok) older = mergeStrips(older, (await r.json()).strips ?? []);
    } catch {}
  }
  if (files.length) { strips = mergeStrips(older, strips); draw(); summarize(); }
}
const loadIndex = () => fetch(LIVE + "days.json", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).then((j) => { daysIndex = j; drawOverview(); }).catch(() => {});
loadIndex();
setInterval(loadIndex, 10 * 60e3);
// The window for the span: following the playhead (a quarter of the window ahead of it, up to
// now), or where ‹ › put it.
function ovWindow() {
  const [len, bin] = OV_FOR[span] ?? OV_FOR[3600], days = len >= 72 * HOUR;
  // Live and offline, it follows now, so it shows how long the audio has been missing.
  const now = Date.now(), p = live && tracking && offlineSince() ? now : Math.min(playhead ?? now, now);
  const w1 = ovEnd ?? (days ? midnight(dayShift(pacificDate(p), 1)) : Math.min(Math.ceil(now / bin) * bin, Math.ceil((p + len / 4) / bin) * bin));
  return {w0: w1 - len, w1, len, bin, days};
}
function drawOverview() {
  overviewRow.hidden = !strips.length && !daysIndex?.length;
  if (overviewRow.hidden) return;
  ov = ovWindow();
  const {w0, w1, bin, days} = ov, now = Date.now();
  if (drawnWindow && (drawnWindow[0] !== w0 || drawnWindow[1] !== w1)) draw();
  const oldest = Math.min(daysIndex?.[0]?.start ? Date.parse(daysIndex[0].start) : Infinity, Date.parse(strips[0]?.start ?? now));
  document.getElementById("live-days-back").disabled = w0 <= oldest || w0 <= now - KEEP_DAYS * 864e5;
  document.getElementById("live-days-fwd").disabled = ovEnd === null;
  if (!days && strips.length && w0 < Date.parse(strips[0].start) && w1 > oldest) for (const t of [w0, w1 - 1]) loadDay(pacificDate(t));
  // Seconds of audio and of birds per bar, from the strips loaded: birds as distinct minutes
  // with a detection for bars of 15 minutes or more, else as 3-second detections...
  const audio = new Map(), birds = new Map(), byMinute = bin >= 15 * 60e3;
  for (const st of strips) {
    const t0 = Date.parse(st.start);
    if (endOf(st) < w0 || t0 >= w1) continue;
    const k = Math.floor(t0 / bin) * bin;
    audio.set(k, (audio.get(k) ?? 0) + st.seconds - d3.sum(st.gaps ?? [], ([a, b]) => b - a));
    for (const d of st.detections) if (accepted(d)) {
      const t = Date.parse(d.at), kd = Math.floor(t / bin) * bin;
      if (!birds.has(kd)) birds.set(kd, new Set());
      birds.get(kd).add(byMinute ? Math.floor(t / 6e4) : t);
    }
  }
  const birdSeconds = (k) => (birds.get(k)?.size ?? 0) * (byMinute ? 60 : 3);
  // ...and, for three-day views, older hours from the day index (split between half hours).
  const indexed = new Map();
  if (days) for (const d of daysIndex ?? []) (d.audio ?? []).forEach((m, i) => {
    const t = Date.parse(d.date + "T00:00:00Z") + i * HOUR;
    for (const half of [t, t + bin]) indexed.set(half, [m * 30, (d.birds?.[i] ?? 0) * 30]);
  });
  // Bars after the newest audio are left blank while its next strip may still come.
  const pending = strips.length && !offlineSince() ? endOf(strips.at(-1)) : Infinity;
  document.getElementById("live-overview-bars").replaceChildren(...d3.range(w0, w1, bin).map((t) => {
    const el = document.createElement("span");
    if (t > now || t >= pending) { el.className = "is-future"; return el; }
    const [a, b] = audio.has(t) ? [audio.get(t), birdSeconds(t)] : indexed.get(t) ?? [0, 0];
    el.className = a < (bin / 1e3) * 0.05 ? "is-empty" : b ? "has-birds" : "is-quiet";
    if (b) el.style.height = 30 + 70 * Math.min(1, (2 * b * 1e3) / bin) + "%";
    if (days && pacificHour(t) === 0 && t % HOUR === 0) el.classList.add("is-midnight");
    const what = el.className === "is-empty" ? "no audio" : byMinute ? `${Math.round(b / 60)} min with birds, ${Math.round(a / 60)} min of audio` : `${Math.round(b / 3)} detections, ${Math.round(a / 60)} min of audio`;
    el.title = `${new Date(t).toLocaleString("en-US", {timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit"})}–${time(new Date(t + bin))}: ${what}`;
    return el;
  }));
  // Labels: the days for three-day views, else times every 15 min, 1 hour or 3 hours.
  const pos = (t) => (100 * (t - w0)) / (w1 - w0), today = pacificDate(now);
  const dayDate = (t) => new Date(t).toLocaleDateString("en-US", {timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric"});
  let labels;
  if (days) {
    labels = d3.range(3).map((i) => {
      const date = dayShift(pacificDate(w0 + 12 * HOUR), i), a = midnight(date), b = midnight(dayShift(date, 1));
      const text = date === today ? "Today" : dayDate(a + 12 * HOUR);
      return Object.assign(document.createElement("span"), {textContent: text, style: `left: ${pos(a)}%; width: ${pos(b) - pos(a)}%`});
    });
  } else {
    const every = ov.len <= HOUR ? 15 * 60e3 : ov.len <= 6 * HOUR ? HOUR : 3 * HOUR;
    const step = Math.min(every, HOUR); // whole hours are stepped hourly, then picked in Pacific time
    labels = d3.range(Math.ceil(w0 / step) * step, w1, step).filter((t) => every < HOUR || (t % HOUR === 0 && pacificHour(t) % (every / HOUR) === 0))
      .filter((t) => pos(t) > 3 && pos(t) < 97)
      .map((t) => Object.assign(document.createElement("span"), {className: "is-tick", textContent: time(new Date(t)).replace(":00 ", " "), style: `left: ${pos(t)}%`}));
  }
  document.getElementById("live-overview-days").replaceChildren(...labels);
  // Shorter views: the date above the bars, held at the left, and again at each midnight
  // inside; a midnight too close to the left drops the left one.
  const dates = [];
  if (!days) {
    const mids = d3.range(Math.ceil(w0 / HOUR) * HOUR, w1, HOUR).filter((t) => pacificHour(t) === 0);
    const room = (pos(mids[0] ?? w1) / 100) * overview.clientWidth; // px before the first midnight
    if (!mids.length || room > 95) dates.push(Object.assign(document.createElement("span"), {textContent: dayDate(w0), style: "left: 0"}));
    for (const m of mids) dates.push(Object.assign(document.createElement("span"), {className: "is-midnight", textContent: dayDate(m), style: `left: ${pos(m)}%`}));
  }
  document.getElementById("live-overview-dates").replaceChildren(...dates);
}
// Each frame: the outline and playhead marker follow the spectrogram.
function showOverviewView() {
  if (!geo || !ov) return;
  if (ovEnd === null && ovWindow().w1 !== ov.w1) drawOverview(); // following: slide along
  else if (ovEnd !== null && tracking && playhead !== null && (playhead >= ov.w1 || playhead < ov.w0)) { ovEnd = null; drawOverview(); } // played out of a stepped window
  const {w0, w1} = ov, pct = (t) => (100 * (t - w0)) / (w1 - w0);
  const clamp = (v) => Math.max(0, Math.min(100, v));
  const view = document.getElementById("live-overview-view"), head = document.getElementById("live-overview-head");
  const a = pct(tAt(scroller.scrollLeft)), b = pct(tAt(scroller.scrollLeft + scroller.clientWidth));
  view.hidden = b < 0 || a > 100;
  view.style.left = clamp(a) + "%";
  view.style.width = clamp(b) - clamp(a) + "%";
  const h = playhead === null ? -1 : pct(playhead);
  head.hidden = h < 0 || h > 100;
  head.style.left = h + "%";
}
function stepDays(n) {
  const b = document.getElementById(n < 0 ? "live-days-back" : "live-days-fwd");
  if (b.disabled || !ov) return;
  const end = ov.w1 + n * (ov.days ? 864e5 : ov.len);
  ovEnd = null;
  ovEnd = end >= ovWindow().w1 ? null : end; // back at (or past) where it would follow: follow again
  if (ovEnd !== null) tracking = false; // look at the stepped window; time runs on
  drawOverview();
  if (ovEnd !== null) scroller.scrollLeft = scroller.scrollWidth;
}
document.getElementById("live-days-back").onclick = () => stepDays(-1);
document.getElementById("live-days-fwd").onclick = () => stepDays(1);
document.getElementById("live-overview-bars").onclick = async (e) => {
  if (!ov) return;
  const r = e.currentTarget.getBoundingClientRect(), {w0, w1, bin: OV_BIN} = ov;
  const t = Math.min(Date.now(), w0 + ((e.clientX - r.left) / r.width) * (w1 - w0));
  if (!strips.length || t < Date.parse(strips[0].start)) await loadDay(pacificDate(t));
  // In a half hour with birds, land on its busiest minute (the start of its first detection
  // there), which is what a short span can show; elsewhere, where clicked.
  const bin = Math.floor(t / OV_BIN) * OV_BIN;
  const inBin = strips.flatMap((s) => s.detections).filter((d) => accepted(d) && Date.parse(d.at) >= bin && Date.parse(d.at) < bin + OV_BIN);
  if (inBin.length) {
    const [, busiest] = d3.greatest(d3.groups(inBin, (d) => Math.floor(Date.parse(d.at) / 6e4)), ([, v]) => v.length);
    return seek(detectionPlaybackStart(d3.min(busiest, (d) => Date.parse(d.at))), PLAYHEAD_AT);
  }
  // A click where there's no audio lands on the nearest audio instead.
  const near = d3.least(strips, (s) => (t < Date.parse(s.start) ? Date.parse(s.start) - t : t > endOf(s) ? t - endOf(s) : 0));
  if (near) seek(Math.max(Date.parse(near.start), Math.min(t, endOf(near) - 1e3)), PLAYHEAD_AT);
};

// Keep incoming names inside the viewport without moving their detection underline.
function positionNames() {
  const viewLeft = scroller.scrollLeft + 4;
  const viewRight = scroller.scrollLeft + scroller.clientWidth - 4;
  const lanes = Array.from({length: LANES}, () => []);
  // Read text widths together before writing positions, avoiding layout per label.
  // Labels away from the view are hidden unmeasured, so days of them stay light.
  const names = [];
  for (const button of track.querySelectorAll(".live-name")) {
    const {start, end} = button.labelGeometry;
    // Do not pin labels whose detection hasn't entered, or has left, the view.
    if (start > viewRight || end < viewLeft) { if (button.style.visibility !== "hidden") button.style.visibility = "hidden"; continue; }
    names.push({button, text: button.querySelector(".live-name-text"), start, end});
  }
  for (const n of names) n.width = n.text.offsetWidth;
  for (const {button, text, width, start, end} of names) {
    const cueWidth = button.dataset.species ? 11 : 0;
    const left = liveLabelLeft(start, width, viewLeft, viewRight, cueWidth);
    const laneLeft = left - cueWidth;
    const right = Math.max(left + width, Math.min(end, viewRight));
    const lane = lanes.findIndex(taken => taken.every(([l, r]) => right + 6 <= l || laneLeft >= r + 6));
    button.style.visibility = lane < 0 ? "hidden" : "visible";
    button.classList.toggle("is-ahead", !aheadShade.hidden && button.run.start > playhead);
    if (lane < 0) continue;
    lanes[lane].push([laneLeft, right]);
    button.style.top = lane * LANE + "px";
    text.style.transform = `translateX(${left - start}px)`;
  }
}

// Older days' strips load as the view (give or take a span) reaches them; live.json holds the
// last 24 hours. loadDay skips days already loaded, so asking every frame is cheap.
function loadNearView() {
  if (!geo) return;
  const pad = span * 1e3, a = tAt(scroller.scrollLeft) - pad, b = tAt(scroller.scrollLeft + scroller.clientWidth) + pad;
  for (const t of [a, b]) if (t < Date.now() - 23 * HOUR && t >= (ov?.w0 ?? t)) loadDay(pacificDate(t));
}

// Pulse only at actual detection times; silence between joined calls stays quiet.
function showActiveDetections() {
  const tick = playhead === null ? null : Math.floor(playhead / 100);
  const key = `${tick}|${paused}`;
  if (activityTick === key) return;
  activityTick = key;
  const set = (node, active) => {
    if (node.classList.contains("is-detecting") !== active) {
      node.classList.toggle("is-detecting", active);
      if (active) node.setAttribute("aria-current", "time");
      else node.removeAttribute("aria-current");
    }
    node.classList.toggle("is-playback-paused", paused);
  };
  for (const {node, starts} of activityLabels) set(node, detectingAt(starts, playhead));
  for (const node of activityRows) set(node, detectingAt(activityIndex.get(node.dataset.activeSpecies) ?? [], playhead));
}

// Each frame: move the playhead, draw its line and, while tracking, scroll to keep it in place.
function frame() {
  if (geo && strips.length) {
    const newest = endOf(strips.at(-1)), offline = offlineSince();
    // Offline, the playhead starts at the newest audio, so nothing replays; when audio comes back,
    // live jumps to it.
    if (playhead === null || (wasOffline && !offline && live && tracking && !soundOn)) { playhead = offline ? newest : newest - FOLLOW_MARGIN; lag = Date.now() - playhead; }
    wasOffline = !!offline;
    // The sound's position, once it has loaded and found its place (until then, where it was sent).
    if (paused) {} // held where it is
    else if (soundOn && current && !player.paused && positioned && !player.seeking) playhead = Date.parse(current.start) + player.currentTime * 1e3;
    else if (!(soundOn && waitingFor !== null)) playhead = Math.min(Date.now() - lag, newest);
    lag = Date.now() - playhead; // so muting, pausing or a late strip doesn't jump
    playheadLine.style.left = x(playhead) + "px";
    playheadLine.hidden = playhead < geo.t0 || playhead > geo.t1; // outside the drawn window, it would widen the scroll range
    const ahead = live && !offline && playhead < geo.t1;
    aheadShade.hidden = !ahead;
    if (ahead) Object.assign(aheadShade.style, {left: x(playhead) + "px", width: x(geo.t1) - x(playhead) + "px"});
    // Live, the view ends at the newest audio (offline, at now, with the stretch without audio in
    // it), unless that would push the playhead out of the view.
    const cw = scroller.clientWidth;
    if (tracking) scroller.scrollLeft = !live ? x(playhead) - anchor * cw
      : offline ? x(geo.t1) - liveAnchor() * cw
      : Math.min(x(geo.t1) - liveAnchor() * cw, x(playhead) - LIVE_PLAYHEAD_MIN * cw);
  }
  loadNearView();
  positionNames();
  followView();
  showView();
  showOverviewView();
  updateDuck();
  showActiveDetections();
  raf = requestAnimationFrame(frame);
}
let wasOffline = false;
let raf = requestAnimationFrame(frame);

// "Live" only while the view follows the live point; scrolled away from it, the button goes back.
function markLive() {
  const following = live && tracking;
  followButton.classList.toggle("is-live", following);
  fwdButton.disabled = live; // nothing newer to step to
  followButton.textContent = following ? "Live" : "Back to live";
  pauseButton.setAttribute("aria-pressed", String(paused));
  pauseButton.title = paused ? "Play (K)" : "Pause (K)";
  pauseButton.setAttribute("aria-label", paused ? "Play" : "Pause");
  followButton.setAttribute("aria-pressed", String(following));
  soundButton.setAttribute("aria-pressed", String(soundOn));
  soundButton.title = soundOn ? "Mute (space)" : "Unmute (space)";
  summarize(); // its hour ends at the playhead only while live
}

// Species cards on the names above the spectrogram, on hover: photo, names, category, and the
// species' minutes heard in the audio loaded (no card until the photos and categories arrive).
let cardMeta = null;
Promise.all([loadPhotos(), loadCategories()]).then(([photos, categories]) => { cardMeta = {photos, categories}; }).catch(() => {});
// The card also reviews the hovered run: Confirm or Reject all its detections (or Undo).
function reviewRun(run, verdict) {
  for (const d of run.dets) localReviews.set(reviewKey(d), verdict);
  postReview(verdict, run.dets.map((d) => ({at: d.at, scientific: d.scientific_name})));
  draw(); summarize();
  document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"})); // close the card; its label was redrawn
}
const stopCards = speciesCards((name, el) => {
  if (!cardMeta) return null;
  const heard = strips.flatMap((s) => s.detections).filter((d) => d.common_name === name && counts(d));
  const sure = heard.filter(accepted);
  const run = el?.run;
  const act = (label, verdict) => Object.assign(html`<button type="button" class="review-button">${label}</button>`, {onclick: () => reviewRun(run, verdict)});
  return {
    photo: cardMeta.photos?.[name], scientific: (heard[0] ?? run?.dets[0])?.scientific_name, category: cardMeta.categories?.species?.[name],
    rows: [["Minutes heard", String(new Set(sure.map((d) => Math.floor(Date.parse(d.at) / 6e4))).size)], ["Best confidence", `${Math.round(100 * (d3.max(heard, (d) => d.confidence) ?? 0))}%`],
      ["Threshold", thresholdText((heard[0] ?? run?.dets[0])?.scientific_name, minConf(), thresholdsFile?.species)]],
    actions: run && html`<div class="species-pop-review"><span>${time(new Date(run.start))}</span>${run.review
      ? [html`<span class="review-state">${run.review === "rejected" ? "✗ Rejected" : "✓ Confirmed"}</span>`, act("Undo", null)]
      : [act("Confirm", "confirmed"), act("Reject", "rejected")]}</div>`
  };
}, {hover: ".live-name", newTab: true});
invalidation.then(stopCards);

// Scrolling by hand (wheel, touch, dragging the scrollbar) frees the view; time runs on.
const freeView = () => { tracking = false; };
for (const type of ["wheel", "touchstart", "mousedown"]) scroller.addEventListener(type, freeView, {passive: true});

// Bird boost: one switch for everything that brings the birds forward, remembered per viewer.
// - It plays each minute's cleaned copy (strip.clean: the Pi has already turned the steady
//   background down, per frequency, before encoding; pipeline/denoise.py).
// - Two filters: a high-pass at 1 kHz takes away the low rumble (wind, traffic, the house,
//   voices) that covers most songbirds, and a broad lift of 6 dB around 4 kHz brings out where
//   they sing. Low-voiced birds (doves, owls, crows) go thin with it, which is why it's a switch.
// - Calls up front: between BirdNET's detections the sound dips DUCK_DB (never silent, so the
//   backyard and the calls it missed still come through); it rises to full DUCK_LEAD ms before a
//   detection's 3 s window and falls DUCK_TAIL ms after it. A "?" detection (below its threshold)
//   opens it halfway. The page is a minute behind, so every detection is known before it plays.
// After it, always, leveling: the recorder keeps its gain fixed so stored audio keeps true
// loudness, which leaves it quiet (background about -60 dBFS, bird calls peaking around -42).
// MAKEUP_DB brings that up to an ordinary volume; a compressor above the background then holds
// loud sounds back (a voice near the mic ends up only a few dB above a bird call, not 20), so
// quiet birds come up without close voices blasting; a limiter at -3 dBFS catches the rest
// (a door, the board being handled), and a soft clipper rounds off the few clicks too sharp for
// it. Set up on the first play (browsers only allow sound after a tap), on the one audio element.
const MAKEUP_DB = 30, DUCK_DB = 12, DUCK_LEAD = 500, DUCK_TAIL = 500;
const BOOST_KEY = "birdtracker-live-boost";
let boost = false, audio = null; // audio: {context, source, chain, out, duck}
try { boost = localStorage.getItem(BOOST_KEY) === "1"; } catch {}
const boostButton = document.getElementById("live-boost");
function route() {
  if (!audio) return;
  audio.source.disconnect();
  audio.source.connect(boost ? audio.chain : audio.out);
}
function setBoost(on) {
  boost = on;
  try { localStorage.setItem(BOOST_KEY, on ? "1" : "0"); } catch {}
  boostButton.setAttribute("aria-pressed", String(on));
  route();
  if (soundOn && current && playhead !== null) playFrom(playhead); // switch to the other copy
}
boostButton.setAttribute("aria-pressed", String(boost));
boostButton.onclick = () => setBoost(!boost);
// How open the calls-up-front dip is at time t (ms): 1 inside a detection's window (with its
// lead and tail ramps), 0.5 for a "?" one, 0 between them.
function duckOpen(t) {
  const i = strips.indexOf(current);
  let open = 0;
  for (const s of strips.slice(Math.max(0, i - 1), i + 2)) {
    for (const d of s.detections) {
      const a = Date.parse(d.at), weight = accepted(d) ? 1 : 0.5;
      const ramp = t < a ? 1 - (a - t) / DUCK_LEAD : t > a + 3e3 ? 1 - (t - a - 3e3) / DUCK_TAIL : 1;
      if (ramp > 0) open = Math.max(open, Math.min(1, ramp) * weight);
    }
  }
  return open;
}
function updateDuck() {
  if (!audio) return;
  const t = current && positioned ? Date.parse(current.start) + player.currentTime * 1e3 : null;
  const gain = boost && t !== null ? 10 ** (-DUCK_DB * (1 - duckOpen(t)) / 20) : 1;
  audio.duck.gain.setTargetAtTime(gain, audio.context.currentTime, 0.05);
}
const newPlayer = () => {
  const el = Object.assign(new Audio(), {preload: "auto", onended: () => { if (soundOn) playFrom(endOf(current)); }});
  el.ontimeupdate = updateDuck; // frames stop in a background tab; this keeps the dip moving there
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
    const duck = context.createGain();
    highpass.connect(lift).connect(duck).connect(makeup);
    audio = {context, source, chain: highpass, out: makeup, duck};
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
  player.src = LIVE + (boost && strip.clean ? strip.clean : strip.audio);
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
  playhead = t;
  if (ov && (t < ov.w0 || t >= ov.w1)) ovEnd = null; // outside the overview window: it follows the playhead there
  drawOverview(); // and the track with it
  lag = Date.now() - t;
  live = false;
  tracking = true;
  anchor = at;
  if (soundOn && !paused) playFrom(t); else waitingFor = null;
  markLive();
  showStatus();
}
// Step 10 s, the line staying put; a step forward that would pass the live point goes live.
function step(ms) {
  if (!strips.length) return;
  const t = (playhead ?? endOf(strips.at(-1))) + ms;
  if (ms > 0 && t >= endOf(strips.at(-1)) - FOLLOW_MARGIN) { if (!(live && tracking)) goLive(); return; }
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
    if (!paused) playFrom(playhead ?? endOf(strips.at(-1)) - FOLLOW_MARGIN);
  }
  markLive();
  showStatus();
}

// Back to live: just behind the newest audio, the view tracking it (and the sound, if on).
function goLive() {
  if (!strips.length) return;
  ovEnd = null; // the overview follows again
  paused = false;
  live = true;
  tracking = true;
  playhead = endOf(strips.at(-1)) - (offlineSince() ? 0 : FOLLOW_MARGIN);
  lag = Date.now() - playhead;
  if (soundOn) playFrom(playhead);
  markLive();
  showStatus();
}

// Pause and resume: the playhead (and the sound, if on) stops where it is; pausing leaves live.
const pauseButton = document.getElementById("live-pause");
function togglePause() {
  if (!strips.length) return;
  paused = !paused;
  if (paused) { live = false; player?.pause(); waitingFor = null; }
  else { lag = Date.now() - playhead; if (soundOn) playFrom(playhead); }
  markLive();
  showStatus();
}
pauseButton.onclick = togglePause;
followButton.onclick = () => { if (!(live && tracking)) goLive(); };
soundButton.onclick = toggleSound;
document.getElementById("live-back").onclick = () => step(-STEP);
fwdButton.onclick = () => step(STEP);
// Clicking these shouldn't leave them focused, where space would press them again.
for (const b of [pauseButton, followButton, soundButton, boostButton, document.getElementById("live-back"), document.getElementById("live-fwd")]) b.onmousedown = (e) => e.preventDefault();

// Only background/strip clicks seek to the pointer. Name buttons seek to the run start.
track.addEventListener("click", (event) => {
  if (!geo || event.target.closest("a, button")) return;
  const box = scroller.getBoundingClientRect();
  const at = (event.clientX - box.left) / scroller.clientWidth;
  seek(tAt(scroller.scrollLeft + event.clientX - box.left), at);
});

// The last hour as a chart: a row per species, in the order they were first heard (so a new bird
// is added at the bottom), with a cell for each clock minute it was heard in (the site's
// "minutes heard"); neighbouring minutes join into one bar, the latest drawn darker. On the
// right: the minutes in total and when it was last heard. The stretch the spectrogram shows is
// shaded, and scrolling the spectrogram moves the chart's hour with it; clicking the chart takes
// the spectrogram (and the sound, if on) to that moment.
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
  // While live and the view follows, the hour ends at the moment shown (so the chart never gets
  // ahead of the spectrogram); otherwise it's the hour around the middle of the spectrogram's view.
  const newest = strips.length ? endOf(strips.at(-1)) : Date.now();
  const lastHour = playhead === null || (live && tracking);
  const w1 = playhead === null ? newest : lastHour ? Math.min(playhead, newest) : hourEndAround(viewMiddle() ?? playhead, newest);
  const w0 = w1 - HOUR;
  const hourLabel = lastHour ? "the last hour" : `${time(new Date(w0))}–${time(new Date(w1))}`;
  hourView = {w0, w1};
  const pct = (t) => ((t - w0) / HOUR) * 100 + "%";
  heardHeading.textContent = `Heard ${hourLabel === "the last hour" ? "in the last hour" : hourLabel}`;
  const detections = [...strips.flatMap((s) => s.detections), ...unidentifiedDetections(strips)].filter((d) =>
    shownInGantt({confidence: d.confidence, review: reviewOf(d), scientific_name: d.scientific_name}, confidentOnly.checked, minConf(), thresholdsFile?.species) && Date.parse(d.at) >= w0 && Date.parse(d.at) <= w1);
  const rows = d3.groups(detections, (d) => d.common_name).map(([name, v]) => {
    const byMinute = d3.rollup(v, (w) => ({best: d3.max(w, (d) => d.confidence), first: d3.min(w, (d) => Date.parse(d.at)), confident: w.some(accepted)}),
      (d) => Math.floor(Date.parse(d.at) / 60e3) * 60e3);
    const bars = [];
    for (const m of [...byMinute.keys()].sort((a, b) => a - b)) {
      const bar = bars.at(-1), {best, first, confident} = byMinute.get(m);
      if (bar && bar.end === m && bar.confident === confident) { bar.end = m + 60e3; bar.minutes++; bar.best = Math.max(bar.best, best); }
      else bars.push({start: m, end: m + 60e3, minutes: 1, best, first, confident}); // first: its first detection, where a click goes
    }
    return {name, bars, unidentified: v.some(d => d.unidentified), uncertain: !v.some(accepted), minutes: byMinute.size, first: d3.min(v, (d) => Date.parse(d.at)), last: d3.max(v, (d) => Date.parse(d.at))};
  }).sort((a, b) => sort.dir * (SORTS[sort.by](a) - SORTS[sort.by](b)) || a.first - b.first);

  if (!rows.length) {
    activityRows = [];
    heard.replaceChildren(html`<p class="sub">${confidentOnly.checked ? "No confident detections" : "No birds heard"} in ${hourLabel}.</p>`);
  } else {
    const ticks = d3.timeMinute.every(15).range(new Date(w0), new Date(w1)).map(Number);
    const lanes = rows.map((r, i) => html`<div class="live-gantt-lane" data-name=${r.name} style=${`grid-row: ${i + 2}`}>${r.bars.map((b, j) =>
        html`<span class=${`live-gantt-bar${j === r.bars.length - 1 ? " is-last" : ""}${b.confident ? "" : " is-unsure"}`} data-first=${b.first} data-tip=${`${r.name}\n${time(new Date(b.start))}–${time(new Date(Math.min(b.end, w1)))} · ${b.minutes} min · ${b.confident ? "" : "uncertain · "}${r.unidentified ? "species not identified" : `best ${Math.round(b.best * 100)}%`}`}
          style=${{left: pct(Math.max(b.start, w0)), width: `calc(${pct(Math.min(b.end, w1))} - ${pct(Math.max(b.start, w0))})`}}></span>`)}</div>`);
    heard.replaceChildren(html`<div class="live-gantt">
      <div class="live-gantt-grid">
        ${header("first", "First heard", "live-gantt-sort-first")}
        <span class="live-gantt-total live-gantt-head">${header("minutes", "Total")}${header("last", "Last")}</span>
        ${rows.flatMap((r, i) => [
          r.unidentified ? html`<span class="live-gantt-name is-unsure" style=${`grid-row: ${i + 2}`}>${UNIDENTIFIED}</span>` : html`<a class=${`live-gantt-name${r.uncertain ? " is-unsure" : ""}`} data-active-species=${r.name} href=${speciesHref(r.name)} title=${r.uncertain ? `${r.name}: uncertain detections` : r.name} style=${`grid-row: ${i + 2}`}>${r.uncertain ? "? " : ""}${r.name}</a>`,
          lanes[i],
          html`<span class="sub live-gantt-total" style=${`grid-row: ${i + 2}`}><span>${r.minutes} min</span><span>${time(new Date(r.last))}</span></span>`
        ])}
        <div class="live-gantt-overlay" aria-hidden="true" style=${`grid-row: 2 / span ${rows.length}`}>
          ${ticks.map((t) => html`<span class="live-gantt-grid-line" style=${{left: pct(t)}}></span>`)}
          <span class="live-gantt-view" id="live-gantt-view" hidden></span>
          <span class="live-gantt-playhead" id="live-gantt-playhead" hidden></span>
        </div>
        <div class="live-gantt-axis" aria-hidden="true" style=${`grid-row: ${rows.length + 2}`}>${ticks.map((t) => html`<span class=${new Date(t).getMinutes() % 30 ? "is-minor" : ""} style=${{left: pct(t)}}>${time(new Date(t))}</span>`)}</div>
      </div>
      ${ganttTip}
    </div>`);
    activityRows = [...heard.querySelectorAll("[data-active-species]")];
    activityTick = null;
    const grid = heard.querySelector(".live-gantt-grid");
    grid.onclick = (event) => {
      const lane = event.target.closest(".live-gantt-lane");
      if (!lane) return;
      // Anywhere over a bar's stretch of the row (not just its thin height, with a few px
      // of slack for one-minute bars) goes to the start of that run; elsewhere, to the time
      // under the cursor.
      const bar = event.target.closest(".live-gantt-bar") ?? [...lane.querySelectorAll(".live-gantt-bar")].find((b) => {
        const r = b.getBoundingClientRect();
        return event.clientX >= r.left - 3 && event.clientX <= r.right + 3;
      });
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
}

const viewMiddle = () => (geo ? tAt(scroller.scrollLeft + scroller.clientWidth / 2) : null);
const hourEndAround = (t, newest) => Math.min(t + HOUR / 2, newest);
// Unless live and following, the hour chart follows the spectrogram's view: once the view's middle
// is more than a fifth of an hour from the chart's, the chart re-centres on it (called every frame).
let wasLastHour = true;
function followView() {
  const lastHour = live && tracking;
  if (lastHour !== wasLastHour) { wasLastHour = lastHour; markLive(); return; } // which also redraws the chart
  if (lastHour || !hourView || !strips.length || viewMiddle() === null) return;
  if (Math.abs(hourEndAround(viewMiddle(), endOf(strips.at(-1))) - hourView.w1) > HOUR / 5) summarize();
}

// Shade, on the hour chart, the stretch the spectrogram shows now (called every frame).
function showView() {
  const view = document.getElementById("live-gantt-view");
  if (!view || !geo || !hourView) return;
  const {w0, w1} = hourView;
  // The playhead, dashed as over the spectrogram; while live and following, the chart ends there,
  // so it's left out.
  const head = document.getElementById("live-gantt-playhead");
  head.hidden = (live && tracking) || playhead === null || playhead < w0 || playhead > w1;
  if (!head.hidden) head.style.left = ((playhead - w0) / (w1 - w0)) * 100 + "%";
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
  seek(detectionPlaybackStart(t), PLAYHEAD_AT);
  document.querySelector(".live-head").scrollIntoView({block: "nearest", behavior: "smooth"});
}

function showStatus() {
  if (!strips.length) { status.textContent = "Nothing from the recorder yet. Strips appear here about a minute after it starts recording."; return; }
  const last = strips.at(-1);
  const end = new Date(Date.parse(last.start) + last.seconds * 1e3);
  const quiet = (Date.now() - end) / 60e3 > STALE_MINUTES;
  status.textContent = quiet && live && !soundOn
    ? `No audio from the recorder since ${dayTime(end)}.`
    : soundOn && waitingFor !== null
    ? "Waiting for the next minute of audio…"
    : playhead !== null
    ? `${paused ? "Paused at" : soundOn ? "Listening to" : "Showing"} ${time(new Date(playhead), true)}`
    : `Latest audio ${time(end)}`;
  status.classList.toggle("is-quiet", quiet);
}

async function poll() {
  try {
    fetch(LIVE + "reviews.json", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j || JSON.stringify(j) === JSON.stringify(serverReviews)) return;
      serverReviews = j;
      for (const [k, v] of localReviews) if ((serverReviews[k] ?? null) === v) localReviews.delete(k); // the Pi has it now
      draw(); summarize();
    }).catch(() => {});
    fetch(LIVE + "thresholds.json", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j || JSON.stringify(j) === JSON.stringify(thresholdsFile)) return;
      thresholdsFile = j;
      draw(); summarize();
    }).catch(() => {});
    const r = await fetch(LIVE + "live.json", {cache: "no-store"});
    if (r.status === 404) { strips = []; }
    else if (!r.ok) throw new Error(`HTTP ${r.status}`);
    else {
      const j = await r.json();
      if (j.updated === updated) { if (offlineSince()) draw(); return; }
      updated = j.updated;
      strips = mergeStrips(older, j.strips ?? []);
    }
    transport.hidden = !strips.length;
    audioControls.hidden = !strips.some((s) => s.audio);
    draw();
    markLive();
    if (pendingJump && strips.length) {
      const t = pendingJump;
      pendingJump = null;
      if (t < Date.parse(strips[0].start)) await loadDay(pacificDate(t));
      seek(detectionPlaybackStart(t), PLAYHEAD_AT);
    }
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
// Keys: space (or M) mutes and unmutes, arrows step 10 s, L goes back to live, B switches Bird boost, F toggles fullscreen.
const keys = (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select")) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if ((k === " " && !e.target.closest?.("a")) || k === "m") toggleSound(); // space even with a button focused
  else if (k === "ArrowLeft" && e.shiftKey) stepDays(-1);
  else if (k === "ArrowRight" && e.shiftKey) stepDays(1);
  else if (k === "ArrowLeft") step(-STEP);
  else if (k === "ArrowRight") step(STEP);
  else if (k === "l") goLive();
  else if (k === "k") togglePause();
  else if (k === "b") setBoost(!boost);
  else if (k === "f") toggleFull();
  else return;
  e.preventDefault();
};
document.addEventListener("keydown", keys);
document.addEventListener("fullscreenchange", markFull);


poll();
const timer = setInterval(poll, POLL_SECONDS * 1e3);
const clock = setInterval(showStatus, 1000); // the time shown
const hourTimer = setInterval(summarize, 5e3); // slide the hour chart along with the playhead
const resize = new ResizeObserver(() => draw());
resize.observe(scroller);
invalidation.then(() => { document.removeEventListener("keydown", keys); document.removeEventListener("fullscreenchange", markFull); clearInterval(timer); clearInterval(clock); clearInterval(hourTimer); resize.disconnect(); cancelAnimationFrame(raf); player?.pause(); });
```
