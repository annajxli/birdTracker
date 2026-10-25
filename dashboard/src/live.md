---
title: Live
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- The recorder, a minute or two behind: the analyzer draws a spectrogram strip of each minute
     of audio, saves its sound as Opus and lists that minute's detections in live.json;
     pipeline/publish.py uploads them to R2 and the password Worker serves them under /api/live/.
     This page polls live.json, lays the strips out by their start time and names the birds above
     them. A playhead follows the recording far enough behind that the next minute has arrived
     before it gets there, so the view scrolls smoothly; Listen plays the sound, which then drives
     the playhead. Scrolling by hand stops following until Back to live is pressed. -->

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
    <button type="button" class="live-button live-follow" id="live-follow" hidden>Back to live</button>
    <button type="button" class="live-button" id="live-listen" aria-pressed="false" hidden>Listen</button>
    <div class="period-segments live-span" id="live-span" role="group" aria-label="Time shown across the screen"></div>
  </div>
</div>

<div class="live-frame">
  <div class="live-scroller" id="live-scroller" tabindex="0" aria-label="Spectrogram of the recorder's recent audio, newest at the right">
    <div class="live-track" id="live-track"></div>
  </div>
  <div class="live-freq" id="live-freq" aria-hidden="true"></div>
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
const listenButton = document.getElementById("live-listen");

let strips = []; // from live.json, oldest first
let shownFrom = null; // start of the earliest strip drawn (ms)
let updated = null;
let geo = null; // {t0, pps}: the drawn track's time at x = 0 and its scale
const x = (t) => ((t - geo.t0) / 1e3) * geo.pps;
const tAt = (px) => geo.t0 + (px / geo.pps) * 1e3;
const endOf = (s) => Date.parse(s.start) + s.seconds * 1e3;

// The playhead: where the right edge of the view sits while following. Wall clock minus `lag`,
// held at the newest audio if the next strip is late; while listening, the audio's own position.
let following = true, lag = null, playhead = null;
// Listening: one audio element for the whole session, so browsers that only allow sound after a
// tap (Safari) keep allowing it from one minute to the next.
let listening = false, player = null, current = null, waitingFor = null;

const LANE = 20, LANES = 3, SPEC_TOP = LANE * LANES + 6, SPEC_H = 128, AXIS_H = 22;
const MAX_KHZ = 12; // the strips' top row (spectrogram.py's MAX_HZ)

// Frequency labels, fixed over the left edge while the strips scroll under them.
document.getElementById("live-freq").replaceChildren(...[12, 8, 4, 0].map((khz) => {
  const label = document.createElement("span");
  label.textContent = khz === MAX_KHZ ? `${khz} kHz` : String(khz);
  label.style.top = SPEC_TOP + SPEC_H * (1 - khz / MAX_KHZ) + "px";
  return label;
}));

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

// Detections at the dashboard's threshold, joined into runs: one per species per stretch of song.
function runs(list) {
  const out = [];
  const open = new Map();
  for (const d of list.flatMap((s) => s.detections).filter((d) => d.confidence >= MIN_CONF).sort((a, b) => a.at.localeCompare(b.at))) {
    const t = Date.parse(d.at);
    const run = open.get(d.common_name);
    if (run && t - run.end <= RUN_GAP) { run.end = t + 3e3; run.best = Math.max(run.best, d.confidence); continue; }
    const r = {name: d.common_name, start: t, end: t + 3e3, best: d.confidence};
    open.set(d.common_name, r);
    out.push(r);
  }
  return out;
}

// Redraws the track; the moment at the right edge of the view stays put (while following, the
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
  const width = Math.max(scroller.clientWidth, x(t1));
  track.style.width = width + "px";
  track.style.height = SPEC_TOP + SPEC_H + AXIS_H + "px";

  for (const s of shown) {
    const el = document.createElement("div");
    el.className = "live-strip";
    Object.assign(el.style, {left: x(Date.parse(s.start)) + "px", width: s.seconds * pps + "px", top: SPEC_TOP + "px", height: SPEC_H + "px"});
    el.style.setProperty("--spec", `url("${LIVE}${s.image}")`);
    track.append(el);
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
  // Names above the strips, in up to three lanes so they don't overlap; a run that finds no
  // free lane is left out (the list below still counts it).
  // Most confident first, so a crowded stretch keeps its surest names.
  const lanes = Array.from({length: LANES}, () => []);
  for (const r of runs(shown).sort((a, b) => b.best - a.best)) {
    const left = x(r.start), labelWidth = r.name.length * 7 + 12;
    const right = Math.max(left + labelWidth, x(r.end));
    const lane = lanes.findIndex((taken) => taken.every(([l, rr]) => right + 6 <= l || left >= rr + 6));
    if (lane < 0) continue;
    lanes[lane].push([left, right]);
    const a = document.createElement("a");
    a.className = "live-name";
    a.href = speciesHref(r.name);
    a.textContent = r.name;
    a.title = `${r.name}: ${time(new Date(r.start))}, confidence ${r.best.toFixed(2)}`;
    Object.assign(a.style, {left: left + "px", top: lane * LANE + "px"});
    a.style.setProperty("--run", Math.max(2, x(r.end) - left) + "px");
    track.append(a);
  }
  if (!following && rightEdge !== null) scroller.scrollLeft = x(rightEdge) - scroller.clientWidth;
  else if (rightEdge === null) scroller.scrollLeft = scroller.scrollWidth;
}

// Following: each frame, put the playhead at the right edge of the view.
function frame() {
  if (following && geo && strips.length) {
    const newest = endOf(strips.at(-1));
    if (listening && current && !player.paused) playhead = Date.parse(current.start) + player.currentTime * 1e3;
    else if (!listening) {
      if (lag === null) lag = Date.now() - newest + FOLLOW_MARGIN;
      playhead = Math.min(Date.now() - lag, newest);
    }
    if (playhead !== null) {
      lag = Date.now() - playhead; // so stopping the sound or a late strip doesn't jump the view
      scroller.scrollLeft = x(playhead) - scroller.clientWidth;
    }
  }
  raf = requestAnimationFrame(frame);
}
let raf = requestAnimationFrame(frame);

function markLive() {
  followButton.hidden = !strips.length;
  followButton.classList.toggle("is-live", following);
  followButton.textContent = following ? "Live" : "Back to live";
  followButton.setAttribute("aria-pressed", String(following));
  listenButton.setAttribute("aria-pressed", String(listening));
  listenButton.textContent = listening ? "Stop" : "Listen";
}

// Scrolling by hand (wheel, touch, scrollbar, keys) stops following, and pauses the sound.
function stopFollowing() {
  if (!following) return;
  following = false;
  player?.pause();
  waitingFor = null;
  markLive();
}
for (const type of ["wheel", "touchstart", "mousedown", "keydown"]) scroller.addEventListener(type, stopFollowing, {passive: true});

// Back to live: jump to just behind the newest audio and follow (and listen, if Listen was on).
followButton.onclick = () => {
  if (following || !strips.length) return;
  following = true;
  playhead = endOf(strips.at(-1)) - FOLLOW_MARGIN;
  lag = Date.now() - playhead;
  if (listening) playFrom(playhead);
  markLive();
};

// Listen: play the minute under the playhead, then each next one; if the next hasn't arrived
// yet, wait for it (poll() picks the sound up again).
function playFrom(t) {
  const strip = strips.find((s) => s.audio && endOf(s) > t + 250);
  if (!strip) { waitingFor = t; showStatus(); return; }
  waitingFor = null;
  current = strip;
  const offset = Math.max(0, (t - Date.parse(strip.start)) / 1e3);
  player.src = LIVE + strip.audio;
  player.addEventListener("loadedmetadata", () => { player.currentTime = Math.min(offset, player.duration || offset); }, {once: true});
  player.play().catch((error) => {
    if (error.name === "AbortError") return; // replaced by the next playFrom
    listening = false;
    markLive();
    status.textContent = "The browser stopped the sound. Press Listen to start it again.";
  });
  showStatus();
}
listenButton.onclick = () => {
  player ??= Object.assign(new Audio(), {preload: "auto", onended: () => { if (listening && following) playFrom(endOf(current)); }});
  if (listening) {
    listening = false;
    player.pause();
    waitingFor = null;
  } else {
    listening = true;
    // From where the view is: the playhead while following, else the right edge of the view.
    const from = following && playhead !== null ? playhead : geo ? tAt(scroller.scrollLeft + scroller.clientWidth) : endOf(strips.at(-1)) - FOLLOW_MARGIN;
    following = true;
    lag = Date.now() - from;
    playFrom(from);
  }
  markLive();
  showStatus();
};

function summarize() {
  const since = Date.now() - HOUR;
  const recent = strips.filter((s) => Date.parse(s.start) + s.seconds * 1e3 >= since);
  const bySpecies = d3.rollups(runs(recent), (v) => ({count: v.length, last: d3.max(v, (r) => r.end)}), (r) => r.name)
    .sort((a, b) => b[1].last - a[1].last);
  heard.replaceChildren(bySpecies.length
    ? html`<div class="live-heard"><p class="eyebrow">Heard in the last hour</p><ul>${bySpecies.map(([name, v]) =>
        html`<li><a href=${speciesHref(name)}>${name}</a><span class="sub">${time(new Date(v.last))}</span></li>`)}</ul></div>`
    : html`<p class="sub">No birds named in the last hour.</p>`);
  earlier.hidden = !strips.length || Date.parse(strips[0].start) >= shownFrom;
}

function showStatus() {
  if (!strips.length) { status.textContent = "Nothing from the recorder yet. Strips appear here about a minute after it starts recording."; return; }
  const last = strips.at(-1);
  const end = new Date(Date.parse(last.start) + last.seconds * 1e3);
  const quiet = (Date.now() - end) / 60e3 > STALE_MINUTES;
  status.textContent = quiet
    ? `No audio from the recorder since ${time(end)}.`
    : listening && waitingFor !== null
    ? "Waiting for the next minute of audio…"
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
    listenButton.hidden = !strips.some((s) => s.audio);
    draw();
    markLive();
    if (listening && following && waitingFor !== null) playFrom(waitingFor);
    summarize();
    showStatus();
  } catch (e) {
    status.textContent = `Couldn't reach the recorder's data (${e.message}). Trying again shortly.`;
  }
}

earlier.onclick = () => {
  const keep = scroller.scrollWidth - scroller.scrollLeft;
  shownFrom -= HOUR;
  draw();
  scroller.scrollLeft = scroller.scrollWidth - keep; // stay on the same audio
  summarize();
};

poll();
const timer = setInterval(poll, POLL_SECONDS * 1e3);
const resize = new ResizeObserver(() => draw());
resize.observe(scroller);
invalidation.then(() => { clearInterval(timer); resize.disconnect(); cancelAnimationFrame(raf); player?.pause(); });
```
