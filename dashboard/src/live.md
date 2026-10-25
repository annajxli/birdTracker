---
title: Live
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- The recorder, about a minute behind: the analyzer draws a spectrogram strip of each minute
     of audio and lists that minute's detections in live.json; pipeline/publish.py uploads both to
     R2 and the password Worker serves them under /api/live/. This page polls live.json, lays the
     strips out by their start time (newest at the right) and names the birds above them. -->

```js
import {speciesHref} from "./components/birds.js";
```

```js
const POLL_SECONDS = 30, MIN_CONF = 0.6, WINDOW_SECONDS = 300, HOUR = 3600e3;
const LIVE = "/api/live/";
const STALE_MINUTES = 10; // no new strip for this long: say the recorder is quiet
const RUN_GAP = 6e3; // detections of one species this close together are one run
const time = (d) => d.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"});
```

<div class="live-head">
  <p class="sub live-status" id="live-status">Loading…</p>
</div>

<div class="live-scroller" id="live-scroller" tabindex="0" aria-label="Spectrogram of the recorder's recent audio, newest at the right">
  <div class="live-track" id="live-track"></div>
</div>
<div class="live-earlier"><button type="button" id="live-earlier" hidden>Show an earlier hour</button></div>

<div id="live-heard"></div>

```js
const scroller = document.getElementById("live-scroller");
const track = document.getElementById("live-track");
const status = document.getElementById("live-status");
const earlier = document.getElementById("live-earlier");
const heard = document.getElementById("live-heard");

let strips = []; // from live.json, oldest first
let shownFrom = null; // start of the earliest strip drawn (ms)
let updated = null;

const LANE = 20, LANES = 3, SPEC_TOP = LANE * LANES + 6, SPEC_H = 128, AXIS_H = 22;

// Scale: about five minutes across the visible width.
const pxPerSecond = () => Math.max(2, scroller.clientWidth / WINDOW_SECONDS);

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

function draw() {
  const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 8;
  const shown = strips.filter((s) => Date.parse(s.start) >= shownFrom);
  track.replaceChildren();
  if (!shown.length) { track.style.width = "100%"; return; }
  const pps = pxPerSecond();
  const t0 = Date.parse(shown[0].start);
  const last = shown.at(-1);
  const t1 = Date.parse(last.start) + last.seconds * 1e3;
  const x = (t) => ((t - t0) / 1e3) * pps;
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
  // Minute ticks under the strips.
  for (let t = Math.ceil(t0 / 60e3) * 60e3; t <= t1; t += 60e3) {
    const tick = document.createElement("div");
    tick.className = "live-tick";
    tick.style.left = x(t) + "px";
    tick.style.top = SPEC_TOP + SPEC_H + "px";
    tick.textContent = time(new Date(t));
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
  if (atEnd || !draw.scrolled) scroller.scrollLeft = scroller.scrollWidth;
  draw.scrolled = true;
}

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
    : `About a minute behind the recorder · latest audio ${time(end)}`;
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
    draw();
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
invalidation.then(() => { clearInterval(timer); resize.disconnect(); });
```
