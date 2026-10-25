---
title: Live
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- The recorder, a minute or two behind: the analyzer draws a spectrogram strip of each minute
     of audio, saves its sound as MP3 and lists that minute's detections in live.json;
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

const LANE = 20, LANES = 4, SPEC_TOP = LANE * LANES + 6, SPEC_H = 160, AXIS_H = 22;
const MAX_KHZ = 12; // the strips' top row (spectrogram.py's MAX_HZ)

// Frequency labels, in their own column left of the strips (which scroll past them).
document.getElementById("live-freq").replaceChildren(
  ...[12, 8, 4, 0].map((khz) => {
    const label = document.createElement("span");
    label.textContent = String(khz);
    label.style.top = SPEC_TOP + SPEC_H * (1 - khz / MAX_KHZ) + "px";
    return label;
  }),
  Object.assign(document.createElement("span"), {className: "live-freq-unit", textContent: "kHz", style: `top: ${SPEC_TOP - 16}px`})
);

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

// Strips are masks (loudness in the alpha channel; spectrogram.py); each is painted through the
// YlGn colormap (dark green for silence, light yellow for loud), with a square root so faint
// sound shows. Images are loaded once and kept.
const lut = d3.range(256).map((i) => d3.rgb(d3.interpolateYlGn(1 - Math.sqrt(i / 255))));
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
async function paintStrip(canvas, url) {
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
    const el = document.createElement("canvas");
    el.className = "live-strip";
    el.width = Math.max(1, Math.round(s.seconds * pps));
    el.height = SPEC_H;
    Object.assign(el.style, {left: x(Date.parse(s.start)) + "px", width: el.width + "px", top: SPEC_TOP + "px", height: SPEC_H + "px"});
    paintStrip(el, LIVE + s.image);
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
  // Names above the strips, in lanes so they don't overlap; a run that finds no free lane is
  // left out. Every BirdNET detection is shown with its score as a percentage: ones at the
  // dashboard's threshold in bold, weaker ones faint with a question mark, so where BirdNET is torn between
  // species, the candidates show side by side. Confident runs are placed first, then the rest by
  // score, so a crowded stretch keeps its surest names.
  const lanes = Array.from({length: LANES}, () => []);
  const sure = (r) => r.best >= MIN_CONF;
  for (const r of runs(shown, 0).sort((a, b) => sure(b) - sure(a) || b.best - a.best)) {
    const label = `${sure(r) ? "" : "? "}${r.name} (${Math.round(r.best * 100)}%)`;
    const left = x(r.start), labelWidth = label.length * 7 + 12;
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
  showView();
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
  summarize(); // its hour ends at the playhead only while following
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

// The last hour as a chart: a row per species, in the order they were first heard (so a new bird
// is added at the bottom), with a cell for each clock minute it was heard in (the site's
// "minutes heard"); neighbouring minutes join into one bar, the latest drawn darker. On the
// right: the minutes in total and when it was last heard. The stretch the spectrogram shows is
// shaded; clicking the chart takes the spectrogram (and the sound, if on) to that moment.
let hourView = null; // {w0, w1}: the chart's time range
const ganttTip = Object.assign(document.createElement("div"), {className: "live-gantt-tip", hidden: true});

function summarize() {
  // The hour ends at the moment shown while following (so the chart never gets ahead of the
  // spectrogram), else at the newest audio.
  const newest = strips.length ? endOf(strips.at(-1)) : Date.now();
  const w1 = following && playhead !== null ? Math.min(playhead, newest) : newest, w0 = w1 - HOUR;
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
  }).sort((a, b) => a.first - b.first);

  if (!rows.length) {
    heard.replaceChildren(html`<p class="sub">No birds named in the last hour.</p>`);
  } else {
    const ticks = d3.timeMinute.every(15).range(new Date(w0), new Date(w1)).map(Number);
    const lanes = rows.map((r, i) => html`<div class="live-gantt-lane" data-name=${r.name} style=${`grid-row: ${i + 1}`}>${r.bars.map((b, j) =>
        html`<span class=${j === r.bars.length - 1 ? "live-gantt-bar is-last" : "live-gantt-bar"} data-first=${b.first} data-tip=${`${r.name}\n${time(new Date(b.start))}–${time(new Date(Math.min(b.end, w1)))} · ${b.minutes} min · best ${Math.round(b.best * 100)}%`}
          style=${{left: pct(Math.max(b.start, w0)), width: `calc(${pct(Math.min(b.end, w1))} - ${pct(Math.max(b.start, w0))})`}}></span>`)}</div>`);
    heard.replaceChildren(html`<div class="live-gantt">
      <p class="eyebrow">Heard in the last hour</p>
      <div class="live-gantt-grid">
        ${rows.flatMap((r, i) => [
          html`<a class="live-gantt-name" href=${speciesHref(r.name)} title=${r.name} style=${`grid-row: ${i + 1}`}>${r.name}</a>`,
          lanes[i],
          html`<span class="sub live-gantt-total" style=${`grid-row: ${i + 1}`}><span>total ${r.minutes} min</span><span>last ${time(new Date(r.last))}</span></span>`
        ])}
        <div class="live-gantt-overlay" aria-hidden="true" style=${`grid-row: 1 / span ${rows.length}`}>
          ${ticks.map((t) => html`<span class="live-gantt-grid-line" style=${{left: pct(t)}}></span>`)}
          <span class="live-gantt-view" id="live-gantt-view" hidden></span>
        </div>
        <div class="live-gantt-axis" aria-hidden="true" style=${`grid-row: ${rows.length + 1}`}>${ticks.map((t) => html`<span class=${new Date(t).getMinutes() % 30 ? "is-minor" : ""} style=${{left: pct(t)}}>${time(new Date(t))}</span>`)}</div>
      </div>
      ${ganttTip}
    </div>`);
    const grid = heard.querySelector(".live-gantt-grid");
    grid.onclick = (event) => {
      const lane = event.target.closest(".live-gantt-lane");
      if (!lane) return;
      const bar = event.target.closest(".live-gantt-bar");
      const box = lane.getBoundingClientRect();
      jumpTo(bar ? Number(bar.dataset.first) : w0 + ((event.clientX - box.left) / box.width) * HOUR);
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

// From the hour chart: show the spectrogram at `t`. With the sound on, play from there and
// follow; otherwise stop following and put `t` a quarter of the way into the view.
function jumpTo(t) {
  if (!strips.length) return;
  if (t < shownFrom) { shownFrom = t - 60e3; draw(); }
  const newest = endOf(strips.at(-1));
  if (listening) {
    following = true;
    playhead = Math.min(t, newest);
    lag = Date.now() - playhead;
    playFrom(playhead);
  } else {
    following = false;
    player?.pause();
    waitingFor = null;
    scroller.scrollLeft = x(t + span * 750) - scroller.clientWidth;
  }
  markLive();
  showStatus();
  showView();
  document.querySelector(".live-head").scrollIntoView({block: "nearest", behavior: "smooth"});
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
    : following && playhead !== null
    ? `Showing ${time(new Date(playhead), true)}`
    : geo
    ? `Showing ${time(new Date(Math.min(tAt(scroller.scrollLeft + scroller.clientWidth), end)), true)}`
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
const clock = setInterval(showStatus, 1000); // the playing time
const hourTimer = setInterval(summarize, 5e3); // slide the hour chart along with the playhead
const resize = new ResizeObserver(() => draw());
resize.observe(scroller);
invalidation.then(() => { clearInterval(timer); clearInterval(clock); clearInterval(hourTimer); resize.disconnect(); cancelAnimationFrame(raf); player?.pause(); });
```
