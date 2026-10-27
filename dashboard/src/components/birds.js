import {dailyTemperatureSeries} from "./weather-series.js";
import {FileAttachment} from "observablehq:stdlib";
import * as d3 from "npm:d3";
import * as Inputs from "npm:@observablehq/inputs";
import * as htl from "npm:htl";
import * as Plot from "npm:@observablehq/plot";

/**
 * A table the recorder publishes (data/<name>.parquet). Fetched fresh from its bucket each time a
 * page opens (pipeline/publish.py uploads it every few minutes; the password Worker serves it), so
 * the pages stay current without a rebuild. Falls back to the copy built into the site when that
 * isn't reachable or is still empty (the local preview, or before the recorder has published).
 */
async function latestTable(name, builtIn, {fallback = true} = {}) {
  try {
    const response = await fetch(`/api/data/${name}.parquet`, {cache: "no-store", signal: AbortSignal.timeout(30_000)});
    if (response.ok) {
      const [Arrow, Parquet, buffer] = await Promise.all([
        import("npm:apache-arrow"),
        import("npm:parquet-wasm").then(async (P) => (await P.default(import.meta.resolve("npm:parquet-wasm/esm/parquet_wasm_bg.wasm")), P)),
        response.arrayBuffer()
      ]);
      const table = Arrow.tableFromIPC(Parquet.readParquet(new Uint8Array(buffer)).intoIPCStream());
      if (table.numRows) return table;
    }
    throw new Error(`Latest ${name} is unavailable or empty.`);
  } catch (error) {
    if (!fallback) throw error;
    console.warn(`Latest ${name} unavailable; using the built copy.`, error);
  }
  return builtIn();
}

export const detectionsTable = (options) => latestTable("detections", () => FileAttachment("../data/detections.parquet").parquet(), options);

/** The recorder's telemetry, one row per recording (Hardware analytics), fresh like the detections. */
export const recordingsTable = (options) => latestTable("recordings", () => FileAttachment("../data/recordings.parquet").parquet(), options);

/** When the newest recorded audio ends (the Live view's feed), or null if it can't be reached. */
export async function loadRecordedUntil() {
  try {
    const response = await fetch("/api/live/live.json", {cache: "no-store", signal: AbortSignal.timeout(30_000)});
    if (!response.ok) return null;
    const last = (await response.json()).strips?.at(-1);
    return last ? new Date(Date.parse(last.start) + last.seconds * 1e3) : null;
  } catch {
    return null;
  }
}

/**
 * Per-species confidence thresholds learned from reviews on the Pi (live/thresholds.json; shape in
 * pipeline/thresholds.py), or null if it can't be reached: then every species uses the shared one.
 */
export async function loadThresholds({required = false} = {}) {
  try {
    const response = await fetch("/api/live/thresholds.json", {cache: "no-store", signal: AbortSignal.timeout(30_000)});
    if (!response.ok) throw new Error("Thresholds unavailable");
    return await response.json();
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

/** A species' threshold for its card, from loadThresholds()'s `species`: learned, blocked, or the shared `fallback`. */
export function thresholdText(scientific, fallback, thresholds) {
  const entry = thresholds?.[scientific];
  const reviews = entry && `${entry.confirmed} confirmed, ${entry.rejected} rejected`;
  return !entry ? `${Math.round(fallback * 100)}% (default)`
    : entry.blocked ? `Blocked: confirmed only (${reviews})`
    : `${Math.round(entry.threshold * 100)}% (learned: ${reviews})`;
}

/**
 * Detections, oldest first. A listener's verdict is in `review` ("confirmed", "rejected" or null);
 * rejected ones are left out unless includeRejected (the Detections table shows them, to undo),
 * so every chart and count drops them.
 */
export async function loadDetections({includeRejected = false, fallback = true} = {}) {
  const table = await detectionsTable({fallback});
  // Read columns directly: Arrow's row iterator creates a proxy for every detection.
  const time = table.getChild("time");
  const date = table.getChild("date");
  const hour = table.getChild("hour");
  const species = table.getChild("species");
  const scientific = table.getChild("scientific");
  const confidence = table.getChild("confidence");
  const clip = table.getChild("clip");
  const review = table.schema.fields.some((f) => f.name === "review") ? table.getChild("review") : null;
  const rows = [];
  for (let i = 0; i < table.numRows; ++i) {
    const verdict = review?.get(i) ?? null;
    if (verdict === "rejected" && !includeRejected) continue;
    rows.push({
      time: new Date(Number(time.get(i))),
      date: date.get(i), // Pacific-time calendar date, "YYYY-MM-DD"
      hour: hour.get(i), // Pacific-time hour, 0-23
      species: species.get(i),
      scientific: scientific.get(i),
      confidence: confidence.get(i),
      clip: clip.get(i),
      review: verdict
    });
  }
  return rows;
}

/** A detection's key for reviews: its UTC second ("2026-10-26T14:35:39Z") and scientific name. */
export const reviewAt = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Send a listener's verdict on detections ("confirmed", "rejected", or null to clear it), each
 * {at, scientific}. The Pi applies it at its next review check; the reviewing page shows it at once. Resolves to
 * whether the server took it.
 */
export async function postReview(verdict, detections) {
  try {
    for (let i = 0; i < detections.length; i += 500) {
      const r = await fetch("/api/reviews", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({verdict, detections: detections.slice(i, i + 500)})});
      if (!r.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Crop a photo around its bird (focal point from pipeline/photo_focus.py) when it's cropped to fit. */
export const focusStyle = (photo) => (photo?.focus ? `object-position: ${photo.focus.x * 100}% ${photo.focus.y * 100}%` : "");

/** Where clips (and their spectrograms, same name with .webp) are served; the analyzer uploads them there. */
export const CLIP_BASE = "/api/clips/";

let playing = null; // the one clip playing anywhere on the page: {audio, button}

/** A clip's spectrogram; tap to play it, with a line sweeping across as it plays. */
export function clipPlayer(path) {
  if (!path) return "–";
  const url = CLIP_BASE + path;
  const spec = url.replace(/\.[^./]+$/, ".webp");
  const button = htl.html`<button type="button" class="clip-player" aria-label="Play clip" style=${`--spec: url("${spec}")`}>
    <span class="clip-spec"></span><span class="clip-head"></span>
  </button>`;
  button.onclick = () => {
    if (playing?.button === button) return stop();
    stop();
    const audio = new Audio(url);
    playing = {audio, button};
    button.classList.add("is-playing");
    button.setAttribute("aria-label", "Stop clip");
    const tick = () => {
      if (playing?.audio !== audio) return;
      if (audio.duration) button.style.setProperty("--progress", audio.currentTime / audio.duration);
      requestAnimationFrame(tick);
    };
    audio.onended = audio.onerror = stop;
    audio.play().then(tick, stop);
  };
  return button;
}

function stop() {
  if (!playing) return;
  const {audio, button} = playing;
  playing = null;
  audio.pause();
  button.classList.remove("is-playing");
  button.style.removeProperty("--progress");
  button.setAttribute("aria-label", "Play clip");
}

export function loadPhotos() {
  return FileAttachment("../data/species-images.json").json();
}

export const RANGES = new Map([
  ["30 days", 30],
  ["90 days", 90],
  ["Year", 365],
  ["All time", Infinity]
]);

export function addDays(date, n) {
  return d3.utcDay.offset(new Date(date), n).toISOString().slice(0, 10);
}

/** Every calendar date from start to end inclusive, as "YYYY-MM-DD" strings. */
export function dateSpan(start, end) {
  return d3.utcDay.range(new Date(start), d3.utcDay.offset(new Date(end), 1)).map((d) => d.toISOString().slice(0, 10));
}

// With thresholds.json, it applies to species without a learned threshold (too few reviews).
export function confidenceInput(value = 0.6) {
  const input = Inputs.range([0.25, 1], {label: "Min confidence", step: 0.05, value});
  input.title = "For species without a learned threshold";
  return input;
}

export function rangeInput(value = "30 days") {
  return Inputs.radio(RANGES.keys(), {label: "Show last", value});
}

// Olive sequential ramps for counts ("Cedar & Olive"). Built in OKLCH with evenly
// spaced lightness (OKLab L steps of ~0.095 light / ~0.108 dark), so equal steps in
// value read as equal steps in color. Light runs pale -> dark; dark runs dark -> pale,
// so zero always recedes toward the card.
const RAMP_LIGHT = ["#eaf5c8", "#c9d98e", "#aabc5b", "#8d9e36", "#728024", "#586226", "#40452d"];
const RAMP_DARK = ["#262d05", "#414a02", "#5d6a00", "#7b8b1e", "#9cac54", "#bfcd8e", "#e5ecce"];
export const MUTED = "#857866"; // 4:1 on both the light and the dark card

const rampInterpolator = (dark) => d3.piecewise(d3.interpolateLab, dark ? RAMP_DARK : RAMP_LIGHT);

export function seriesColor(dark) {
  return dark ? "#829c35" : "#6f8a2a";
}

/** Sequential scale for counts: zero recedes toward the surface, more is more ink. */
export function sequential(dark, options = {}) {
  return {type: "linear", interpolate: rampInterpolator(dark), ...options};
}

/** Room for species names on the left of a chart; less on phones. */
export function nameMargin(width) {
  return width < 480 ? 126 : 170;
}

/** Species-name axis that truncates long names on narrow charts. */
/**
 * Plot render transform for tips written as sentences ("**43%** of days heard"): text between
 * ** in a tip's title is drawn bold. Plot itself only bolds channel names, which reads as a
 * form ("week Week of Nov 30"). Use as Plot.tip(data, Plot.pointer({title, render: boldMarkup})).
 */
export function boldMarkup(index, scales, values, dimensions, context, next) {
  const g = next(index, scales, values, dimensions, context);
  for (const line of g.querySelectorAll("tspan")) {
    if (line.childElementCount || !line.textContent.includes("**")) continue;
    const parts = line.textContent.split("**");
    line.textContent = "";
    parts.forEach((part, i) => {
      if (!part) return;
      const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      if (i % 2) span.setAttribute("font-weight", "bold");
      span.textContent = part;
      line.append(span);
    });
  }
  return g;
}

/**
 * Takes a chart's links out of the Tab order. Plot wraps every linked mark in its own <a>, so
 * a heatmap would otherwise make keyboard users tab through hundreds of cells. Mouse and touch
 * still follow the links.
 */
export function untabbable(plot) {
  for (const a of plot.querySelectorAll("a")) a.setAttribute("tabindex", "-1");
  return plot;
}

/** On phones, names longer than this many characters wrap onto a second line instead of being cut. */
const WRAP_CHARS = 18;
export const nameWraps = (width, name) => width < 480 && name.length > WRAP_CHARS;

export function nameAxis(width, options = {}, ticks) {
  // Phones wrap long names (at word breaks) onto two lines; wider screens have room for them.
  const axisOptions = width < 480
    ? {tickSize: 0, label: null, lineWidth: 10, lineHeight: 1.05, textOverflow: null, ...options}
    : {tickSize: 0, label: null, textOverflow: "ellipsis", lineWidth: 16, ...options};
  return ticks ? Plot.axisY(ticks, axisOptions) : Plot.axisY(axisOptions);
}

export function hourTicks(width) {
  return width < 480 ? [0, 6, 12, 18] : width < 720 ? d3.range(0, 24, 3) : d3.range(24);
}

export function formatHour(h) {
  return h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
}

export function formatDate(date, options = {month: "short", day: "numeric"}) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", options);
}

/** "Sep 1 – 30", "Sep 23 – Oct 22", or "Oct 23, 2025 – Oct 22, 2026" across years. */
export function dateRange(a, b) {
  if (a === b) return formatDate(a);
  if (a.slice(0, 4) !== b.slice(0, 4)) {
    const withYear = {month: "short", day: "numeric", year: "numeric"};
    return `${formatDate(a, withYear)} – ${formatDate(b, withYear)}`;
  }
  return a.slice(0, 7) === b.slice(0, 7) ? `${formatDate(a)} – ${Number(b.slice(8, 10))}` : `${formatDate(a)} – ${formatDate(b)}`;
}

export function speciesHref(name) {
  return `./species?name=${encodeURIComponent(name)}`;
}

/** Cornell's All About Birds guide page for a species. */
export function guideHref(name) {
  return `https://www.allaboutbirds.org/guide/${name.replace(/'/g, "").replace(/ /g, "_")}`;
}

const TZ = "America/Los_Angeles";
const localDate = (t) => t.toLocaleDateString("en-CA", {timeZone: TZ}); // YYYY-MM-DD
const clock = (t) => t.toLocaleTimeString("en-US", {timeZone: TZ, hour: "numeric", minute: "2-digit"});

function dayLabel(t) {
  const today = localDate(new Date());
  const yesterday = localDate(new Date(Date.now() - 864e5));
  const day = localDate(t);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return t.toLocaleDateString("en-US", {timeZone: TZ, month: "short", day: "numeric"});
}

/**
 * Most recently heard species, newest first. For each, up to `times` recent
 * sightings, counting detections less than `gapMinutes` apart as one bout.
 */
/**
 * One row per species per clock minute it was heard in: its most confident detection
 * that minute. BirdNET scores every 3-second segment, so a bird calling for 20 minutes
 * leaves hundreds of detections; counting minutes heard instead keeps one persistent
 * caller from outweighing everything else.
 */
export function minutesHeard(rows) {
  const best = new Map();
  for (const d of rows) {
    const key = `${d.species}|${Math.floor(+d.time / 6e4)}`;
    const prev = best.get(key);
    if (!prev || d.confidence > prev.confidence) best.set(key, d);
  }
  return [...best.values()];
}

/** Clock minutes with at least one bird heard (any species), as minute numbers. */
export function birdsongMinutes(rows) {
  return new Set(rows.map((d) => Math.floor(+d.time / 6e4)));
}

export function recentSpecies(rows, {limit = 12, times = 3, gapMinutes = 10} = {}) {
  const bySpecies = new Map();
  for (let i = rows.length - 1; i >= 0; --i) {
    const d = rows[i];
    let entry = bySpecies.get(d.species);
    if (!entry) {
      if (bySpecies.size >= limit) continue;
      bySpecies.set(d.species, (entry = {species: d.species, scientific: d.scientific, times: []}));
    }
    const last = entry.times.at(-1);
    if (entry.times.length < times && (!last || last - d.time >= gapMinutes * 6e4)) entry.times.push(d.time);
  }
  return [...bySpecies.values()];
}

export function birdCard({species, times}, photo) {
  const [latest, ...earlier] = times;
  return htl.html`<div class="bird-card">
    ${birdPhoto(species, photo, speciesHref(species))}
    <a class="bird-name" href=${speciesHref(species)}>${wrapName(species)}</a>
    <div class="bird-when">${dayLabel(latest)}, ${clock(latest)}</div>
    ${earlier.length ? htl.html`<div class="bird-times">also ${earlier.map(clock).join(" · ")}</div>` : ""}
  </div>`;
}

/** A species name that wraps only between words, never at a hyphen ("Golden-crowned" stays whole). */
function wrapName(species) {
  return species.split(" ").flatMap((word, i) => [i ? " " : "", word.includes("-") ? htl.html`<span class="nowrap">${word}</span>` : word]);
}

/** A species photo with its credit tucked into an ⓘ badge (hover, or tap/focus on touch screens). */
export function birdPhoto(species, photo, href) {
  const status = photo ? htl.html`<span class="photo-loading" role="status" aria-label="Loading photo">
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="8.5" r="1.5"/></svg>
  </span>` : null;
  const settle = (loaded) => {
    if (loaded) {
      img.classList.add("is-loaded");
      status.remove();
    } else {
      status.classList.add("is-error");
      status.setAttribute("aria-label", "Photo unavailable");
    }
  };
  const img = photo
    ? htl.html`<img src=${photo.image} style=${focusStyle(photo)} alt=${`Photo of a ${species}`} title=${`Photo: ${photo.artist}, ${photo.license}`} loading="lazy" width=${photo.width} height=${photo.height} onload=${() => settle(true)} onerror=${() => settle(false)}>`
    : htl.html`<span class="bird-photo-missing">No photo</span>`;
  const wrap = htl.html`<div class="photo-wrap">
    ${href ? htl.html`<a class="bird-photo" href=${href}>${img}${status}</a>` : htl.html`<div class="bird-photo">${img}${status}</div>`}
    ${photo ? photoCredit(photo) : ""}
  </div>`;
  if (photo && img.complete) settle(img.naturalWidth > 0);
  return wrap;
}

function photoCredit(photo) {
  return htl.html`<span class="credit" tabindex="0" aria-label=${`Photo credit: ${photo.artist}, ${photo.license}`}>
    <span class="credit-badge" aria-hidden="true">i</span>
    <span class="credit-pop">
      Photo: <a href=${photo.file_page} target="_blank" rel="noopener">${photo.artist}</a>,
      ${photo.license_url ? htl.html`<a href=${photo.license_url} target="_blank" rel="noopener">${photo.license}</a>` : photo.license}
    </span>
  </span>`;
}

export function loadCategories() {
  return FileAttachment("../data/species-categories.json").json();
}

export function loadSun() {
  return FileAttachment("../data/sun.json").json();
}

const clockShort = (t) =>
  t.toLocaleTimeString("en-US", {timeZone: TZ, hour: "numeric", minute: "2-digit"}).replace(":00", "").replace(" AM", "a").replace(" PM", "p");

/** Calendar picker for a day with data, from the first to the latest recorded date. */
export function dayInput(dates) {
  return Inputs.date({label: "Date", value: dates.at(-1), min: dates[0], max: dates.at(-1)});
}

/** Inputs.date gives a UTC-midnight Date; turn it back into our "YYYY-MM-DD" key. */
export function dateKey(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date;
}

// Flat 11px icons for the sunrise/sunset markers, drawn centered on (0, 0).
const SUN_ICON = "M0-2.6a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2Z";
const SUN_RAYS = "M0-5.5v1.4M0 4.1v1.4M-5.5 0h1.4M4.1 0h1.4M-3.9-3.9l1 1M2.9 2.9l1 1M-3.9 3.9l1-1M2.9-2.9l1-1";
const MOON_ICON = "M1.6-4.6A4.8 4.8 0 1 0 4.4 2.4A3.8 3.8 0 0 1 1.6-4.6Z";

/** Light-blue sunrise/sunset bands: each a rect filled with a horizontal gradient whose opacity
 * follows its stops ([time ms, 0..1] pairs). */
function sunBandMark(bands, top, bottom, color, opacity) {
  return (index, {x, y}) => {
    const g = htl.svg`<g aria-hidden="true" pointer-events="none">`;
    for (const {range, stops} of bands) {
      const [x0, x1] = [x(range[0]), x(range[1])];
      if (!(x1 > x0)) continue;
      const id = `sunband-${Math.random().toString(36).slice(2)}`;
      const grad = htl.svg`<linearGradient id=${id} gradientUnits="userSpaceOnUse" x1=${x0} x2=${x1} y1="0" y2="0">`;
      for (const [t, v] of stops) grad.append(htl.svg`<stop offset=${(x(new Date(t)) - x0) / (x1 - x0)} stop-color=${color} stop-opacity=${opacity * v}></stop>`);
      g.append(htl.svg`<defs>${grad}</defs>`, htl.svg`<rect x=${x0} width=${x1 - x0} y=${Math.min(y(top), y(bottom))} height=${Math.abs(y(bottom) - y(top))} fill=${`url(#${id})`}></rect>`);
    }
    return g;
  };
}

/** Hatched rects ([x1, x2] times) over rows top..bottom: stretches the recorder sent no audio. */
function hatchMark(spans, top, bottom) {
  return (index, {x, y}) => {
    const id = `hatch-${Math.random().toString(36).slice(2)}`;
    const g = htl.svg`<g aria-hidden="true"><defs><pattern id=${id} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(-45)">
      <line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.2"></line></pattern></defs>`;
    for (const [a, b] of spans) {
      const [x0, x1] = [x(a), x(b)];
      if (x1 > x0) g.append(htl.svg`<rect x=${x0} width=${x1 - x0} y=${Math.min(y(top), y(bottom))} height=${Math.abs(y(bottom) - y(top))} fill=${`url(#${id})`}><title>${`No audio ${clock(a)}–${clock(b)}`}</title></rect>`);
    }
    return g;
  };
}

/**
 * Sun and moon labels sit just above the timeline's top horizontal rule. Each of sunrise and
 * sunset is [earliest, latest] over the days shown (the same time twice for one day); a range
 * is labelled "6:58a–7:40a".
 */
// The sunrise or sunset label's text, and the span it takes to the right of its line.
const sunText = ([t, last]) => (+last - +t >= 6e4 ? `${clockShort(t)}–${clockShort(last)}` : clockShort(t));
let measureCtx;
function textWidth(text, size = 10) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
}
const sunSpan = (px, range) => [px + 3, px + 22 + textWidth(sunText(range))];

// Where the label on today's "last updated" line goes: beside the line, left if it fits, else
// right; or, where the sunrise or sunset label or the chart's edge is in the way, on a line
// above them (`raised`), on whichever side fits.
function lastUpdatedPlace(x, t, text, suns, width) {
  const px = x(t), w = textWidth(text);
  const taken = suns.map((r) => sunSpan(x(r[0]), r));
  const fits = ([a, b]) => a >= 0 && b <= width;
  const clear = (span) => fits(span) && taken.every(([s0, s1]) => span[1] + 3 < s0 || span[0] - 3 > s1);
  if (clear([px - 4 - w, px - 4])) return {left: true, raised: false};
  if (clear([px + 4, px + 4 + w])) return {left: false, raised: false};
  return {left: !fits([px + 4, px + 4 + w]), raised: true};
}

function sunMarkers(sunrise, sunset, top) {
  return (index, {x, y}, values, {marginLeft, width, marginRight}) => {
    const g = htl.svg`<g fill="currentColor" font-size="10" aria-label="sunrise and sunset">`;
    for (const [[t, last], kind] of [[sunrise, "Sunrise"], [sunset, "Sunset"]]) {
      const px = x(t);
      const range = +last - +t >= 6e4;
      if (px < marginLeft || px > width - marginRight) continue;
      const icon = kind === "Sunrise"
        ? htl.svg`<path d=${SUN_ICON}></path><path d=${SUN_RAYS} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>`
        : htl.svg`<path d=${MOON_ICON}></path>`;
      g.append(htl.svg`<g transform=${`translate(${px + 10},${y(top) - 6})`} fill-opacity="0.75">
        <title>${range ? `${kind} ${clock(t)} to ${clock(last)}` : `${kind} ${clock(t)}`}</title>
        <g transform="translate(0,-3.5)">${icon}</g>
        <text x="12" y="0" text-anchor="start">${sunText([t, last])}</text>
      </g>`);
    }
    return g;
  };
}

export const SPANS = new Map([["1 day", 1], ["3 days", 3], ["7 days", 7], ["30 days", 30], ["90 days", 90], ["All time", Infinity]]);

/** First date of a window of `days` ending on `end`; Infinity means from the first date with data. */
/** First day of a window of `days` ending on `end`, never before the data starts. */
export function windowStart(end, days, firstDate) {
  if (days === Infinity) return firstDate;
  const start = addDays(end, -(days - 1));
  return start < firstDate ? firstDate : start;
}

export const SORTS = new Map([["Category", "category"], ["Most heard", "count"], ["First heard", "first"]]);

export function sortInput(value = "Category") {
  return Inputs.radio(SORTS.keys(), {label: "Sort", value});
}

export function spanInput(value = "1 day") {
  return Inputs.radio(SPANS.keys(), {label: "Span", value});
}

export const HEADER = "\u00a7"; // prefix marking a category header row
const UNIDENTIFIED = "Unidentified bird"; // the day timeline's row for birdsong BirdNET couldn't name
const HEADER_ROWS = 1.4; // a category header is this many species rows tall...
const GROUP_GAP = 0.2; // ...plus this much extra space above every group but the first
const ROW_PX = 17;
const DENSITY_FROM = 30; // spans this long are drawn as density strips, not ticks
const BIN_MINUTES = 15;
// Detections of a species less than this far apart are drawn as one bout (a bar from first
// to last call). A guess from simulated data; see README "Tuning with real data".
const BOUT_GAP_MINUTES = 2;
const SEGMENT_MS = 3000; // BirdNET scores 3-second segments
const NO_AUDIO_MINUTES = 5; // shorter breaks between recordings aren't marked
// Over several days sunrise and sunset move; once they move this much they're drawn as a band
// (earliest to latest) instead of a line.
const SUN_BAND_MS = 10 * 6e4;

/**
 * Detections by time of day: one row per species, grouped under rough
 * categories (songbirds, woodpeckers, ...) and ordered within each group by
 * when the species usually starts singing.
 *
 * Up to a week, each detection is a tick, like a ticker tape; several days are
 * overlaid on one 24-hour clock with fainter ticks. From 30 days, ticks would
 * smear together, so rows become density strips: detections per day in each
 * 15-minute slot, and species heard on fewer than 10% of days are left out.
 *
 * rows: detections from the days in `dates` (Pacific "YYYY-MM-DD", last = reference day).
 * spanDays: calendar days in the span (dates holds only days with recordings).
 * sun: per-date {start, end, sunrise, sunset} from sun.json.
 * categories: {order: [category...], species: {commonName: category}}.
 */
export function dayTimeline(rows, sun, dates, {
  spanDays = dates.length, categories, sort = "category", width, dark, daylightOnly = true,
  maxRows = Infinity, // with a sort other than category, a collapsed list shows this many rows
  rowPx = ROW_PX, // height of one species row; a full-screen display passes more
  recordedUntil = null, // end of the newest recorded audio; on that day alone, marked with a line
  unidentified = [], // minutes ({time, date}) with birdsong BirdNET couldn't name: a muted last row, never counted
  audio = null, // the recorder's audio as [start ms, end ms] spans; for one day, stretches without it are hatched
  overrides = new Map(), // the viewer's choices: category (or "*" for the whole list) -> collapsed?
  onToggle = () => {} // ([[key, collapsed], ...]) when a category header or the expand button is clicked
} = {}) {
  // Days missing from the sun table (e.g. a stale cached sun.json) can't be placed on the clock; skip them.
  if (dates.some((date) => !sun[date])) {
    const known = new Set((dates = dates.filter((date) => sun[date])));
    rows = rows.filter((d) => known.has(d.date));
    if (!dates.length) return htl.html`<p class="sub">No sunrise and sunset times for these days yet.</p>`;
  }
  const n = dates.length;
  const density = spanDays >= DENSITY_FROM;
  const ref = sun[dates.at(-1)];
  const refStart = new Date(ref.start);
  // Days are overlaid by wall-clock time. On the two DST days a year the day is 23 or 25 hours
  // long and the clocks change at 2am, so elapsed time since midnight is off by an hour after that.
  const dstShift = (date) => +new Date(sun[date].end) - +new Date(sun[date].start) - 864e5; // 0, +1h or -1h
  const refShift = dstShift(dates.at(-1));
  const offset = (date, t) => { // wall-clock ms since local midnight
    const elapsed = +t - +new Date(sun[date].start), shift = dstShift(date);
    return shift && elapsed >= 2 * 36e5 ? elapsed - shift : elapsed;
  };
  const refAt = (wall) => new Date(+refStart + (refShift && wall >= 2 * 36e5 ? wall + refShift : wall));
  const onRef = (date, t) => refAt(offset(date, t));

  // Earliest and latest sunrise and sunset over the days shown, on the reference day's clock.
  const sunRange = (key) => d3.extent(dates, (date) => +onRef(date, new Date(sun[date][key]))).map((t) => new Date(t));
  const sunriseRange = sunRange("sunrise");
  const sunsetRange = sunRange("sunset");
  // Both become bands once either moves enough, so sunrise and sunset are drawn the same way.
  const banded = [sunriseRange, sunsetRange].some(([a, b]) => +b - +a >= SUN_BAND_MS);
  const isBand = () => banded;
  // Over many days, each band shades how often sunrise (or sunset) falls at that time: a
  // histogram of the days' times, lightly smoothed (Gaussian, 8 minutes), as a gradient.
  const sunBands = [];
  for (const [key, range] of [["sunrise", sunriseRange], ["sunset", sunsetRange]]) {
    if (!isBand(range)) continue;
    const times = dates.map((date) => +onRef(date, new Date(sun[date][key])));
    const bw = 8 * 6e4;
    const ts = d3.range(+range[0] - bw, +range[1] + bw + 1, 2 * 6e4);
    const dens = ts.map((t) => d3.sum(times, (x) => Math.exp(-0.5 * ((t - x) / bw) ** 2)));
    const max = d3.max(dens);
    sunBands.push({range: [new Date(ts[0]), new Date(ts.at(-1))], stops: ts.map((t, i) => [t, dens[i] / max])});
  }
  const dayStart = refStart;
  const dayEnd = new Date(ref.end);
  const earliestSunrise = d3.min(dates, (date) => offset(date, new Date(sun[date].sunrise)));
  const latestSunset = d3.max(dates, (date) => offset(date, new Date(sun[date].sunset)));
  const domain = daylightOnly
    ? [refAt(earliestSunrise - 90 * 6e4), refAt(latestSunset + 90 * 6e4)]
    : [dayStart, dayEnd];

  let shown = rows
    .map((d) => ({...d, clock: onRef(d.date, d.time)}))
    .filter((d) => d.clock >= domain[0] && d.clock <= domain[1]);
  if (density) {
    const daysHeard = d3.rollup(shown, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species);
    shown = shown.filter((d) => daysHeard.get(d.species) >= 0.1 * n);
  }

  // Typical (median) first detection of the day, and how often each species was heard.
  const firstHeard = d3.rollup(shown, (v) => d3.median(d3.rollups(v, (w) => d3.min(w, (d) => +d.clock), (d) => d.date), ([, t]) => t), (d) => d.species);
  const timesHeard = d3.rollup(shown, (v) => v.length, (d) => d.species);
  const byFirst = (a, b) => d3.ascending(firstHeard.get(a), firstHeard.get(b));
  const byCount = (a, b) => d3.descending(timesHeard.get(a), timesHeard.get(b)) || byFirst(a, b);
  const categoryOf = (s) => categories?.species[s] ?? "Other";
  // Spans longer than a week start collapsed; a day or a week starts expanded. The viewer's own
  // choices (overrides) win, and are kept as they move between periods.
  const auto = spanDays > 7;
  const collapsedOf = (key) => (overrides.has(key) ? overrides.get(key) : auto);
  let order;
  let rowKeyOf = (species) => species; // which row a species' detections are drawn on
  let groups = [];
  let hiddenCount = 0;
  if (sort === "category") {
    // Grouped under category headers; within a group, by when the species usually starts singing.
    // A collapsed category is a single row (its header) holding all of its species' detections.
    groups = d3.groups([...firstHeard.keys()], categoryOf)
      .sort(([a], [b]) => (categories?.order.indexOf(a) ?? 0) - (categories?.order.indexOf(b) ?? 0));
    order = groups.flatMap(([group, species]) => (collapsedOf(group) ? [HEADER + group] : [HEADER + group, ...species.sort(byFirst)]));
    rowKeyOf = (species) => (collapsedOf(categoryOf(species)) ? HEADER + categoryOf(species) : species);
  } else {
    order = [...firstHeard.keys()].sort(sort === "count" ? byCount : byFirst);
    if (collapsedOf("*") && order.length > maxRows) {
      hiddenCount = order.length - maxRows;
      order = order.slice(0, maxRows);
      const kept = new Set(order);
      shown = shown.filter((d) => kept.has(d.species));
    }
  }
  // Unidentified birdsong: one muted row after everything else, on tick views only (it's large;
  // the 30-day density view leaves it out). Not a species: no card, no counts, no sorting.
  const unidentifiedShown = density ? [] : unidentified.map((u) => ({...u, clock: onRef(u.date, u.time)}))
    .filter((u) => u.clock >= domain[0] && u.clock <= domain[1]);
  if (unidentifiedShown.length && order.length) order.push(UNIDENTIFIED);
  const headers = order.filter((k) => k.startsWith(HEADER));
  const groupSize = new Map(groups.map(([g, sp]) => [g, sp.length]));

  // Lay rows out by hand (in units of one species row) so headers get room above and below.
  const rowsAt = new Map(); // key -> {y1, y2, y}
  let pos = 0;
  for (const key of order) {
    const header = key.startsWith(HEADER);
    if ((header || key === UNIDENTIFIED) && pos > 0) pos += GROUP_GAP;
    const h = (header || key === UNIDENTIFIED) ? HEADER_ROWS : nameWraps(width, rowKeyOf(key) === key ? key : "") ? 1.7 : 1; // room for a wrapped name
    rowsAt.set(key, {y1: pos, y2: pos + h, y: pos + h / 2});
    pos += h;
  }
  const total = pos;
  const rowOf = (species) => rowsAt.get(rowKeyOf(species));
  const speciesTicks = order.filter((k) => !k.startsWith(HEADER) && k !== UNIDENTIFIED).map((k) => rowsAt.get(k).y);
  const nameAt = new Map(order.map((k) => [rowsAt.get(k).y, k]));

  if (!firstHeard.size) return htl.html`<p class="sub">No detections ${daylightOnly ? "in daylight " : ""}${n === 1 ? "on this day" : "in these days"}.</p>`;

  const fade = n === 1 ? 1 : n <= 3 ? 0.6 : 0.4; // overlapping days stack up
  const hourStep = width < 480 ? 4 : width < 800 ? 2 : 1;

  let dataMarks;
  let color;
  if (density) {
    // Minutes heard per day in each 15-minute slot of the reference day's clock (a species heard
    // in a minute counts once, however many 3-second detections it had).
    const bin = d3.timeMinute.every(BIN_MINUTES);
    const bins = d3.flatRollup(shown, (v) => new Set(v.map((d) => `${d.species}|${Math.floor(+d.time / 6e4)}`)).size / n, (d) => rowKeyOf(d.species), (d) => +bin.floor(d.clock))
      .map(([key, t, rate]) => ({key, name: key.startsWith(HEADER) ? key.slice(1) : key, t1: new Date(t), t2: new Date(t + BIN_MINUTES * 6e4), rate}));
    // The color bar starts where the plot does; on phones it spans it exactly.
    color = sequential(dark, {legend: true, label: "Minutes heard per day", zero: true, marginLeft: nameMargin(width),
      ...(width < 520 ? {width, marginRight: 30, ticks: 3} : {width: nameMargin(width) + 260, marginRight: 20})});
    dataMarks = [
      // A 15-minute bin can start before the chart's first minute; clip it to the plot area.
      Plot.rect(bins, {x1: "t1", x2: "t2", y1: (d) => rowsAt.get(d.key).y1 + 0.12, y2: (d) => rowsAt.get(d.key).y2 - 0.12, fill: "rate", clip: true}),
      Plot.tip(bins, Plot.pointer({
        x: (d) => new Date((+d.t1 + +d.t2) / 2), y: (d) => rowsAt.get(d.key).y,
        channels: {Species: "name", Time: (d) => `${clock(d.t1)}–${clock(d.t2)}`, "Minutes heard per day": (d) => d3.format(".2~f")(d.rate)},
        format: {x: false, y: false, fill: false, Species: true, Time: true, "Minutes heard per day": true}
      }))
    ];
  } else {
    // Bouts: a species' detections on one day, merged while the gaps stay under BOUT_GAP_MINUTES.
    const bouts = [];
    for (const v of d3.groups(shown, (d) => d.species, (d) => d.date).flatMap(([, byDate]) => byDate.map(([, w]) => w))) {
      v.sort((a, b) => a.clock - b.clock);
      let bout = null;
      for (const d of v) {
        if (bout && d.clock - bout.last <= BOUT_GAP_MINUTES * 6e4) {
          bout.last = d.clock; bout.lastTime = d.time; bout.n++;
          if (d.confidence > bout.confidence) bout.confidence = d.confidence;
        } else {
          bouts.push((bout = {species: d.species, date: d.date, first: d.clock, last: d.clock, firstTime: d.time, lastTime: d.time, n: 1, confidence: d.confidence}));
        }
      }
    }
    // Keep single calls visible: at least ~2px wide.
    const minMs = ((+domain[1] - +domain[0]) / Math.max(1, width - nameMargin(width) - 16)) * 2;
    for (const b of bouts) b.end = new Date(Math.max(+b.last + SEGMENT_MS, +b.first + minMs));
    const minutesLong = (b) => Math.round((+b.last + SEGMENT_MS - +b.first) / 6e4);
    const boutTip = {
      Species: (b) => (rowKeyOf(b.species).startsWith(HEADER) ? `${categoryOf(b.species)}: ${b.species}` : b.species),
      Time: (b) => (b.n === 1 ? clock(b.firstTime) : `${clock(b.firstTime)}–${clock(b.lastTime)}`),
      Length: (b) => (b.n === 1 ? "single call" : `${minutesLong(b) || "<1"} min, ${b.n} detections`),
      "Top confidence": (b) => d3.format(".0%")(b.confidence)
    };
    if (n > 1) boutTip.Day = (b) => formatDate(b.date, {weekday: "short", month: "short", day: "numeric"});
    // Unidentified minutes, merged while they run on, in the muted color.
    const unidBouts = [];
    for (const u of unidentifiedShown.sort((a, b) => a.clock - b.clock)) {
      const last = unidBouts.at(-1);
      if (last && last.date === u.date && u.clock - last.end <= 6e4) { last.end = new Date(+u.clock + 6e4); last.minutes++; }
      else unidBouts.push({date: u.date, first: u.clock, end: new Date(+u.clock + 6e4), firstTime: u.time, minutes: 1});
    }
    const unidRow = rowsAt.get(UNIDENTIFIED);
    const unidMarks = unidRow ? [
      Plot.rect(unidBouts, {x1: "first", x2: "end", y1: unidRow.y1 + 0.2, y2: unidRow.y2 - 0.2, fill: MUTED, fillOpacity: fade * 0.8, rx: 1.5}),
      Plot.tip(unidBouts, Plot.pointer({x: (b) => new Date((+b.first + +b.end) / 2), y: unidRow.y,
        channels: {"": () => "Unidentified", Time: (b) => `${clock(b.firstTime)}${b.minutes > 1 ? `–${clock(new Date(+b.firstTime + b.minutes * 6e4))}` : ""}`, Length: (b) => `${b.minutes} min`,
          ...(n > 1 ? {Day: (b) => formatDate(b.date, {weekday: "short", month: "short", day: "numeric"})} : {})},
        format: {x: false, y: false}}))
    ] : [];
    dataMarks = [
      ...unidMarks,
      Plot.rect(bouts, {x1: "first", x2: "end", y1: (b) => rowOf(b.species).y1 + 0.2, y2: (b) => rowOf(b.species).y2 - 0.2, fill: seriesColor(dark), fillOpacity: fade, rx: 1.5}),
      Plot.tip(bouts, Plot.pointer({
        x: (b) => new Date((+b.first + +b.end) / 2),
        y: (b) => rowOf(b.species).y,
        channels: boutTip,
        format: {x: false, y: false, ...Object.fromEntries(Object.keys(boutTip).map((k) => [k, true]))}
      }))
    ];
  }

  const headerLabel = (key) => key === UNIDENTIFIED ? UNIDENTIFIED.toUpperCase()
    : categoryLabel(key.slice(1), collapsedOf(key.slice(1)), groupSize.get(key.slice(1)));
  const headingRows = rowsAt.has(UNIDENTIFIED) ? [...headers, UNIDENTIFIED] : headers;

  // Expanded headers have a horizontal rule; collapsed headers contain bars,
  // so their annotations and vertical rules start above the whole first row.
  const firstHeader = headers[0];
  const gridTop = firstHeader && !collapsedOf(firstHeader.slice(1))
    ? rowsAt.get(firstHeader).y
    : 0;
  const gridHours = d3.timeHour.every(hourStep).range(domain[0], new Date(+domain[1] + 1));
  // Today: a line where the recording so far ends, and the rest of the day faintly shaded, so
  // time not recorded yet doesn't read as time without birds.
  const pacificDate = (t) => t.toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
  const recordedAt = recordedUntil && n === 1 && pacificDate(recordedUntil) === dates[0] ? onRef(dates[0], recordedUntil) : null;
  const marginLeft = nameMargin(width), marginRight = width < 520 ? 30 : 16; // room for the sunset time on phones
  const recordedShown = recordedAt && recordedAt >= domain[0] && recordedAt <= domain[1];
  const recordedText = recordedShown && `Last updated ${clock(recordedUntil)}`;
  const recordedPlace = recordedShown && lastUpdatedPlace(d3.scaleTime(domain, [marginLeft, width - marginRight]), recordedAt, recordedText,
    [sunriseRange, sunsetRange].filter((r) => !isBand(r)), width);
  // One day: stretches with no audio (up to where the recording so far ends) are hatched, so a
  // missed stretch doesn't read as time without birds, nor as time not recorded yet. Only up to
  // the newest recording in `audio`, too: the table can lag the live feed (it's uploaded every few
  // minutes, or is the site's built copy when the fresh one can't load), and after it is unknown.
  const noAudio = [];
  if (audio && n === 1) {
    const known = d3.max(audio, ([, b]) => b) ?? -Infinity;
    const dayFrom = +new Date(sun[dates[0]].start), dayTo = Math.min(+new Date(sun[dates[0]].end), recordedAt ? +recordedUntil : Infinity, known);
    const spans = audio.filter(([a, b]) => b > dayFrom && a < dayTo).sort((p, q) => p[0] - q[0]);
    if (spans.length) { // a day without any rows predates the recordings table: unknown, not missed
      let from = dayFrom;
      for (const [a, b] of [...spans, [dayTo, dayTo]]) {
        if (a - from >= NO_AUDIO_MINUTES * 6e4) noAudio.push([onRef(dates[0], new Date(from)), onRef(dates[0], new Date(Math.min(a, dayTo)))]);
        from = Math.max(from, b);
      }
    }
  }
  const recordedMarks = recordedShown ? [
    Plot.rectX([recordedAt], {x1: (t) => t, x2: () => domain[1], y1: gridTop, y2: total, fill: "currentColor", fillOpacity: 0.05}),
    Plot.ruleX([recordedAt], {y1: gridTop, y2: total, stroke: "currentColor", strokeOpacity: 0.55}),
    Plot.text([recordedAt], {x: (t) => t, y: gridTop, text: () => recordedText, textAnchor: recordedPlace.left ? "end" : "start", lineAnchor: "bottom",
      dx: recordedPlace.left ? -4 : 4, dy: recordedPlace.raised ? -19 : -4, fontSize: 10, fill: "currentColor", fillOpacity: 0.75})
  ] : [];
  const plot = Plot.plot({
    width,
    height: Math.round(total * rowPx) + 50 + (recordedPlace?.raised ? 15 : 0),
    marginLeft,
    marginRight,
    marginTop: recordedPlace?.raised ? 33 : 18,
    x: {type: "time", domain, ticks: d3.timeHour.every(hourStep), tickFormat: clockShort, label: null},
    y: {domain: [total, 0], axis: null},
    color,
    marks: [
      // Night, when the full day is shown.
      daylightOnly ? null : Plot.rectX([[dayStart, sunriseRange[0]], [sunsetRange[1], dayEnd]], {x1: "0", x2: "1", fill: "currentColor", fillOpacity: 0.06}),
      Plot.ruleX(gridHours, {y1: gridTop, y2: total, stroke: "currentColor", strokeOpacity: 0.1}),
      // For one day (or a short span), sunrise and sunset are dashed lines; longer spans get a band, drawn below.
      Plot.ruleX([sunriseRange, sunsetRange].filter((r) => !isBand(r)).map(([t]) => t), {y1: gridTop, y2: total, stroke: "currentColor", strokeOpacity: 0.35, strokeDasharray: "3,3"}),
      sunMarkers(sunriseRange, sunsetRange, gridTop),
      ...recordedMarks,
      noAudio.length ? hatchMark(noAudio.map(([a, b]) => [new Date(Math.max(a, domain[0])), new Date(Math.min(b, domain[1]))]), gridTop, total) : null,
      // Category headers: a small-caps label in place of a species name, level with a hairline across the plot.
      Plot.ruleY(headers.filter((h) => !collapsedOf(h.slice(1))), {y: (d) => rowsAt.get(d).y, stroke: "currentColor", strokeOpacity: 0.18}),
      Plot.text(headingRows, {y: (d) => rowsAt.get(d).y, text: headerLabel, frameAnchor: "left", textAnchor: "end", lineAnchor: "middle", dx: -6, lineWidth: (nameMargin(width) - 10) / 9.5, lineHeight: 1.1, fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em"}),
      nameAxis(width, {tickFormat: (y) => nameAt.get(y)}, speciesTicks),
      ...dataMarks,
      // Over many days, sunrise and sunset are light-blue bands on top of the data, as opaque as
      // the share of days it's dark at that time.
      sunBandMark(sunBands, gridTop, total, dark ? "#8cc4f0" : "#4f9ad6", dark ? 0.38 : 0.5)
    ]
  });

  wireCategoryToggles(plot, groups, collapsedOf, groupSize, onToggle);

  // One button for everything: expand/collapse all categories, or show the whole list.
  let button = null;
  if (sort === "category" && groups.length) {
    button = categoryToggleAll(groups, collapsedOf, onToggle);
  } else if (sort !== "category" && (hiddenCount || overrides.get("*") === false)) {
    button = htl.html`<button class="timeline-expand" type="button">${hiddenCount ? `Show all ${hiddenCount + order.length} species` : "Show fewer"}</button>`;
    button.onclick = () => onToggle([["*", !hiddenCount]]);
  }
  return htl.html`<div class="timeline">
    <div class="timeline-toolbar">${button}</div>
    ${plot}
  </div>`;
}

/** "▾ SONGBIRDS" when open, "▸ SONGBIRDS · 24" when collapsed (24 species inside). */
export function categoryLabel(group, collapsed, size) {
  return collapsed ? `▸ ${group.toUpperCase()} · ${size}` : `▾ ${group.toUpperCase()}`;
}

/**
 * Makes a chart's category header labels (text made by categoryLabel) toggle their category,
 * by mouse or keyboard (Tab to one, then Enter or Space). Shared by the daily timeline and the
 * year-round presence chart.
 */
export function wireCategoryToggles(plot, groups, collapsedOf, groupSize, onToggle) {
  for (const text of plot.querySelectorAll("text")) {
    if (text.closest("[aria-label='tip']")) continue;
    // Long labels wrap onto two lines (tspans), so compare without spaces.
    const match = /^[▸▾](.+?)(?:·\d+)?$/.exec(text.textContent.replace(/\s/g, ""));
    const group = match && groups.find(([g]) => g.toUpperCase().replace(/\s/g, "") === match[1])?.[0];
    if (!group) continue;
    const toggle = () => onToggle([[group, !collapsedOf(group)]]);
    text.classList.add("timeline-toggle", "category-header");
    text.setAttribute("tabindex", "0");
    text.setAttribute("role", "button");
    text.setAttribute("aria-expanded", String(!collapsedOf(group)));
    text.setAttribute("aria-label", `${group}, ${groupSize.get(group)} species`);
    text.addEventListener("click", toggle);
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }
}

/** "Expand all" / "Collapse all" for a chart grouped by category; an icon on phones. */
export function categoryToggleAll(groups, collapsedOf, onToggle) {
  const anyCollapsed = groups.some(([g]) => collapsedOf(g));
  const text = anyCollapsed ? "Expand all" : "Collapse all";
  const button = htl.html`<button class="timeline-expand" type="button" aria-label=${text} title=${text}><span class="long">${text}</span><span class="short" aria-hidden="true">${anyCollapsed ? "⊞" : "⊟"}</span></button>`;
  button.onclick = () => onToggle(groups.map(([g]) => [g, !anyCollapsed]));
  return button;
}

/** Label for a dayTicks tick: "Oct 23", "Nov 1"; adds the year to the first tick and Jan 1 when the range spans years. */
export function dayTickFormat(dates) {
  const multiYear = dates[0].slice(0, 4) !== dates.at(-1).slice(0, 4);
  return (t) => {
    const key = t.toISOString().slice(0, 10);
    const withYear = multiYear && (key === dates[0] || key.endsWith("-01-01"));
    return t.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric", ...(withYear ? {year: "numeric"} : {})});
  };
}

/**
 * Date ticks for a per-day chart: every day for short ranges; otherwise the
 * first day, the 1st of each month, and the last day. Month-start ticks whose
 * labels would collide with a neighbor are dropped (the ends always stay).
 * dates: consecutive "YYYY-MM-DD" strings; plotWidth: px available for the bars.
 */
export function dayTicks(dates, plotWidth, {charPx = 5.8, pad = 10} = {}) {
  const toDate = (d) => new Date(d);
  if (dates.length <= 14) return dates.map(toDate);
  const format = dayTickFormat(dates);
  const pxPerDay = plotWidth / dates.length;
  const half = (i) => (format(toDate(dates[i])).length * charPx) / 2;
  const fits = (i, j) => Math.abs(i - j) * pxPerDay >= half(i) + half(j) + pad;
  const last = dates.length - 1;
  const picked = [0];
  dates.forEach((d, i) => {
    if (i > 0 && i < last && d.endsWith("-01") && fits(i, picked.at(-1)) && fits(i, last)) picked.push(i);
  });
  picked.push(last);
  return picked.map((i) => toDate(dates[i]));
}

/**
 * Weather: the copy built into the site (pipeline/weather.py, from Open-Meteo), with the last
 * month fetched fresh from Open-Meteo's forecast API when a page opens, so recent days don't
 * wait for a rebuild. Like the build, it stops at yesterday: today's numbers are still mostly
 * forecast.
 */
let recentWeather = null;
function fetchRecentWeather() {
  recentWeather ??= (async () => {
    const params = new URLSearchParams({
      latitude: 47.61, longitude: -122.33, timezone: "America/Los_Angeles", past_days: 31, forecast_days: 1,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code", hourly: "temperature_2m",
      temperature_unit: "fahrenheit", precipitation_unit: "inch"
    });
    const body = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
    const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
    const hourNow = +new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23"});
    // Past days in full; today, the forecast for the day and the hourly temperature so far.
    const daily = {}, hourly = {};
    body.daily.time.forEach((d, i) => {
      const v = {high: body.daily.temperature_2m_max[i], low: body.daily.temperature_2m_min[i],
        precip: body.daily.precipitation_sum[i], code: body.daily.weather_code[i]};
      if (d <= today && Object.values(v).every((x) => x != null)) daily[d] = d === today ? {...v, forecast: true} : v;
    });
    body.hourly.time.forEach((t, i) => {
      const d = t.slice(0, 10), temp = body.hourly.temperature_2m[i];
      const hour = +t.slice(11, 13);
      if ((d < today || (d === today && hour <= hourNow)) && temp != null) (hourly[d] ??= Array(24).fill(null))[hour] = Math.round(temp * 10) / 10;
    });
    return {daily, hourly};
  })().catch((error) => {
    console.warn("Recent weather unavailable; using the built copy.", error);
    return {daily: {}, hourly: {}};
  });
  return recentWeather;
}

export async function loadWeatherHourly() {
  const [built, recent] = await Promise.all([FileAttachment("../data/weather-hourly.json").json(), fetchRecentWeather()]);
  return {...built, ...recent.hourly};
}

export async function loadWeather() {
  const [built, recent] = await Promise.all([FileAttachment("../data/weather.json").json(), fetchRecentWeather()]);
  return {...built, ...recent.daily};
}

// More activity uses warm rust; less activity uses cool teal.
export function increaseColor(dark) {
  return dark ? "#c0582a" : "#6a2300";
}

export function declineColor(dark) {
  return dark ? "#19a9b0" : "#00939a";
}

// Rain gets its own blue, validated against the olive series in both modes.
export function rainColor(dark) {
  return dark ? "#4a8ad6" : "#2f6fb0";
}

const MAX_BAR = 28; // px; wider days get air between bars instead of fatter bars
const BAR_SHARE = 0.7; // a bar fills at most this share of its day's slot

/** Inset on each side of a day's slot so bars keep a gap and never exceed MAX_BAR. */
export function dayInset(dates, width, gap = 0, margins = {}) {
  const frame = dayFrame(dates, width, margins);
  const slot = (width - frame.marginLeft - frame.marginRight) / dates.length;
  return Math.max(gap, (slot - Math.min(MAX_BAR, slot * BAR_SHARE)) / 2);
}

/** Shared x layout for the per-day chart and the weather strips under it, so days line up. */
export function dayFrame(dates, width, {marginLeft = 62, marginRight = 24} = {}) {
  const halfDay = 12 * 36e5;
  return {
    width,
    marginLeft,
    marginRight,
    x: {domain: [new Date(+new Date(dates[0]) - halfDay), new Date(+new Date(dates.at(-1)) + halfDay)], label: null}
  };
}

// Flat 12px weather icons, centered on (0, 0). Cloud body reused by the wet ones.
const CLOUD = "M-4.2 2.8h7.6a2.6 2.6 0 0 0 .3-5.2a3.4 3.4 0 0 0-6.5-.6a2.9 2.9 0 0 0-1.4 5.8z";
const WEATHER_ICON = {
  clear: htlSvg`<path d=${SUN_ICON}></path><path d=${SUN_RAYS} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>`,
  partly: htlSvg`<g transform="translate(-2,-2.5) scale(0.7)"><path d=${SUN_ICON}></path><path d=${SUN_RAYS} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></g><path d=${CLOUD} transform="translate(1.5,1.5) scale(0.8)"></path>`,
  cloud: htlSvg`<path d=${CLOUD}></path>`,
  fog: htlSvg`<path d="M-5-2h10M-4 1h8M-5 4h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path>`,
  drizzle: (level) => htl.svg`<path d=${CLOUD} transform="translate(0,-2)"></path>${dropXs(level).map((x) => htl.svg`<circle cx=${x} cy="4.8" r=".75"></circle>`)}`,
  rain: (level) => htl.svg`<path d=${CLOUD} transform="translate(0,-2)"></path><path d=${dropXs(level).map((x) => `M${x + 0.4} 3.5l-.8 2.2`).join("")} stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>`,
  snow: (level) => htl.svg`<path d=${CLOUD} transform="translate(0,-2)"></path>${dropXs(level).map((x) => htl.svg`<circle cx=${x} cy="4.9" r=".95"></circle>`)}`,
  storm: htlSvg`<path d=${CLOUD} transform="translate(0,-2)"></path><path d="M.4 2.6l-1.8 2.4h1.6l-1 2.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"></path>`
};

/** x positions for 1-3 drops under a cloud icon. */
function dropXs(level) {
  return [[0], [-1.6, 1.6], [-3, 0, 3]][level - 1];
}

/** 0 = dry, 1 = light (<0.1 in), 2 = moderate (<0.3 in), 3 = heavy. */
function rainLevel(precip) {
  return precip < 0.01 ? 0 : precip < 0.1 ? 1 : precip < 0.3 ? 2 : 3;
}

/** WMO weather code -> icon kind and a word for tooltips. */
export function weatherKind(code) {
  if (code <= 1) return ["clear", "Clear"];
  if (code === 2) return ["partly", "Partly cloudy"];
  if (code === 3) return ["cloud", "Overcast"];
  if (code === 45 || code === 48) return ["fog", "Fog"];
  if (code >= 51 && code <= 57) return ["drizzle", "Drizzle"];
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return ["rain", "Rain"];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["snow", "Snow"];
  if (code >= 95) return ["storm", "Thunderstorm"];
  return ["cloud", "Cloudy"];
}

function htlSvg(strings, ...values) {
  return () => htl.svg(strings, ...values);
}

// Fixed temperature colors (°F), cold blue -> mild yellow -> hot red, like a weather app.
// Fixed to real temperatures so a given color always means the same thing.
const TEMP_STOPS = [
  [20, "#3f7fd9"],
  [40, "#5fa8d8"],
  [55, "#d9b13b"],
  [70, "#ec8a3a"],
  [85, "#e05a3a"],
  [100, "#c03a4a"]
];
let gradientId = 0;

/**
 * Daily low-to-high temperature as a smooth ribbon, colored along a fixed
 * cold-to-hot scale (the gradient is laid over the whole y axis, so the ribbon
 * shows each day's slice of it).
 */
export function temperatureStrip(dates, weather, {width, ...margins}) {
  const {days, edges} = dailyTemperatureSeries(dates, weather);
  const frame = dayFrame(dates, width, margins);
  const id = `temp-gradient-${++gradientId}`;
  const gradient = (index, {y}) => {
    const [lo, hi] = [TEMP_STOPS[0][0], TEMP_STOPS.at(-1)[0]];
    return htl.svg`<defs><linearGradient id=${id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1=${y(lo)} y2=${y(hi)}>
      ${TEMP_STOPS.map(([t, c]) => htl.svg`<stop offset=${(t - lo) / (hi - lo)} stop-color=${c}></stop>`)}
    </linearGradient></defs>`;
  };
  return Plot.plot({
    ...frame,
    height: 112,
    marginTop: 10,
    marginBottom: 8,
    x: {...frame.x, axis: null},
    y: {label: "High–low °F", labelAnchor: "center", labelArrow: "none", ticks: 3, grid: true, nice: true},
    marks: [
      gradient,
      Plot.areaY(edges, {x: "day", y1: "low", y2: "high", z: "segment", curve: "monotone-x", fill: `url(#${id})`, fillOpacity: 0.9}),
      Plot.tip(days, Plot.pointerX({
        x: "day", y: "high",
        channels: {Day: (d) => formatDate(d.date), High: (d) => `${Math.round(d.high)}°F`, Low: (d) => `${Math.round(d.low)}°F`},
        format: {x: false, y: false, Day: true, High: true, Low: true}
      }))
    ]
  });
}

/**
 * Hourly temperature as a line, colored by temperature like the high-low ribbon. For the day
 * and week views. points: [{t: Date, temp, when}]; domain: the chart above's x domain, so the
 * line sits under the bars it belongs to.
 */
export function hourlyTemperatureStrip(points, {width, domain, inset = 0, ...margins}) {
  const id = `temp-gradient-${++gradientId}`;
  const gradient = (index, {y}) => {
    const [lo, hi] = [TEMP_STOPS[0][0], TEMP_STOPS.at(-1)[0]];
    return htl.svg`<defs><linearGradient id=${id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1=${y(lo)} y2=${y(hi)}>
      ${TEMP_STOPS.map(([t, c]) => htl.svg`<stop offset=${(t - lo) / (hi - lo)} stop-color=${c}></stop>`)}
    </linearGradient></defs>`;
  };
  return Plot.plot({
    width,
    ...margins,
    height: 112,
    marginTop: 10,
    marginBottom: 8,
    x: {type: "time", domain, axis: null, insetLeft: inset, insetRight: inset},
    y: {label: "°F", labelAnchor: "center", labelArrow: "none", ticks: 3, grid: true, nice: true},
    marks: [
      gradient,
      Plot.line(points, {x: "t", y: "temp", stroke: `url(#${id})`, strokeWidth: 2.5, curve: "monotone-x"}),
      Plot.tip(points, Plot.pointerX({
        x: "t", y: "temp",
        channels: {When: "when", Temp: (d) => `${Math.round(d.temp)}°F`},
        format: {x: false, y: false, When: true, Temp: true}
      }))
    ]
  });
}

/**
 * Sky and rain in one row. With room, a flat weather icon per day: wet days are
 * drawn in the rain color, stronger and with more drops the more it rained.
 * Without room (long ranges, phones), a thin strip of tiles: blank when dry,
 * rain-colored when wet, shaded by how much fell.
 */
export function conditionsStrip(dates, weather, {width, dark, ...margins}) {
  const days = dates.filter((d) => weather[d]).map((date) => {
    const w = weather[date];
    return {date, day: new Date(date), ...barSpan(date), precip: w.precip, level: rainLevel(w.precip), kind: weatherKind(w.code)};
  });
  const frame = dayFrame(dates, width, margins);
  const slot = (width - frame.marginLeft - frame.marginRight) / dates.length;
  const wet = rainColor(dark);
  const strength = (precip) => 0.45 + 0.55 * Math.min(1, Math.sqrt(precip / 0.6));
  const describe = (d) => `${formatDate(d.date)}: ${d.kind[1]}${d.level ? `, ${d3.format(".2f")(d.precip)}"` : ""}`;

  if (slot < 14) {
    return Plot.plot({
      ...frame,
      height: 22,
      marginTop: 7,
      marginBottom: 7,
      x: {...frame.x, axis: null},
      y: {axis: null, domain: [0, 1]},
      marks: [
        Plot.rect(days.filter((d) => d.level), {x1: "x1", x2: "x2", y1: 0, y2: 1, fill: wet, fillOpacity: (d) => strength(d.precip)}),
        Plot.tip(days, Plot.pointerX({x: "day", title: describe}))
      ]
    });
  }

  const scale = Math.max(1, Math.min(1.5, slot / 18)); // icons grow with the room per day
  const icons = (index, {x}, values, {marginTop, height, marginBottom}) => {
    const cy = marginTop + (height - marginTop - marginBottom) / 2;
    const g = htl.svg`<g>`;
    for (const d of days) {
      const [kind] = d.kind;
      const wetKind = ["drizzle", "rain", "snow", "storm"].includes(kind);
      // Wet weather codes always get at least one drop; dry-coded days with real rain show as rain.
      const shown = d.level && !wetKind ? "rain" : kind;
      const level = Math.max(1, d.level);
      const icon = WEATHER_ICON[shown];
      const color = d.level ? wet : "currentColor";
      const opacity = d.level ? strength(d.precip) : 0.75;
      g.append(htl.svg`<g transform=${`translate(${x(d.day)},${cy}) scale(${scale})`} fill=${color} color=${color} fill-opacity=${opacity} stroke-opacity=${opacity} style=${`color:${color}`}><title>${describe(d)}</title>${icon(level)}</g>`);
    }
    return g;
  };
  return Plot.plot({
    ...frame,
    height: 34,
    marginTop: 4,
    marginBottom: 4,
    x: {...frame.x, axis: null},
    y: {axis: null, domain: [0, 1]},
    marks: [icons]
  });
}

/** Just the shared date axis, for the bottom of a stack of strips. */
export function dayAxis(dates, {width, ticks, tickFormat, ...margins}) {
  const frame = dayFrame(dates, width, margins);
  return Plot.plot({...frame, height: 26, marginTop: 2, marginBottom: 22, x: {...frame.x, ticks, tickFormat}, y: {axis: null}, marks: [Plot.ruleY([0], {strokeOpacity: 0})]});
}

function barSpan(date) {
  const day = new Date(date);
  return {x1: new Date(+day - 12 * 36e5), x2: new Date(+day + 12 * 36e5)};
}

/**
 * Before -> after ("dumbbell") chart of each species' average minutes heard per day in two
 * periods: a hollow dot for the earlier period, a triangle at the later one pointing the way
 * the count moved, a line between them (rust = heard more, teal = heard less), and both values
 * written beside their dots, on the outside of each pair. A legend above ties each dot style to its period ("September", "October so far", or
 * dates), so the time spans read from the marks.
 *
 * changes: [{species, before, now}], average minutes heard per day.
 */
export function changeChart(changes, {width, dark, beforeLabel, nowLabel, annotatePeriods = false}) {
  const up = increaseColor(dark);
  const down = declineColor(dark);
  const colorOf = (d) => (d.now >= d.before ? up : down);
  const max = d3.max(changes, (d) => Math.max(d.before, d.now)) ?? 1;
  const ring = "var(--theme-background-alt)";
  const num = d3.format(".1~f");
  const ups = changes.filter((d) => d.now >= d.before);
  const downs = changes.filter((d) => d.now < d.before);
  const label = (data, x, side, text, strong) => Plot.text(data, {
    x, y: "species", text, textAnchor: side === "left" ? "end" : "start", dx: side === "left" ? -9 : 9,
    fill: "currentColor", fillOpacity: strong ? 1 : 0.65, fontWeight: strong ? 600 : 400, fontSize: 10.5
  });

  // Mini titles above each block ("HEARD MORE", "HEARD LESS") in place of a color legend: a
  // header row, labelled in the name column, with a rule in that block's color.
  const blocks = [[ups, "more", "Heard more", up], [downs, "less", "Heard less", down]].filter(([rows]) => rows.length);
  const headerKey = (key) => `${HEADER}${key}`;
  const domain = blocks.flatMap(([rows, key]) => [headerKey(key), ...rows.map((d) => d.species)]);
  const headers = blocks.map(([, key, title, color]) => ({y: headerKey(key), title: title.toUpperCase(), color}));
  const plot = Plot.plot({
    width,
    height: changes.length * (annotatePeriods ? 56 : 26) + headers.length * 26 + 46,
    marginLeft: nameMargin(width),
    marginRight: 48,
    marginTop: 8,
    // Room either side of the dots for their values; ticks only from zero up.
    x: {domain: [-max * (width < 520 ? 0.26 : 0.12), max * (width < 520 ? 1.3 : 1.16)], ticks: d3.ticks(0, max * 1.1, width < 520 ? 4 : 8), label: "Average minutes heard per day", labelAnchor: "center", labelArrow: "none", grid: true},
    y: {domain, label: null},
    marks: [
      nameAxis(width, {tickFormat: (k) => (k.startsWith(HEADER) ? "" : k)}),
      Plot.ruleY(headers, {y: "y", stroke: "color", strokeOpacity: 0.55, strokeWidth: 1.5}),
      Plot.text(headers, {y: "y", text: "title", frameAnchor: "left", textAnchor: "end", lineAnchor: "middle", dx: -6, fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em"}),
      Plot.link(changes, {x1: "before", x2: "now", y1: "species", y2: "species", stroke: colorOf, strokeWidth: 2}),
      Plot.dot(changes, {x: "before", y: "species", r: 4.5, fill: ring, stroke: "currentColor", strokeOpacity: 0.65, strokeWidth: 1.5}),
      Plot.dot(changes, {x: "now", y: "species", symbol: "triangle", r: 5.5, rotate: (d) => (d.now >= d.before ? 90 : -90), fill: colorOf, stroke: ring, strokeWidth: 1}),
      // Values on the outside of each pair: earlier value muted, current value bold.
      label(ups, "before", "left", (d) => num(d.before), false),
      label(ups, "now", "right", (d) => num(d.now), true),
      label(downs, "now", "left", (d) => num(d.now), true),
      label(downs, "before", "right", (d) => num(d.before), false),
      annotatePeriods ? Plot.text(changes, {
        y: "species", frameAnchor: "left", textAnchor: "start", dy: 18,
        text: (d) => `${formatDate(d.prevFrom, {month: "short", year: "numeric"})} → ${formatDate(d.nowFrom, {month: "short", year: "numeric"})}`,
        fontSize: 9, fill: "currentColor", fillOpacity: 0.65,
        lineWidth: Math.max(12, (width - nameMargin(width) - 16) / 5), lineHeight: 1.1
      }) : null,
      Plot.tip(changes, Plot.pointerY({
        x: "now", y: "species",
        channels: {
          Species: "species",
          [beforeLabel]: (d) => `${d3.format(".1f")(d.before)} per day`,
          [nowLabel]: (d) => `${d3.format(".1f")(d.now)} per day`,
          ...(annotatePeriods ? {
            "Earlier dates": (d) => dateRange(d.prevFrom, d.prevTo),
            "Following dates": (d) => dateRange(d.nowFrom, d.nowTo),
            "Change (min/day)": (d) => d3.format("+.1f")(d.delta)
          } : {}),
          "Adjusted p": (d) => (d.q < 0.001 ? "< 0.001" : d3.format(".3f")(d.q))
        },
        format: {x: false, y: false}
      }))
    ]
  });

  const key = (shape, label) => htl.html`<span class="key">${shape}${label}</span>`;
  const dot = (fill, stroke) => htl.svg`<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill=${fill} stroke=${stroke} stroke-width="1.5"></circle></svg>`;
  const tri = (fill) => htl.svg`<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5 L10.5 6 L3 10.5 Z" fill=${fill}></path></svg>`;
  return htl.html`<div class="change-chart">
    <div class="change-legend">
      ${key(dot(ring, "currentColor"), beforeLabel)}
      ${key(tri("currentColor"), nowLabel)}
    </div>
    ${plot}
  </div>`;
}

/**
 * Mini species cards. Clicking or tapping a species name anywhere on the page (a chart's name
 * axis, or a link to a species page: Recently heard, the Most heard stat, table rows) opens a
 * small card in place of following the link: photo, names, category, a few numbers, and a
 * "More details" link to the species page. With a mouse, hovering a name opens it too. Chart
 * marks (bars, cells) are data and keep their own tooltips. info(species) returns {photo, scientific, category, rows: [[label, value]]},
 * or null for labels that aren't species (category headers, block titles). Returns a function
 * that removes the listeners. Elements matching `hover` (with the name in data-species) open the
 * card on hover only; their clicks stay the page's own (the Live labels jump to their run).
 * With `newTab`, "More details" opens in a new tab, so the page behind it keeps running.
 */
export function speciesCards(info, {hover = null, newTab = false} = {}) {
  const LABELS = 'g[aria-label="y-axis tick label"] text';
  const LINKS = 'a[href*="species?name="]';
  const TARGETS = [LABELS, LINKS, hover].filter(Boolean).join(", ");
  let card = null;
  let anchor = null;
  let showTimer = null;
  let hideTimer = null;

  // Plot keeps a truncated name's full text in a <title>, which would also pop the browser's
  // own tooltip; move it to a data attribute the first time the pointer comes near.
  const nameOf = (el) => {
    if (hover && el.matches(hover)) return el.dataset.species;
    if (el.matches(LINKS)) return new URL(el.getAttribute("href"), location.href).searchParams.get("name");
    const title = el.querySelector("title");
    if (title) { el.dataset.species = title.textContent; title.remove(); }
    return el.dataset.species ?? el.textContent.trim();
  };
  const hide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    card?.remove();
    card = anchor = null;
  };
  const show = (el, {focus = false} = {}) => {
    const species = nameOf(el);
    const data = species && info(species, el);
    hide();
    if (!data) return;
    anchor = el;
    card = htl.html`<div class="species-pop" role="dialog" aria-label=${species}>
      <div class="species-pop-head">
        ${data.photo ? htl.html`<img src=${data.photo.image} style=${focusStyle(data.photo)} alt="" loading="lazy">` : ""}
        <div>
          <div class="species-pop-name">${species}</div>
          ${data.scientific ? htl.html`<div class="species-pop-sci">${data.scientific}</div>` : ""}
          ${data.category ? htl.html`<div class="species-pop-cat">${data.category}</div>` : ""}
        </div>
      </div>
      <div class="species-pop-rows">${data.rows.map(([k, v]) => htl.html`<div><span>${k}</span><span>${v}</span></div>`)}</div>
      ${data.actions ?? ""}
      <a class="species-pop-more" href=${speciesHref(species)}>More details →</a>
    </div>`;
    // Live keeps playing in its own tab while the species page opens beside it.
    if (newTab) Object.assign(card.querySelector(".species-pop-more"), {target: "_blank", rel: "noopener"});
    card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTimer = setTimeout(hide, 200); });
    document.body.append(card);
    // Right of the name if there's room, else left of it, else below it; always inside the window.
    // Live labels are zero-width buttons whose text is shifted inside the view, so measure the text.
    const r = (el.querySelector(".live-name-text") ?? el).getBoundingClientRect();
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = r.right + 10, top = r.top - 12;
    if (left + w > innerWidth - 8) left = r.left - w - 10;
    if (left < 8) { left = Math.max(8, Math.min(r.left, innerWidth - w - 8)); top = r.bottom + 6; }
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    card.style.left = `${left + scrollX}px`;
    card.style.top = `${top + scrollY}px`;
    if (focus) card.querySelector(".species-pop-more").focus(); // opened from the keyboard
  };

  const over = (e) => {
    const el = e.target.closest?.(TARGETS);
    // Chart marks keep their tooltips; the card's own "More details" link is a species link too,
    // but hovering it must not reopen the card (it would be re-anchored to a detached link).
    if (!el || e.pointerType !== "mouse" || el.closest("svg a") || card?.contains(el)) return;
    nameOf(el);
    clearTimeout(hideTimer);
    if (el === anchor) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), 250);
  };
  const out = (e) => {
    const el = e.target.closest?.(TARGETS);
    if (!el || e.pointerType !== "mouse" || card?.contains(el)) return;
    clearTimeout(showTimer);
    if (card && !card.contains(e.relatedTarget)) hideTimer = setTimeout(hide, 200);
  };
  const click = (e) => {
    if (card?.contains(e.target)) return; // "More details" and the like work normally
    const el = e.target.closest?.(TARGETS);
    if (el?.closest("svg a")) return; // a linked chart mark is data, not a name
    if (hover && el?.matches(hover)) { hide(); return; } // hover-only: the click is the page's
    if (el && el.matches(LINKS) && (e.metaKey || e.ctrlKey || e.shiftKey)) return; // open in a new tab as usual
    if (el && info(nameOf(el))) {
      e.preventDefault();
      el === anchor ? hide() : show(el, {focus: e.detail === 0});
      return;
    }
    if (card) hide();
  };
  const key = (e) => { if (e.key === "Escape") hide(); };
  document.addEventListener("pointerover", over);
  document.addEventListener("pointerout", out);
  document.addEventListener("click", click);
  document.addEventListener("keydown", key);
  return () => {
    hide();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    document.removeEventListener("click", click);
    document.removeEventListener("keydown", key);
  };
}

/**
 * The info function speciesCards needs, from the page's data. confident: detections at or above
 * its threshold (learned from `thresholds`, else minConf); extraRows(species): rows to show first (e.g. minutes heard in the selected period).
 */
export function speciesInfoFrom({all, confident, photos, categories, thresholds = null, minConf = 0.6, extraRows = () => []}) {
  const scientificOf = new Map(d3.rollups(all, (v) => v[0].scientific, (d) => d.species));
  const lastHeardAt = d3.rollup(confident, (v) => d3.max(v, (d) => d.time), (d) => d.species);
  const latest = d3.max(all, (d) => d.date);
  const yearStart = addDays(latest, -364);
  const yearRows = confident.filter((d) => d.date >= yearStart);
  const yearDaysHeard = d3.rollup(yearRows, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species);
  const yearDaysRecorded = new Set(all.filter((d) => d.date >= yearStart).map((d) => d.date)).size;
  return (species) => {
    if (!scientificOf.has(species)) return null;
    const last = lastHeardAt.get(species);
    return {
      photo: photos?.[species],
      scientific: scientificOf.get(species),
      category: categories?.species[species],
      rows: [
        ...extraRows(species),
        ["Past year", `heard on ${yearDaysHeard.get(species) ?? 0} of ${yearDaysRecorded} days`],
        ["Last heard", last ? last.toLocaleString("en-US", {timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "–"],
        ["Threshold", thresholdText(scientificOf.get(species), minConf, thresholds)]
      ]
    };
  };
}
