import {dailyTemperatureSeries} from "./weather-series.js";
import {NWS_GRID, NWS_STATION, NWS_TEMP_STATION, fetchJSON, nwsDay, nwsNow} from "./nws.js";
import {FileAttachment} from "observablehq:stdlib";
import * as d3 from "npm:d3";
import * as Inputs from "npm:@observablehq/inputs";
import * as htl from "npm:htl";
import * as Plot from "npm:@observablehq/plot";

/** A published table (data/<name>.parquet), fetched fresh through the Worker; falls back to the built copy when unreachable or empty. */
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

/** Per-species thresholds (live/thresholds.json; shape in pipeline/thresholds.py), or null if unreachable. */
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

/** Detections, oldest first; `review` is "confirmed", "rejected" or null. Rejected ones are dropped unless includeRejected. */
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

/** Send a verdict ("confirmed", "rejected", or null to clear) on [{at, scientific}]; resolves to whether the server accepted it. */
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

export function loadTraits() {
  return FileAttachment("../data/species-traits.json").json();
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

// Olive count ramps, evenly spaced in OKLab lightness; zero recedes toward the card.
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

/** Plot render transform that bolds **text** in a tip's title: Plot.tip(data, Plot.pointer({title, render: boldMarkup})). */
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

/** Takes a chart's links out of the Tab order so keyboard users don't tab through every cell. */
export function untabbable(plot) {
  for (const a of plot.querySelectorAll("a")) a.setAttribute("tabindex", "-1");
  return plot;
}

/** On phones, names longer than this many characters wrap onto a second line instead of being cut. */
const WRAP_CHARS = 18;
export const nameWraps = (width, name) => width < 480 && name.length > WRAP_CHARS;

export function nameAxis(width, options = {}, ticks) {
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

/** Most recently heard species, newest first, each with up to `times` bouts (detections under `gapMinutes` apart). */
/**
 * One row per species per clock minute heard: that minute's most confident detection. Counting
 * minutes, not 3-second detections, keeps one persistent caller from outweighing everything.
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
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="8.5" r="1.5"/></svg>
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

/** Sunrise/sunset bands: rects with a horizontal gradient whose opacity follows [time ms, 0..1] stops. */
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

/** Sun and moon labels above the timeline. Sunrise and sunset are each [earliest, latest] over the days shown. */
const sunText = ([t, last]) => (+last - +t >= 6e4 ? `${clockShort(t)}–${clockShort(last)}` : clockShort(t));
let measureCtx;
function textWidth(text, size = 10) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
}
const sunSpan = (px, range) => [px + 3, px + 22 + textWidth(sunText(range))];

// Placement of the "last updated" label: beside its line (left if it fits), else raised above
// the sun labels or chart edge on whichever side fits.
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
      const left = sunSpan(px, [t, last])[1] > width - 2;
      g.append(htl.svg`<g transform=${`translate(${left ? px - 10 : px + 10},${y(top) - 6})`} fill-opacity="0.75">
        <title>${range ? `${kind} ${clock(t)} to ${clock(last)}` : `${kind} ${clock(t)}`}</title>
        <g transform="translate(0,-3.5)">${icon}</g>
        <text x=${left ? -12 : 12} y="0" text-anchor=${left ? "end" : "start"}>${sunText([t, last])}</text>
      </g>`);
    }
    return g;
  };
}

/**
 * Day and night bar below the x axis, with a tick and icon at each [{t, kind, at}] (t places the
 * tick, at is the true time). Needs about 28 px of marginBottom; pair with sunTip(points).
 */
export function sunTicks(points) {
  return (index, {x}, values, {marginLeft, width, marginRight, height, marginBottom}) => {
    const axis = height - marginBottom, left = marginLeft, right = width - marginRight;
    const g = htl.svg`<g fill="currentColor" aria-label="sunrise and sunset">`;
    const sorted = [...points].sort((p, q) => +p.t - +q.t);
    const edges = [left, ...sorted.map((p) => Math.max(left, Math.min(right, x(p.t)))), right];
    edges.slice(1).forEach((x1, i) => {
      // The stretch before a sunrise, or after the last sunset, is night.
      const x0 = edges[i], night = i < sorted.length ? sorted[i].kind === "Sunrise" : sorted.at(-1)?.kind === "Sunset";
      if (x1 > x0) g.append(htl.svg`<rect x=${x0} width=${x1 - x0} y=${axis + 4} height="4" fill=${night ? "#2c4a7c" : "#f0d68f"} fill-opacity="0.8"></rect>`);
    });
    for (const {t, kind} of sorted) {
      const px = x(t);
      if (px < left || px > right) continue;
      const icon = kind === "Sunrise"
        ? htl.svg`<path d=${SUN_ICON}></path><path d=${SUN_RAYS} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>`
        : htl.svg`<path d=${MOON_ICON}></path>`;
      g.append(htl.svg`<g>
        <line x1=${px} x2=${px} y1=${axis} y2=${axis + 11} stroke="currentColor" stroke-opacity="0.6"></line>
        <g transform=${`translate(${px},${axis + 20})`} fill-opacity="0.75">${icon}</g>
      </g>`);
    }
    return g;
  };
}

/** A sunTicks point's hover text, such as "Sunrise 7:44 AM". */
export const sunTitle = ({kind, at}) => `${kind} ${clock(at)}`;

/** The chart's own tip for sunTicks: "Sunrise 7:44 AM" when the pointer is near a tick's icon. */
export function sunTip(points) {
  return Plot.tip(points, Plot.pointer({x: "t", y: () => 0, frameAnchor: "bottom", dy: 20, maxRadius: 20, anchor: "bottom", title: sunTitle}));
}

export const SPANS = new Map([["1 day", 1], ["3 days", 3], ["7 days", 7], ["30 days", 30], ["90 days", 90], ["All time", Infinity]]);

/** First date of a `days` window ending on `end`, never before firstDate (Infinity: from firstDate). */
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
const COMPACT_BELOW = 520; // narrower timelines put each name on a line above its row
const NAME_LINE = 0.85; // that line's height, in species rows
const DAYLIGHT_PAD = 30; // minutes shown beyond sunrise or the first detection, and sunset or the last
const DENSITY_FROM = 2; // spans this long are drawn as density strips, not ticks
const BIN_MINUTES = 15;
// Detections closer than this are one bout. A guess from simulated data; see docs/architecture.md.
const BOUT_GAP_MINUTES = 2;
const SEGMENT_MS = 3000; // BirdNET scores 3-second segments
const EMPTY_ROWS = 3; // height of today's empty timeline, in species rows
const NO_AUDIO_MINUTES = 5; // shorter breaks between recordings aren't marked
// Sunrise or sunset moving more than this over the days shown is drawn as a band, not a line.
const SUN_BAND_MS = 10 * 6e4;

/**
 * Detections by time of day: a row per species, grouped by category and ordered by usual first
 * song. One day: a tick per detection. Several days: density strips of minutes heard per day per
 * 15-minute slot, leaving out species heard on under 10% of days.
 *
 * rows: detections from `dates` (Pacific "YYYY-MM-DD", last = reference day).
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
    // Days missing from the sun table (such as a stale cached sun.json) are skipped.
  if (dates.some((date) => !sun[date])) {
    const known = new Set((dates = dates.filter((date) => sun[date])));
    rows = rows.filter((d) => known.has(d.date));
    if (!dates.length) return htl.html`<p class="sub">No sunrise and sunset times for these days yet.</p>`;
  }
  const n = dates.length;
  const density = spanDays >= DENSITY_FROM;
  const ref = sun[dates.at(-1)];
  const refStart = new Date(ref.start);
    // Days overlay by elapsed time since midnight, so on DST days times after 2 AM are off an hour.
  const dstShift = (date) => +new Date(sun[date].end) - +new Date(sun[date].start) - 864e5; // 0, +1h or -1h
  const refShift = dstShift(dates.at(-1));
  const offset = (date, t) => { // wall-clock ms since local midnight
    const elapsed = +t - +new Date(sun[date].start), shift = dstShift(date);
    return shift && elapsed >= 2 * 36e5 ? elapsed - shift : elapsed;
  };
  const refAt = (wall) => new Date(+refStart + (refShift && wall >= 2 * 36e5 ? wall + refShift : wall));
  const onRef = (date, t) => refAt(offset(date, t));

  const sunRange = (key) => d3.extent(dates, (date) => +onRef(date, new Date(sun[date][key]))).map((t) => new Date(t));
  const sunriseRange = sunRange("sunrise");
  const sunsetRange = sunRange("sunset");
  // Both become bands once either moves enough, so sunrise and sunset are drawn the same way.
  const banded = [sunriseRange, sunsetRange].some(([a, b]) => +b - +a >= SUN_BAND_MS);
  const isBand = () => banded;
    // Over many days, each band's gradient is a lightly smoothed histogram of the days' times.
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
    // "Daylight only": a little before sunrise (or first detection) to a little after sunset (or
    // last detection); detections over 90 minutes into the night don't count.
  const [outerFrom, outerTo] = [earliestSunrise - 90 * 6e4, latestSunset + 90 * 6e4];
  const heardAt = [...rows, ...unidentified].map((d) => offset(d.date, d.time)).filter((t) => t >= outerFrom && t <= outerTo);
  const domain = daylightOnly
    ? [refAt(Math.max(outerFrom, Math.min(earliestSunrise, d3.min(heardAt) ?? Infinity) - DAYLIGHT_PAD * 6e4)),
       refAt(Math.min(outerTo, Math.max(latestSunset, d3.max(heardAt) ?? -Infinity) + DAYLIGHT_PAD * 6e4))]
    : [dayStart, dayEnd];
  const compact = width < COMPACT_BELOW;
  const nameWidth = compact ? 4 : nameMargin(width);

  let shown = rows
    .map((d) => ({...d, clock: onRef(d.date, d.time)}))
    .filter((d) => d.clock >= domain[0] && d.clock <= domain[1]);
  if (density) {
    const daysHeard = d3.rollup(shown, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species);
    shown = shown.filter((d) => daysHeard.get(d.species) >= 0.1 * n);
  }

  const firstHeard = d3.rollup(shown, (v) => d3.median(d3.rollups(v, (w) => d3.min(w, (d) => +d.clock), (d) => d.date), ([, t]) => t), (d) => d.species);
  const timesHeard = d3.rollup(shown, (v) => v.length, (d) => d.species);
  const byFirst = (a, b) => d3.ascending(firstHeard.get(a), firstHeard.get(b));
  const byCount = (a, b) => d3.descending(timesHeard.get(a), timesHeard.get(b)) || byFirst(a, b);
  const categoryOf = (s) => categories?.species[s] ?? "Other";
    // Spans over a week start collapsed; the viewer's overrides win and persist across periods.
  const auto = spanDays > 7;
  const collapsedOf = (key) => (overrides.has(key) ? overrides.get(key) : auto);
  let order;
  let rowKeyOf = (species) => species; // which row a species' detections are drawn on
  let groups = [];
  let hiddenCount = 0;
  if (sort === "category") {
        // A collapsed category is one row (its header) holding all its species' detections.
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
    // Unidentified birdsong: one muted row last, tick views only. Not a species: no card or counts.
  const unidentifiedShown = density ? [] : unidentified.map((u) => ({...u, clock: onRef(u.date, u.time)}))
    .filter((u) => u.clock >= domain[0] && u.clock <= domain[1]);
  if (unidentifiedShown.length && order.length) order.push(UNIDENTIFIED);
  const headers = order.filter((k) => k.startsWith(HEADER));
  const groupSize = new Map(groups.map(([g, sp]) => [g, sp.length]));

    // Rows laid out by hand (in species-row units) so headers get room above and below.
  const rowsAt = new Map(); // key -> {y1, y2, y, label}
  let pos = 0;
  for (const key of order) {
    const header = key.startsWith(HEADER);
    if ((header || key === UNIDENTIFIED) && pos > 0) pos += GROUP_GAP;
    if (compact) {
      const open = header && !collapsedOf(key.slice(1));
      const body = open ? 0.3 : 1;
      rowsAt.set(key, {y1: pos + NAME_LINE, y2: pos + NAME_LINE + body, y: pos + NAME_LINE + body / 2, label: pos + NAME_LINE * 0.55});
      pos += NAME_LINE + body;
      continue;
    }
    const h = (header || key === UNIDENTIFIED) ? HEADER_ROWS : nameWraps(width, rowKeyOf(key) === key ? key : "") ? 1.7 : 1; // room for a wrapped name
    rowsAt.set(key, {y1: pos, y2: pos + h, y: pos + h / 2, label: pos + h / 2});
    pos += h;
  }
    // Today with nothing heard yet: an empty timeline (gaps still hatched) with a note.
  const emptyToday = !firstHeard.size && n === 1 && dates[0] === localDate(new Date());
  const total = emptyToday ? EMPTY_ROWS : pos;
  const rowOf = (species) => rowsAt.get(rowKeyOf(species));
  const speciesTicks = order.filter((k) => !k.startsWith(HEADER) && k !== UNIDENTIFIED).map((k) => rowsAt.get(k).label);
  const nameAt = new Map(order.map((k) => [rowsAt.get(k).label, k]));

  if (!firstHeard.size && !emptyToday) return htl.html`<p class="sub">No detections ${daylightOnly && rows.length ? "in daylight " : ""}${n === 1 ? "on this day" : "in these days"}.</p>`;

  const fade = n === 1 ? 1 : n <= 3 ? 0.6 : 0.4; // overlapping days stack up
  const hourStep = width < 480 ? 4 : width < 800 ? 2 : 1;

  let dataMarks;
  let color;
  if (density) {
        // Minutes heard per day in each 15-minute slot on the reference day's clock.
    const bin = d3.timeMinute.every(BIN_MINUTES);
    const bins = d3.flatRollup(shown, (v) => new Set(v.map((d) => `${d.species}|${Math.floor(+d.time / 6e4)}`)).size / n, (d) => rowKeyOf(d.species), (d) => +bin.floor(d.clock))
      .map(([key, t, rate]) => ({key, name: key.startsWith(HEADER) ? key.slice(1) : key, t1: new Date(t), t2: new Date(t + BIN_MINUTES * 6e4), rate}));
    color = sequential(dark, {legend: true, label: "Minutes heard per day", zero: true, marginLeft: nameWidth,
      ...(width < 520 ? {width, marginRight: 30, ticks: 3} : {width: nameWidth + 260, marginRight: 20})});
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
        // At least ~2 px wide, so single calls stay visible.
    const minMs = ((+domain[1] - +domain[0]) / Math.max(1, width - nameWidth - 16)) * 2;
    for (const b of bouts) b.end = new Date(Math.max(+b.last + SEGMENT_MS, +b.first + minMs));
    const minutesLong = (b) => Math.round((+b.last + SEGMENT_MS - +b.first) / 6e4);
    const boutTip = {
      Species: (b) => (rowKeyOf(b.species).startsWith(HEADER) ? `${categoryOf(b.species)}: ${b.species}` : b.species),
      Time: (b) => (b.n === 1 ? clock(b.firstTime) : `${clock(b.firstTime)}–${clock(b.lastTime)}`),
      Length: (b) => (b.n === 1 ? "single call" : `${minutesLong(b) || "<1"} min, ${b.n} detections`),
      "Top confidence": (b) => d3.format(".0%")(b.confidence)
    };
    if (n > 1) boutTip.Day = (b) => formatDate(b.date, {weekday: "short", month: "short", day: "numeric"});
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

    // Collapsed headers contain bars, so their annotations and rules start above the first row.
  const firstHeader = headers[0];
  const gridTop = !compact && firstHeader && !collapsedOf(firstHeader.slice(1))
    ? rowsAt.get(firstHeader).y
    : 0;
  const gridHours = d3.timeHour.every(hourStep).range(domain[0], new Date(+domain[1] + 1));
    // Today: the unrecorded rest of the day is shaded so it doesn't read as time without birds.
  const pacificDate = (t) => t.toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
  const recordedAt = recordedUntil && n === 1 && pacificDate(recordedUntil) === dates[0] ? onRef(dates[0], recordedUntil) : null;
  const marginLeft = nameWidth, marginRight = 16;
  const recordedShown = recordedAt && recordedAt >= domain[0] && recordedAt <= domain[1];
  const recordedText = recordedShown && `Last updated ${clock(recordedUntil)}`;
  const recordedPlace = recordedShown && lastUpdatedPlace(d3.scaleTime(domain, [marginLeft, width - marginRight]), recordedAt, recordedText,
    [sunriseRange, sunsetRange].filter((r) => !isBand(r)), width);
    // One day: no-audio stretches are hatched, only up to `audio`'s newest (the table can lag).
  const noAudio = [];
  if (audio && n === 1) {
    const known = d3.max(audio, ([, b]) => b) ?? -Infinity;
    const dayFrom = +new Date(sun[dates[0]].start), dayTo = Math.min(+new Date(sun[dates[0]].end), recordedAt ? +recordedUntil : Infinity, known);
    const spans = audio.filter(([a, b]) => b > dayFrom && a < dayTo).sort((p, q) => p[0] - q[0]);
        // A past day without rows predates the recordings table (unknown, not missed); today is missed up to now.
    const todayNoAudio = !spans.length && dates[0] === localDate(new Date());
    if (spans.length || todayNoAudio) {
      const until = todayNoAudio ? Math.min(+new Date(sun[dates[0]].end), Date.now()) : dayTo;
      let from = dayFrom;
      for (const [a, b] of [...spans, [until, until]]) {
        if (a - from >= NO_AUDIO_MINUTES * 6e4) noAudio.push([onRef(dates[0], new Date(from)), onRef(dates[0], new Date(Math.min(a, until)))]);
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
  const halo = compact ? {stroke: "var(--theme-background-alt)", strokeWidth: 3, paintOrder: "stroke"} : {};
  const names = [
    Plot.text(headingRows, {y: (d) => rowsAt.get(d).label, text: headerLabel, frameAnchor: "left", lineAnchor: "middle", fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em", ...halo,
      ...(compact ? {textAnchor: "start", dx: 0} : {textAnchor: "end", dx: -6, lineWidth: (nameWidth - 10) / 9.5, lineHeight: 1.1})}),
    nameAxis(width, {tickFormat: (y) => nameAt.get(y), ...(compact ? {textAnchor: "start", tickPadding: 0, dx: 0, lineWidth: 60, textOverflow: "ellipsis", ...halo} : {})}, speciesTicks)
  ];
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
      daylightOnly ? null : Plot.rectX([[dayStart, sunriseRange[0]], [sunsetRange[1], dayEnd]], {x1: "0", x2: "1", fill: "currentColor", fillOpacity: 0.06}),
      Plot.ruleX(gridHours, {y1: gridTop, y2: total, stroke: "currentColor", strokeOpacity: 0.1}),
      Plot.ruleX([sunriseRange, sunsetRange].filter((r) => !isBand(r)).map(([t]) => t), {y1: gridTop, y2: total, stroke: "currentColor", strokeOpacity: 0.35, strokeDasharray: "3,3"}),
      sunMarkers(sunriseRange, sunsetRange, gridTop),
      ...recordedMarks,
      noAudio.length ? hatchMark(noAudio.map(([a, b]) => [new Date(Math.max(a, domain[0])), new Date(Math.min(b, domain[1]))]), gridTop, total) : null,
      Plot.ruleY(headers.filter((h) => !collapsedOf(h.slice(1))), {y: (d) => rowsAt.get(d).y, stroke: "currentColor", strokeOpacity: 0.18}),
      ...(compact ? [] : names),
      ...dataMarks,
      emptyToday ? Plot.text([!audio || audio.some(([a, b]) => b > +new Date(sun[dates[0]].start) && a < +new Date(sun[dates[0]].end)) ? "No detections yet today" : "No data yet today"],
        {x: () => new Date((+domain[0] + +domain[1]) / 2), y: total / 2, text: (d) => d, fontSize: 13, fill: "currentColor", fillOpacity: 0.7, stroke: "var(--theme-background-alt)", strokeWidth: 6, paintOrder: "stroke"}) : null,
            // Over many days, sun bands sit on top of the data, as opaque as the share of dark days.
      sunBandMark(sunBands, gridTop, total, dark ? "#8cc4f0" : "#4f9ad6", dark ? 0.38 : 0.5),
      ...(compact ? names : [])
    ]
  });

  wireCategoryToggles(plot, groups, collapsedOf, groupSize, onToggle);

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

/** Makes category header labels (from categoryLabel) toggle their category by mouse or keyboard. */
export function wireCategoryToggles(plot, groups, collapsedOf, groupSize, onToggle) {
  for (const text of plot.querySelectorAll("text")) {
    if (text.closest("[aria-label='tip']")) continue;
        // Wrapped labels split into tspans, so compare without spaces.
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
// short: month only on the first day and the 1st ("Oct 24", "25"), for crowded daily ticks.
export function dayTickFormat(dates, {short = false} = {}) {
  const multiYear = dates[0].slice(0, 4) !== dates.at(-1).slice(0, 4);
  return (t) => {
    const key = t.toISOString().slice(0, 10);
    if (short && key !== dates[0] && !key.endsWith("-01")) return String(t.getUTCDate());
    const withYear = multiYear && (key === dates[0] || key.endsWith("-01-01"));
    return t.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric", ...(withYear ? {year: "numeric"} : {})});
  };
}

/**
 * Date ticks for a per-day chart: every day for short ranges, else the ends and each month's 1st,
 * dropping month starts that would collide (never the ends). plotWidth: px for the bars.
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

/** Weather: the built copy (pipeline/weather.py), last month refreshed from Open-Meteo; today from NWS (nws.js), else Open-Meteo. */
let recentWeather = null;
async function nwsToday(today) {
  const get = (url) => fetchJSON(url, {headers: {Accept: "application/geo+json"}});
    // 8 AM UTC is midnight Pacific or earlier in both PST and PDT; nwsDay drops the extra.
  const since = `observations?start=${today}T07:00:00Z`;
  const [hourly, grid, observed, observedTemp] = await Promise.all([get(`${NWS_GRID}/forecast/hourly`), get(NWS_GRID),
    get(`${NWS_STATION}/${since}`).catch(() => ({features: []})), get(`${NWS_TEMP_STATION}/${since}`).catch(() => ({features: []}))]);
  return {...nwsDay(today, hourly.properties.periods, grid.properties.quantitativePrecipitation, observed.features),
    now: nwsNow(observed.features, observedTemp.features)};
}
function fetchRecentWeather() {
  recentWeather ??= (async () => {
    const params = new URLSearchParams({
      latitude: 47.68, longitude: -122.26, timezone: "America/Los_Angeles", past_days: 31, forecast_days: 1,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code", hourly: "temperature_2m",
      temperature_unit: "fahrenheit", precipitation_unit: "inch"
    });
    const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
    const nwsPending = nwsToday(today).catch((error) => { console.warn("NWS forecast unavailable; using Open-Meteo's.", error); return null; });
    const body = await fetchJSON(`https://api.open-meteo.com/v1/forecast?${params}`);
    const hourNow = +new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23"});
        // Today: the day's forecast, observed hourly temperatures, and the remaining hours as a
        // forecast from the current hour on, so the lines join.
    const daily = {}, hourly = {}, forecastHourly = {};
    body.daily.time.forEach((d, i) => {
      const v = {high: body.daily.temperature_2m_max[i], low: body.daily.temperature_2m_min[i],
        precip: body.daily.precipitation_sum[i], code: body.daily.weather_code[i]};
      if (d <= today && Object.values(v).every((x) => x != null)) daily[d] = d === today ? {...v, forecast: true} : v;
    });
    body.hourly.time.forEach((t, i) => {
      const d = t.slice(0, 10), temp = body.hourly.temperature_2m[i];
      const hour = +t.slice(11, 13);
      if (temp == null) return;
      if (d < today || (d === today && hour <= hourNow)) (hourly[d] ??= Array(24).fill(null))[hour] = Math.round(temp * 10) / 10;
      if (d === today && hour >= hourNow) (forecastHourly[d] ??= Array(24).fill(null))[hour] = Math.round(temp * 10) / 10;
    });
    let now = null;
    const nws = await nwsPending;
    if (nws?.code != null) {
      now = nws.now;
      const temps = [...(hourly[today] ?? []), ...nws.hourly].filter((t) => t != null);
      daily[today] = {high: Math.max(...temps), low: Math.min(...temps), precip: nws.precip, code: nws.code, forecast: true};
      forecastHourly[today] = nws.hourly.map((t, hour) => (hour >= hourNow ? t : null));
    }
    return {daily, hourly, forecastHourly, now};
  })().catch((error) => {
    console.warn("Recent weather unavailable; using the built copy.", error);
    return {daily: {}, hourly: {}, forecastHourly: {}, now: null};
  });
  return recentWeather;
}

export async function loadWeatherHourly() {
  const [built, recent] = await Promise.all([FileAttachment("../data/weather-hourly.json").json(), fetchRecentWeather()]);
  return {...built, ...recent.hourly};
}

/** The rest of today's hourly temperatures, forecast: {date: [24 values, null outside it]}. */
export async function loadForecastHourly() {
  return (await fetchRecentWeather()).forecastHourly;
}

/** The latest observed conditions and temperature (nws.js's nwsNow), or null. */
export async function loadWeatherNow() {
  return (await fetchRecentWeather()).now;
}

export async function loadWeather() {
  const [built, recent] = await Promise.all([FileAttachment("../data/weather.json").json(), fetchRecentWeather()]);
  return {...built, ...recent.daily};
}

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

// Temperature colors pinned to °F so a color always means the same temperature.
const TEMP_STOPS = [
  [20, "#3f7fd9"],
  [40, "#5fa8d8"],
  [55, "#d9b13b"],
  [70, "#ec8a3a"],
  [85, "#e05a3a"],
  [100, "#c03a4a"]
];
let gradientId = 0;

/** Daily low-to-high temperature ribbon; the color gradient spans the whole y axis, so each day shows its slice. */
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

/** Splits a sorted [{t, temp, when}] line at t into [before, forecast after], joined by a point interpolated at t. */
export function splitAt(line, t, when) {
  const i = d3.bisector((d) => +d.t).left(line, +t);
  const ahead = (d) => ({...d, forecast: true});
  if (i === 0) return [[], line.map(ahead)];
  if (i >= line.length) return [line, []];
  const a = line[i - 1], b = line[i];
  const joint = {t: new Date(+t), temp: a.temp + ((+t - +a.t) / (+b.t - +a.t)) * (b.temp - a.temp), when: when(t)};
  return [[...line.slice(0, i), joint], [ahead(joint), ...line.slice(i).map(ahead)]];
}

/**
 * Hourly temperature line colored like the ribbon. domain: the x domain of the chart above;
 * forecast: the rest of today, dashed, starting where points end.
 */
export function hourlyTemperatureStrip(points, {width, domain, inset = 0, forecast = [], ...margins}) {
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
      Plot.line(forecast, {x: "t", y: "temp", stroke: `url(#${id})`, strokeWidth: 2.5, strokeDasharray: "7,8", curve: "monotone-x"}),
      Plot.tip([...points, ...forecast.slice(1)], Plot.pointerX({
        x: "t", y: "temp",
        channels: {When: "when", Temp: (d) => `${Math.round(d.temp)}°F${d.forecast ? " (forecast)" : ""}`},
        format: {x: false, y: false, When: true, Temp: true}
      }))
    ]
  });
}

/**
 * Sky and rain row: a weather icon per day when there's room (wetter is stronger, more drops),
 * else a strip of tiles shaded by rainfall.
 */
export function conditionsStrip(dates, weather, {width, dark, ...margins}) {
  const days = dates.filter((d) => weather[d]).map((date) => {
    const w = weather[date];
    return {date, day: new Date(date), ...barSpan(date), precip: w.precip, level: rainLevel(w.precip), kind: weatherKind(w.code), forecast: !!w.forecast};
  });
  const frame = dayFrame(dates, width, margins);
  const slot = (width - frame.marginLeft - frame.marginRight) / dates.length;
  const wet = rainColor(dark);
  const strength = (precip) => 0.45 + 0.55 * Math.min(1, Math.sqrt(precip / 0.6));
  const describe = (d) => `${formatDate(d.date)}: ${d.kind[1]}${d.level ? `, ${d3.format(".2f")(d.precip)}"` : ""}${d.forecast ? " (forecast)" : ""}`;
  // The strip is shorter than its tip, so the tip opens upward, over the chart above it.
  const tip = Plot.tip(days, Plot.pointerX({x: "day", title: describe, anchor: "bottom"}));

  if (slot < 14) {
    return Plot.plot({
      ...frame,
      height: 22,
      marginTop: 7,
      marginBottom: 7,
      style: {overflow: "visible"},
      x: {...frame.x, axis: null},
      y: {axis: null, domain: [0, 1]},
      marks: [
        Plot.rect(days.filter((d) => d.level), {x1: "x1", x2: "x2", y1: 0, y2: 1, fill: wet, fillOpacity: (d) => strength(d.precip)}),
        tip
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
      const shown = d.level && !wetKind ? "rain" : kind;
      const level = Math.max(1, d.level);
      const icon = WEATHER_ICON[shown];
      const color = d.level ? wet : "currentColor";
      const opacity = d.level ? strength(d.precip) : 0.75;
      g.append(htl.svg`<g transform=${`translate(${x(d.day)},${cy}) scale(${scale})`} fill=${color} color=${color} fill-opacity=${opacity} stroke-opacity=${opacity} style=${`color:${color}`}>${icon(level)}</g>`);
    }
    return g;
  };
  return Plot.plot({
    ...frame,
    height: 34,
    marginTop: 4,
    marginBottom: 4,
    style: {overflow: "visible"},
    x: {...frame.x, axis: null},
    y: {axis: null, domain: [0, 1]},
    marks: [icons, tip]
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
 * Before/after dumbbell of each species' average minutes per day: hollow dot before, triangle
 * after, rust for more, teal for less. changes: [{species, before, now}]. With `daily`, one
 * day against the previous (untested), cut off at `asOf`; else averages with adjusted p-values.
 */
export function changeChart(changes, {width, dark, beforeLabel, nowLabel, annotatePeriods = false, xLabel = "Average minutes heard per day", daily = false, asOf = null}) {
  const up = increaseColor(dark);
  const down = declineColor(dark);
  const colorOf = (d) => (d.now >= d.before ? up : down);
  const max = d3.max(changes, (d) => Math.max(d.before, d.now)) ?? 1;
  const ring = "var(--theme-background-alt)";
    // Averages keep a decimal under 1 so 0.3 doesn't read as 0.
  const round = (v) => (v > 0 && v < 1 ? d3.format(".1f")(v) : d3.format(",.0f")(v));
  const num = (v) => `${round(v)} ${daily ? "min" : "min/day"}`;
  const tipValue = (v, side) => (daily ? `${round(v)} min${asOf ? ` ${side === "now" ? "as of" : "before"} ${asOf}` : ""}` : `${round(v)} min per day`);
  const ups = changes.filter((d) => d.now >= d.before);
  const downs = changes.filter((d) => d.now < d.before);
    // Narrow screens put names above rows (dy: rows down by `low`, names up by `high`).
  const compact = width < COMPACT_BELOW;
  const [low, high] = compact ? [7, -9] : [0, 0];
  const label = (data, x, side, text, strong) => Plot.text(data, {
    x, y: "species", dy: low, text, textAnchor: side === "left" ? "end" : "start", dx: side === "left" ? -9 : 9,
    fill: "currentColor", fillOpacity: strong ? 1 : 0.65, fontWeight: strong ? 600 : 400, fontSize: 10.5
  });

    // "HEARD MORE"/"HEARD LESS" header rows, ruled in their color, replace a legend.
  const blocks = [[ups, "more", "Heard more", up], [downs, "less", "Heard less", down]].filter(([rows]) => rows.length);
  const headerKey = (key) => `${HEADER}${key}`;
  const domain = blocks.flatMap(([rows, key]) => [headerKey(key), ...rows.map((d) => d.species)]);
  const headers = blocks.map(([, key, title, color]) => ({y: headerKey(key), title: title.toUpperCase(), color}));
  const plot = Plot.plot({
    width,
    height: changes.length * (annotatePeriods ? 56 : 26) * (compact ? 1.5 : 1) + headers.length * 26 + 46,
    marginLeft: compact ? 4 : nameMargin(width),
    marginRight: 48,
    marginTop: 8,
    x: {domain: [-max * (width < 520 ? 0.26 : 0.12), max * (width < 520 ? 1.3 : 1.16)], ticks: d3.ticks(0, max * 1.1, width < 520 ? 4 : 8), label: xLabel, labelAnchor: "center", labelArrow: "none", grid: true},
    y: {domain, label: null},
    marks: [
      nameAxis(width, {tickFormat: (k) => (k.startsWith(HEADER) ? "" : k), ...(compact ? {textAnchor: "start", tickPadding: 0, dy: high, lineWidth: 60, textOverflow: "ellipsis"} : {})}),
      Plot.ruleY(headers, {y: "y", dy: low, stroke: "color", strokeOpacity: 0.55, strokeWidth: 1.5}),
      Plot.text(headers, {y: "y", text: "title", frameAnchor: "left", lineAnchor: "middle", fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em",
        ...(compact ? {textAnchor: "start", dy: high} : {textAnchor: "end", dx: -6})}),
      Plot.link(changes, {x1: "before", x2: "now", y1: "species", y2: "species", dy: low, stroke: colorOf, strokeWidth: 2}),
      Plot.dot(changes, {x: "before", y: "species", dy: low, r: 4.5, fill: ring, stroke: "currentColor", strokeOpacity: 0.65, strokeWidth: 1.5}),
      Plot.dot(changes, {x: "now", y: "species", dy: low, symbol: "triangle", r: 5.5, rotate: (d) => (d.now >= d.before ? 90 : -90), fill: colorOf, stroke: ring, strokeWidth: 1}),
      label(ups, "before", "left", (d) => num(d.before), false),
      label(ups, "now", "right", (d) => num(d.now), true),
      label(downs, "now", "left", (d) => num(d.now), true),
      label(downs, "before", "right", (d) => num(d.before), false),
      annotatePeriods ? Plot.text(changes, {
        y: "species", frameAnchor: "left", textAnchor: "start", dy: 18 + low,
        text: (d) => `${formatDate(d.prevFrom, {month: "short", year: "numeric"})} → ${formatDate(d.nowFrom, {month: "short", year: "numeric"})}`,
        fontSize: 9, fill: "currentColor", fillOpacity: 0.65,
        lineWidth: Math.max(12, (width - (compact ? 4 : nameMargin(width)) - 16) / 5), lineHeight: 1.1
      }) : null,
      Plot.tip(changes, Plot.pointerY({
        x: "now", y: "species",
        channels: {
          Species: "species",
          [beforeLabel]: (d) => tipValue(d.before, "before"),
          [nowLabel]: (d) => tipValue(d.now, "now"),
          ...(annotatePeriods ? {
            "Earlier dates": (d) => dateRange(d.prevFrom, d.prevTo),
            "Following dates": (d) => dateRange(d.nowFrom, d.nowTo),
            "Change (min/day)": (d) => d3.format("+.1f")(d.delta)
          } : {}),
          ...(daily ? {} : {"Adjusted p": (d) => (d.q < 0.001 ? "< 0.001" : d3.format(".3f")(d.q))})
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
 * Mini species cards: clicking (or hovering, with a mouse) a species name or link opens a card
 * instead of following it. info(species) returns {photo, scientific, category, rows} or null for
 * non-species labels. `hover` elements open on hover only and keep their clicks. `newTab` opens
 * "More details" in a new tab. Returns a cleanup function.
 */
export function speciesCards(info, {hover = null, newTab = false} = {}) {
  const LABELS = 'g[aria-label="y-axis tick label"] text';
  const LINKS = 'a[href*="species?name="]';
  const TARGETS = [LABELS, LINKS, hover].filter(Boolean).join(", ");
  let card = null;
  let anchor = null;
  let showTimer = null;
  let hideTimer = null;

    // Move a truncated name's <title> to a data attribute, so the browser's tooltip doesn't also pop.
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
    if (newTab) Object.assign(card.querySelector(".species-pop-more"), {target: "_blank", rel: "noopener"});
    card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    card.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTimer = setTimeout(hide, 200); });
    document.body.append(card);
        // Right of the name, else left, else below, inside the window. Live labels are zero-width
        // buttons with shifted text, so measure the text.
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
        // Skip chart marks, and the card's own link (reopening would anchor to a detached element).
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

/** speciesCards' info function. confident: detections at or above threshold; extraRows(species): rows shown first. */
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
