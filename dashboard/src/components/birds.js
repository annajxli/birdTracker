import {FileAttachment} from "observablehq:stdlib";
import * as d3 from "npm:d3";
import * as Inputs from "npm:@observablehq/inputs";
import * as htl from "npm:htl";
import * as Plot from "npm:@observablehq/plot";

export async function loadDetections() {
  const table = await FileAttachment("../data/detections.parquet").parquet();
  const rows = [];
  for (const r of table) {
    rows.push({
      time: new Date(Number(r.time)),
      date: r.date, // Pacific-time calendar date, "YYYY-MM-DD"
      hour: r.hour, // Pacific-time hour, 0-23
      species: r.species,
      scientific: r.scientific,
      confidence: r.confidence,
      clip: r.clip
    });
  }
  return rows;
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

export function confidenceInput(value = 0.6) {
  return Inputs.range([0.25, 1], {label: "Min confidence", step: 0.05, value});
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
export const MUTED = "#a89a85";

const rampInterpolator = (dark) => d3.piecewise(d3.interpolateLab, dark ? RAMP_DARK : RAMP_LIGHT);

/** Color for a BirdNET confidence (0.25-1), from the stronger two-thirds of the ramp. */
export function confidenceColor(dark) {
  const interpolate = rampInterpolator(dark);
  return (c) => interpolate(0.35 + 0.65 * Math.max(0, Math.min(1, (c - 0.25) / 0.75)));
}

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
export function nameAxis(width, options = {}, ticks) {
  const axisOptions = {tickSize: 0, label: null, textOverflow: "ellipsis", lineWidth: width < 480 ? 10 : 16, ...options};
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
    <a class="bird-name" href=${speciesHref(species)}>${species}</a>
    <div class="bird-when">${dayLabel(latest)}, ${clock(latest)}</div>
    ${earlier.length ? htl.html`<div class="bird-times">also ${earlier.map(clock).join(" · ")}</div>` : ""}
  </div>`;
}

/** A species photo with its credit tucked into an ⓘ badge (hover, or tap/focus on touch screens). */
export function birdPhoto(species, photo, href) {
  const img = photo
    ? htl.html`<img src=${photo.image} alt=${`Photo of a ${species}`} title=${`Photo: ${photo.artist}, ${photo.license}`} loading="lazy" width=${photo.width} height=${photo.height}>`
    : htl.html`<span class="bird-photo-missing">No photo</span>`;
  return htl.html`<div class="photo-wrap">
    ${href ? htl.html`<a class="bird-photo" href=${href}>${img}</a>` : htl.html`<div class="bird-photo">${img}</div>`}
    ${photo ? photoCredit(photo) : ""}
  </div>`;
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
  return Inputs.date({label: "Day", value: dates.at(-1), min: dates[0], max: dates.at(-1)});
}

/** Inputs.date gives a UTC-midnight Date; turn it back into our "YYYY-MM-DD" key. */
export function dateKey(date) {
  return date instanceof Date ? date.toISOString().slice(0, 10) : date;
}

// Flat 11px icons for the sunrise/sunset markers, drawn centered on (0, 0).
const SUN_ICON = "M0-2.6a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2Z";
const SUN_RAYS = "M0-5.5v1.4M0 4.1v1.4M-5.5 0h1.4M4.1 0h1.4M-3.9-3.9l1 1M2.9 2.9l1 1M-3.9 3.9l1-1M2.9-2.9l1-1";
const MOON_ICON = "M1.6-4.6A4.8 4.8 0 1 0 4.4 2.4A3.8 3.8 0 0 1 1.6-4.6Z";

/** Custom Plot mark: a sun icon + time at sunrise and a moon icon + time at sunset, above the frame. */
function sunMarkers(sunrise, sunset) {
  return (index, {x}, values, {marginTop, marginLeft, width, marginRight}) => {
    const g = htl.svg`<g fill="currentColor" font-size="10" aria-label="sunrise and sunset">`;
    for (const [t, kind] of [[sunrise, "Sunrise"], [sunset, "Sunset"]]) {
      const px = x(t);
      if (px < marginLeft || px > width - marginRight) continue;
      const icon = kind === "Sunrise"
        ? htl.svg`<path d=${SUN_ICON}></path><path d=${SUN_RAYS} fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path>`
        : htl.svg`<path d=${MOON_ICON}></path>`;
      g.append(htl.svg`<g transform=${`translate(${px},${marginTop - 14})`} fill-opacity="0.75">
        <title>${`${kind} ${clock(t)}`}</title>
        <g transform="translate(-7,-3.5)">${icon}</g>
        <text x="0" y="0" text-anchor="start">${clockShort(t)}</text>
      </g>`);
    }
    return g;
  };
}

export const SPANS = new Map([["1 day", 1], ["3 days", 3], ["7 days", 7], ["30 days", 30], ["90 days", 90], ["All time", Infinity]]);

/** First date of a window of `days` ending on `end`; Infinity means from the first date with data. */
export function windowStart(end, days, firstDate) {
  return days === Infinity ? firstDate : addDays(end, -(days - 1));
}

export const SORTS = new Map([["Category", "category"], ["Most heard", "count"], ["First heard", "first"]]);

export function sortInput(value = "Category") {
  return Inputs.radio(SORTS.keys(), {label: "Sort", value});
}

export function spanInput(value = "1 day") {
  return Inputs.radio(SPANS.keys(), {label: "Span", value});
}

const HEADER = "\u00a7"; // prefix marking a category header row
const HEADER_ROWS = 1.4; // a category header is this many species rows tall...
const GROUP_GAP = 0.2; // ...plus this much extra space above every group but the first
const ROW_PX = 17;
const DENSITY_FROM = 30; // spans this long are drawn as density strips, not ticks
const BIN_MINUTES = 15;

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
export function dayTimeline(rows, sun, dates, {spanDays = dates.length, categories, sort = "category", width, dark, daylightOnly = true}) {
  const n = dates.length;
  const density = spanDays >= DENSITY_FROM;
  const ref = sun[dates.at(-1)];
  const refStart = new Date(ref.start);
  const offset = (date, t) => +t - +new Date(sun[date].start); // ms since local midnight
  const onRef = (date, t) => new Date(+refStart + offset(date, t));

  const sunrise = new Date(ref.sunrise);
  const sunset = new Date(ref.sunset);
  const dayStart = refStart;
  const dayEnd = new Date(ref.end);
  const earliestSunrise = d3.min(dates, (date) => offset(date, new Date(sun[date].sunrise)));
  const latestSunset = d3.max(dates, (date) => offset(date, new Date(sun[date].sunset)));
  const domain = daylightOnly
    ? [new Date(+refStart + earliestSunrise - 90 * 6e4), new Date(+refStart + latestSunset + 90 * 6e4)]
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
  let order;
  if (sort === "category") {
    // Grouped under category headers; within a group, by when the species usually starts singing.
    const groups = d3.groups([...firstHeard.keys()], categoryOf)
      .sort(([a], [b]) => (categories?.order.indexOf(a) ?? 0) - (categories?.order.indexOf(b) ?? 0));
    order = groups.flatMap(([group, species]) => [HEADER + group, ...species.sort(byFirst)]);
  } else {
    order = [...firstHeard.keys()].sort(sort === "count" ? byCount : byFirst);
  }
  const headers = order.filter((k) => k.startsWith(HEADER));

  // Lay rows out by hand (in units of one species row) so headers get room above and below.
  const rowsAt = new Map(); // key -> {y1, y2, y}
  let pos = 0;
  for (const key of order) {
    const header = key.startsWith(HEADER);
    if (header && pos > 0) pos += GROUP_GAP;
    const h = header ? HEADER_ROWS : 1;
    rowsAt.set(key, {y1: pos, y2: pos + h, y: pos + h / 2});
    pos += h;
  }
  const total = pos;
  const rowOf = (species) => rowsAt.get(species);
  const speciesTicks = order.filter((k) => !k.startsWith(HEADER)).map((k) => rowsAt.get(k).y);
  const nameAt = new Map(order.map((k) => [rowsAt.get(k).y, k]));

  if (!firstHeard.size) return htl.html`<p class="sub">No detections ${daylightOnly ? "in daylight " : ""}${n === 1 ? "on this day" : "in these days"}.</p>`;

  const fade = n === 1 ? 1 : n <= 3 ? 0.6 : 0.4; // overlapping days stack up
  const hourStep = width < 480 ? 4 : width < 800 ? 2 : 1;
  const tipChannels = {Species: "species", Time: (d) => clock(d.time), Confidence: (d) => d3.format(".0%")(d.confidence)};
  if (n > 1) tipChannels.Day = (d) => formatDate(d.date, {weekday: "short", month: "short", day: "numeric"});

  let dataMarks;
  let color;
  if (density) {
    // Detections per day in each 15-minute slot of the reference day's clock.
    const bin = d3.timeMinute.every(BIN_MINUTES);
    const bins = d3.flatRollup(shown, (v) => v.length / n, (d) => d.species, (d) => +bin.floor(d.clock))
      .map(([species, t, rate]) => ({species, t1: new Date(t), t2: new Date(t + BIN_MINUTES * 6e4), rate}));
    color = sequential(dark, {legend: true, label: "Detections per day", zero: true});
    dataMarks = [
      Plot.rect(bins, {x1: "t1", x2: "t2", y1: (d) => rowOf(d.species).y1 + 0.12, y2: (d) => rowOf(d.species).y2 - 0.12, fill: "rate"}),
      Plot.tip(bins, Plot.pointer({
        x: (d) => new Date((+d.t1 + +d.t2) / 2), y: (d) => rowOf(d.species).y,
        channels: {Species: "species", Time: (d) => `${clock(d.t1)}–${clock(d.t2)}`, "Per day": (d) => d3.format(".2~f")(d.rate)},
        format: {x: false, y: false, fill: false, Species: true, Time: true, "Per day": true}
      }))
    ];
  } else {
    const confColor = confidenceColor(dark);
    dataMarks = [
      Plot.ruleX(shown, {x: "clock", y1: (d) => rowOf(d.species).y1 + 0.18, y2: (d) => rowOf(d.species).y2 - 0.18, stroke: (d) => confColor(d.confidence), strokeWidth: 1.5, strokeOpacity: fade}),
      Plot.tip(shown, Plot.pointer({
        x: "clock",
        y: (d) => rowOf(d.species).y,
        channels: tipChannels,
        format: {x: false, y: false, ...Object.fromEntries(Object.keys(tipChannels).map((k) => [k, true]))}
      }))
    ];
  }

  return Plot.plot({
    width,
    height: Math.round(total * ROW_PX) + 50,
    marginLeft: nameMargin(width),
    marginRight: 16,
    marginTop: 24,
    x: {type: "time", domain, ticks: d3.timeHour.every(hourStep), tickFormat: clockShort, label: null, grid: true},
    y: {domain: [total, 0], axis: null},
    color,
    marks: [
      // Night, when the full day is shown.
      daylightOnly ? null : Plot.rectX([[dayStart, sunrise], [sunset, dayEnd]], {x1: "0", x2: "1", fill: "currentColor", fillOpacity: 0.06}),
      Plot.ruleX([sunrise, sunset], {stroke: "currentColor", strokeOpacity: 0.35}),
      sunMarkers(sunrise, sunset),
      // Category headers: a small-caps label in place of a species name, level with a hairline across the plot.
      Plot.ruleY(headers, {y: (d) => rowsAt.get(d).y, stroke: "currentColor", strokeOpacity: 0.18}),
      Plot.text(headers, {y: (d) => rowsAt.get(d).y, text: (d) => d.slice(1).toUpperCase(), frameAnchor: "left", textAnchor: "end", lineAnchor: "middle", dx: -6, fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em"}),
      nameAxis(width, {tickFormat: (y) => nameAt.get(y)}, speciesTicks),
      ...dataMarks
    ]
  });
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

export function loadWeather() {
  return FileAttachment("../data/weather.json").json();
}

// Decreases in the changes chart: a dusty violet, validated against olive in both modes.
export function declineColor(dark) {
  return dark ? "#9a7bd0" : "#8257ad";
}

// Rain gets its own blue, validated against the olive series in both modes.
export function rainColor(dark) {
  return dark ? "#4a8ad6" : "#2f6fb0";
}

const MAX_BAR = 28; // px; wider days get air between bars instead of fatter bars
const BAR_SHARE = 0.7; // a bar fills at most this share of its day's slot

/** Inset on each side of a day's slot so bars keep a gap and never exceed MAX_BAR. */
export function dayInset(dates, width, gap = 0) {
  const frame = dayFrame(dates, width);
  const slot = (width - frame.marginLeft - frame.marginRight) / dates.length;
  return Math.max(gap, (slot - Math.min(MAX_BAR, slot * BAR_SHARE)) / 2);
}

/** Shared x layout for the per-day chart and the weather strips under it, so days line up. */
export function dayFrame(dates, width) {
  const halfDay = 12 * 36e5;
  return {
    width,
    marginLeft: 62,
    marginRight: 24, // room for the last date label, centered on the last day
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
export function temperatureStrip(dates, weather, {width}) {
  const days = dates.filter((d) => weather[d]).map((date) => ({date, day: new Date(date), ...weather[date], ...barSpan(date)}));
  const frame = dayFrame(dates, width);
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
      Plot.areaY(days, {x: "day", y1: "low", y2: "high", curve: "monotone-x", fill: `url(#${id})`, fillOpacity: 0.9}),
      Plot.tip(days, Plot.pointerX({
        x: "day", y: "high",
        channels: {Day: (d) => formatDate(d.date), High: (d) => `${Math.round(d.high)}°F`, Low: (d) => `${Math.round(d.low)}°F`},
        format: {x: false, y: false, Day: true, High: true, Low: true}
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
export function conditionsStrip(dates, weather, {width, dark}) {
  const days = dates.filter((d) => weather[d]).map((date) => {
    const w = weather[date];
    return {date, day: new Date(date), ...barSpan(date), precip: w.precip, level: rainLevel(w.precip), kind: weatherKind(w.code)};
  });
  const frame = dayFrame(dates, width);
  const slot = (width - frame.marginLeft - frame.marginRight) / dates.length;
  const wet = rainColor(dark);
  const strength = (precip) => 0.45 + 0.55 * Math.min(1, Math.sqrt(precip / 0.6));
  const describe = (d) => `${formatDate(d.date)}: ${d.kind[1]}${d.level ? `, ${d3.format(".2f")(d.precip)} in` : ""}`;

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
export function dayAxis(dates, {width, ticks, tickFormat}) {
  const frame = dayFrame(dates, width);
  return Plot.plot({...frame, height: 26, marginTop: 2, marginBottom: 22, x: {...frame.x, ticks, tickFormat}, y: {axis: null}, marks: [Plot.ruleY([0], {strokeOpacity: 0})]});
}

function barSpan(date) {
  const day = new Date(date);
  return {x1: new Date(+day - 12 * 36e5), x2: new Date(+day + 12 * 36e5)};
}
