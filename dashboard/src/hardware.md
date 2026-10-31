---
title: Hardware analytics
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- How well the recorder is doing its job: whether audio arrived (coverage), what it sounded
     like (background level), how it got here (wifi), and how fast it became detections
     (pipeline delay). One row per uploaded recording, from the recordings table. Above them, the
     indoor computer's health, from the status.json pipeline/publish.py writes there each minute
     (re-read while the page is open, so it's current without a rebuild). -->

```js
import {loadSun, detectionsTable, recordingsTable, seriesColor, sequential, formatDate, addDays, dateSpan, dateRange} from "./components/birds.js";
```

```js
// Re-fetched while the page is open: the Pi reports each minute, and uploads the recorder's
// tables every 10 minutes. Timers sleep in a background tab or on a sleeping laptop, so nothing is
// fetched while the page is hidden, and everything is fetched again the moment it's visible: the
// Unreachable cards never judge data from before the page was hidden. A failed fetch (the network
// still waking up) keeps the last good value instead of an older one.
const visible = () => new Promise((resolve) => {
  if (!document.hidden) return resolve();
  const shown = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", shown); resolve(); } };
  document.addEventListener("visibilitychange", shown);
});
const wait = (ms) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); document.removeEventListener("visibilitychange", done); resolve(); };
  const timer = setTimeout(done, ms);
  document.addEventListener("visibilitychange", done); // hidden: stop until visible; visible: fetch now
});
const every = (ms, load) => (async function* () {
  let last = null, first = true;
  for (;;) {
    if (!first) await visible(); // the first load runs even in a background tab, so the page isn't blank
    const value = await load(first);
    if (value != null || first) yield (last = value ?? last);
    first = false;
    await wait(ms);
  }
})();
// After the first load, a table that can't be fetched fresh keeps the last one, not the site's built copy.
const table = every(10 * 60e3, (first) => recordingsTable({fallback: first}).catch(() => null));
const detections = every(10 * 60e3, (first) => detectionsTable({fallback: first}).catch(() => null));
// The indoor computer's health, as of its last report (null if it hasn't reported).
const pi = every(60e3, () => fetch("/api/live/status.json", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).catch(() => null));
const sun = await loadSun();
// main's recent commits that changed the Pi's deployed files, newest first, from the site build.
const piCode = await FileAttachment("data/pi-code.json").json().catch(() => ({commits: []}));
```

```js
const col = (k) => table.getChild(k);
// The recorder's own rows only (the table may still hold simulated ones from before it ran).
// board_temp (°C, the ESP32's own sensor) and board_uptime (s since the board started) arrive once
// the firmware sends them; until then they're absent.
const optional = (k) => (table.schema.fields.some((f) => f.name === k) ? col(k) : null);
const boardTempCol = optional("board_temp"), boardUptimeCol = optional("board_uptime");
// packet_success (0–1, frames that made it onto wifi; after a reflash), and power_mw / tx_mw: an
// estimate of the draw from the power bank and its transmitting share (a model, from RSSI).
const packetCol = optional("packet_success"), powerCol = optional("power_mw"), txCol = optional("tx_mw");
const sentCol = optional("frames_sent"), droppedCol = optional("frames_dropped");
const recs = d3.range(table.numRows).filter((i) => !col("simulated").get(i)).map((i) => ({
  time: new Date(Number(col("time").get(i))), date: col("date").get(i), hour: col("hour").get(i), seconds: col("seconds").get(i),
  rms: col("rms").get(i), rssi: col("rssi").get(i), upload: col("upload").get(i), delay: col("delay").get(i),
  boardTemp: boardTempCol?.get(i) ?? null, boardUptime: boardUptimeCol?.get(i) ?? null,
  packet: packetCol?.get(i) ?? null, power: powerCol?.get(i) ?? null, tx: txCol?.get(i) ?? null,
  sent: sentCol?.get(i) ?? null, dropped: droppedCol?.get(i) ?? null
}));
```

```js
const hasRecs = recs.length > 0;
const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
const latest = d3.max(recs, (d) => d.date) ?? today;
const DAYS = 90;
const from = addDays(latest, -(DAYS - 1));
const span = dateSpan(from, latest);
const recent = recs.filter((d) => d.date >= from);
const windowX = {type: "utc", label: null, domain: [new Date(from), d3.utcDay.offset(new Date(latest), 1)]};
const byDate = d3.group(recent, (d) => d.date);
const windowStart = d3.min(recent, (d) => d.date) ?? from; // the window's first recorded day
// Uptime: the share of the time since launch that audio arrived. Up to the newest recording, as
// the table arrives in 10-minute batches, but no further back than 15 minutes ago, so a recorder
// that stops shows it.
const LAUNCH = Date.parse("2026-10-25T23:11:00Z"); // when the recorder's telemetry began (4:11 PM)
const dataEnd = d3.max(recs, (d) => +d.time + d.seconds * 1e3) ?? Date.now();
const upFrom = LAUNCH, upTo = Math.max(dataEnd, Date.now() - 15 * 60e3);
const uptime = upTo > upFrom ? d3.sum(recent, (d) => (+d.time >= upFrom ? d.seconds : 0)) * 1e3 / (upTo - upFrom) : 0;
const daily = span.filter((d) => byDate.has(d)).map((date) => {
  const v = byDate.get(date);
  return {date: new Date(date), day: date,
    rmsLow: d3.quantile(v, 0.1, (d) => d.rms), rms: d3.median(v, (d) => d.rms), rmsHigh: d3.quantile(v, 0.9, (d) => d.rms),
    rssi: d3.median(v, (d) => d.rssi), upload: d3.median(v, (d) => d.upload),
    delay: d3.median(v, (d) => d.delay) / 60, delay95: d3.quantile(v, 0.95, (d) => d.delay) / 60};
});
// Minutes of audio received per day and hour.
const coverage = d3.rollups(recent, (v) => d3.sum(v, (d) => d.seconds) / 60, (d) => d.date, (d) => d.hour)
  .flatMap(([date, hours]) => hours.map(([hour, minutes]) => ({date: new Date(date), day: date, hour, minutes: Math.min(60, minutes)})));
const wallHours = (iso) => { const [h, m] = new Date(iso).toLocaleTimeString("en-GB", {timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit"}).split(":"); return +h + m / 60; };
const sunLines = span.filter((d) => sun[d]).map((d) => ({date: new Date(d), sunrise: wallHours(sun[d].sunrise), sunset: wallHours(sun[d].sunset)}));
const fmtDay = (d) => formatDate(d.toISOString().slice(0, 10));
const last = recs.at(-1);
const detDate = detections.getChild("date"), detConf = detections.getChild("confidence");
const clock = (iso) => new Date(iso).toLocaleString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
// BirdNET's confidence for each detection in the window, for the distribution card.
const detTime = detections.getChild("time");
const detReview = detections.schema.fields.some((f) => f.name === "review") ? detections.getChild("review") : null; // rejected ones don't count
const confRows = d3.range(detections.numRows).filter((i) => detDate.get(i) >= from && detReview?.get(i) !== "rejected").map((i) => ({at: new Date(Number(detTime.get(i))), confidence: detConf.get(i)}));
const confidences = confRows.map((d) => d.confidence);
const THRESHOLD = 0.6;
const confMedian = d3.median(confidences);
const confFrom = d3.min(d3.range(detections.numRows).filter((i) => detDate.get(i) >= from && detReview?.get(i) !== "rejected"), (i) => detDate.get(i)); // first day counted
// Packet success over many minutes, pooled (all frames sent over all frames recorded), so a short
// minute counts for its frames, not as much as a full one. From the frame counts when exported,
// else each minute's share weighted by its seconds (close, as frames recorded follow time on).
// As a percentage, or NaN. Minutes that start in the recorder's first minute after it boots don't
// count: it records before its connection is up, so those frames are lost to the boot, not the radio.
const BOOT_SKIP_S = 60;
function pooledPacket(rows) {
  rows = rows.filter((d) => d.packet != null && !(d.boardUptime != null && d.boardUptime < BOOT_SKIP_S));
  if (!rows.length) return NaN;
  const counted = rows.filter((d) => d.sent != null && d.dropped != null); // older rows lack the counts
  if (counted.length) {
    const sent = d3.sum(counted, (d) => d.sent), all = sent + d3.sum(counted, (d) => d.dropped);
    return all ? (100 * sent) / all : NaN;
  }
  const weight = d3.sum(rows, (d) => d.seconds);
  return weight ? (100 * d3.sum(rows, (d) => d.packet * d.seconds)) / weight : NaN;
}
// The last 24 hours (since launch, if that's sooner) in 5-minute steps, up to the newest recording.
const STEP = 5 * 60e3;
const dayStart = Math.max(LAUNCH, dataEnd - 24 * 3600e3);
const bySlot = d3.group(recs.filter((d) => +d.time >= dayStart), (d) => Math.floor((+d.time - dayStart) / STEP));
const slots = d3.range(Math.max(1, Math.ceil((dataEnd - dayStart) / STEP))).map((i) => {
  const v = bySlot.get(i), start = dayStart + i * STEP;
  return {start: new Date(start), at: new Date(start + STEP / 2), end: new Date(start + STEP),
    received: v ? Math.min(100, (100 * d3.sum(v, (d) => d.seconds) * 1e3) / STEP) : 0,
    rssi: v ? d3.median(v, (d) => d.rssi) : NaN, rms: v ? d3.median(v, (d) => d.rms) : NaN, delay: v ? d3.median(v, (d) => d.delay) / 60 : NaN,
    boardTemp: v ? d3.median(v, (d) => d.boardTemp) ?? NaN : NaN,
    packet: v ? pooledPacket(v) : NaN, power: v ? d3.mean(v, (d) => d.power) ?? NaN : NaN};
});
```

```js
// Cards: each reading now (its value, a meter, its status) above its last 24 hours.
const piFresh = pi && Date.now() - Date.parse(pi.updated) < 5 * 60e3;
// The recorder's audio reaches this page in batches (the recordings table), so it counts as
// unreachable only once nothing has come for longer than a batch takes.
const RECORDER_STALE = 20 * 60e3;
const recorderFresh = hasRecs && Date.now() - dataEnd < RECORDER_STALE;
// A part with no recent data: a full-width card above its readings, which are from then.
const unreachable = (since) => html`<div class="card is-alert status-critical unreachable"><div class="big">Unreachable</div>
  <div class="sub">${statusTag("critical")} · no data since ${clock(since)} · readings below are from then</div></div>`;
const duration = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`; };
// Status: each level has its own shape and word, so it never rests on color alone.
const STATUS = {good: ["●", "Good"], warning: ["▲", "Okay"], critical: ["■", "Bad"]};
const statusTag = (level) => html`<span class="status status-${level}"><span class="status-icon" aria-hidden="true">${STATUS[level][0]}</span>${STATUS[level][1]}</span>`;
// A meter: the scale from its first zone's start to its last zone's end, in status zones
// ([from, to, level]), with a marker at the value. The zone holding the value is drawn solid,
// the others faint. Returns the meter and the value's level.
const zoneOf = (value, zones) => zones.find((z) => value < z[1]) ?? zones.at(-1);
const levelOf = (value, zones) => zoneOf(value, zones)[2];
const meter = (value, zones, format = (v) => v) => {
  const lo = zones[0][0], hi = zones.at(-1)[1], at = Math.max(lo, Math.min(hi, value));
  const zone = zoneOf(at, zones);
  const pct = (v) => `${(100 * (v - lo)) / (hi - lo)}%`;
  return {status: zone[2], node: html`<div class="meter" role="img" aria-label="${format(value)}: ${STATUS[zone[2]][1]}">
    <div class="meter-track">${zones.map((z) => html`<span class="meter-zone status-${z[2]}${z === zone ? " is-current" : ""}" style="width: ${pct(z[1] + lo - z[0])}"></span>`)}</div>
    <span class="meter-mark" style="left: ${pct(at)}"></span>
    <div class="meter-ticks">${zones.slice(1).map((z) => html`<span style="left: ${pct(z[0])}">${format(z[0])}</span>`)}</div>
  </div>`};
};
// A stat card with a meter: the value, the meter, its status and a note, then its recent history.
// A card whose status isn't Good gets its top bar in the status color.
const alertClass = (level) => (level && level !== "good" ? ` is-alert status-${level}` : "");
const meterCard = (title, big, m, note, history) => html`<div class="card${alertClass(m.status)}"><h2>${title}</h2><div class="big">${big}</div>${m.node}<div class="sub">${statusTag(m.status)}${note ? html` · ${note}` : ""}</div>${history ?? ""}</div>`;

const TEMP_ZONES = [[20, 70, "good"], [70, 80, "warning"], [80, 90, "critical"]];
const CPU_ZONES = [[0, 75, "good"], [75, 90, "warning"], [90, 100, "critical"]];
const MEMORY_ZONES = [[0, 80, "good"], [80, 92, "warning"], [92, 100, "critical"]];
const STORAGE_ZONES = [[0, 5, "critical"], [5, 15, "warning"], [15, 100, "good"]];
// Power: Bad while under-voltage or throttling is flagged now or was in the last hour of history,
// else Good. The since-boot flags don't count, so a fix shows as Good without a reboot; the
// history strip shows earlier trouble.
const piHistory = (pi?.history ?? []).map((h) => ({...h, at: new Date(h.at)}));
const lastHour = piHistory.filter((h) => +h.at >= Date.now() - 3600e3);
const powerShown = !pi?.throttled ? null
  : pi.throttled.under_voltage ? ["critical", "below 4.63 V now", "Under-voltage"]
  : pi.throttled.throttled ? ["critical", "CPU clock reduced now", "Throttled"]
  : lastHour.some((h) => h.under_voltage) ? ["critical", "below 4.63 V in the last hour", "Under-voltage"]
  : lastHour.some((h) => h.throttled) ? ["critical", "CPU clock reduced in the last hour", "Throttled"]
  : ["good", "no under-voltage or throttling in the last hour", "Normal"];
const hourTick = (d) => d.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric"});
const UPTIME_ZONES = [[50, 80, "critical"], [80, 95, "warning"], [95, 100, "good"]];
const WIFI_ZONES = [[-90, -80, "critical"], [-80, -70, "warning"], [-70, -40, "good"]];
const DELAY_ZONES = [[0, 3, "good"], [3, 10, "warning"], [10, 15, "critical"]];
// Packet success: below 98% of frames sent means audible holes.
const PACKET_ZONES = [[90, 98, "critical"], [98, 99.5, "warning"], [99.5, 100, "good"]];
// Energy from the power bank since local midnight, from the estimated draw (mWh; mAh at its 5 V).
const HOUR_MS = 3600e3;
const energyToday = () => {
  const noonUTC = Date.parse(new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"}) + "T08:00:00Z");
  const from = noonUTC - +new Date(noonUTC).toLocaleString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23"}) * HOUR_MS; // Pacific midnight
  return d3.sum(recs.filter((d) => d.power != null && +d.time >= from), (d) => (d.power * d.seconds) / 3600);
};
// The ESP32 is rated to 85 °C; its own sensor reads warm, so Okay starts well short of that.
const BOARD_TEMP_ZONES = [[-10, 65, "good"], [65, 80, "warning"], [80, 90, "critical"]];
// Background level is judged against the recorder's own usual level (its 7-day median), since
// what's normal depends on the spot: up to 6 dB louder Good, 6–12 Okay (noisy), more Bad (quiet
// calls masked). Near the mic's own noise floor (about −87 dBFS) is Bad too: a mic that's
// disconnected or failed reads like that. Plain bars until there's an hour of data to set "usual".
const MIC_FLOOR = -85;
const dbfs = (v) => `${d3.format(".0f")(v).replace("-", "−")} dBFS`;
const backgroundCard = () => {
  const lastWeek = recs.filter((d) => +d.time >= dataEnd - 7 * 864e5 && d.rms != null);
  const usual = lastWeek.length >= 60 ? d3.median(lastWeek, (d) => d.rms) : null;
  const now = d3.median(slots.slice(-12), (d) => d.rms);
  const fmt = (v) => `${d3.format(".1f")(v).replace("-", "−")} dBFS`;
  if (usual == null || now == null) return html`<div class="card"><h2>Background level</h2><div class="big">${now == null ? "–" : dbfs(now)}</div><div class="sub">median, last hour</div>${statusStrip(slots, "rms", null, fmt)}</div>`;
  const zones = [[-95, MIC_FLOOR, "critical"], [MIC_FLOOR, usual + 6, "good"], [usual + 6, usual + 12, "warning"], [usual + 12, -25, "critical"]];
  return meterCard("Background level", dbfs(now), meter(now, zones, (v) => d3.format(".0f")(v).replace("-", "−")), `median, last hour · usual ${dbfs(usual)}`, statusStrip(slots, "rms", zones, fmt));
};
const COVERAGE_ZONES = [[0, 80, "critical"], [80, 95, "warning"], [95, 100, "good"]];
// Recent history at the foot of a card: the last 24 hours in half-hour bars, each colored and
// sized by the status of its median reading (tall green, shorter amber, short red), so a good
// day is a row of full green bars; a faint stub where there's no data. A reading without status
// zones (zones null) gets plain bars sized by its value instead. Hover a bar for its value.
const HALF_HOUR = 30 * 60e3, BARS = 48;
const statusStrip = (rows, key, zones, format, reduce = d3.median, line = true, minSpan = 6) => {
  const start = Date.now() - BARS * HALF_HOUR;
  const byBar = d3.group(rows.filter((r) => r[key] != null && !Number.isNaN(r[key]) && +r.at >= start), (r) => Math.floor((+r.at - start) / HALF_HOUR));
  const medians = new Map([...byBar].map(([i, v]) => [i, reduce(v, (r) => r[key])]));
  const [lo, hi] = d3.extent(medians.values());
  const size = (m) => (hi > lo ? 20 + (80 * (m - lo)) / (hi - lo) : 60); // % of the strip's height
  // Over the bars, the half-hour values as a line, so trends show within a status; broken where
  // there's no data. Its range is the values' robust spread (quartiles ± 1.5 IQR, so a lone
  // spike doesn't flatten the rest; spikes clip at the edge), but never narrower than a tenth of
  // the meter's scale (minSpan, in the reading's units, without one), so a steady reading stays
  // flat instead of stretched.
  const vals = [...medians.values()].sort(d3.ascending);
  const [q1, q3] = [d3.quantileSorted(vals, 0.25), d3.quantileSorted(vals, 0.75)];
  let [l0, l1] = [Math.max(lo, q1 - 1.5 * (q3 - q1)), Math.min(hi, q3 + 1.5 * (q3 - q1))];
  const floor = zones ? (zones.at(-1)[1] - zones[0][0]) / 10 : minSpan;
  if (l1 - l0 < floor) { const c = (l0 + l1) / 2; [l0, l1] = [c - floor / 2, c + floor / 2]; }
  const y = (m) => 90 - 80 * Math.max(0, Math.min(1, (m - l0) / (l1 - l0)));
  const path = d3.range(BARS).map((i) => (medians.has(i) ? `${medians.has(i - 1) ? "L" : "M"}${i + 0.5},${y(medians.get(i))}` : "")).join("");
  const trend = line && medians.size > 1 ? html`<svg class="strip-line" viewBox="0 0 ${BARS} 100" preserveAspectRatio="none" aria-hidden="true"><path d="${path}"/></svg>` : "";
  return html`<div class="card-history"><div class="status-strip">${trend}${d3.range(BARS).map((i) => {
    const m = medians.get(i), when = clock(new Date(start + i * HALF_HOUR));
    if (m == null) return html`<span class="strip-bar" data-tip="${when}: no data"></span>`;
    if (!zones) return html`<span class="strip-bar is-plain" style="height: ${size(m)}%" data-tip="${when}: ${format(m)}"></span>`;
    const level = levelOf(m, zones);
    return html`<span class="strip-bar status-${level}" data-tip="${when}: ${format(m)}, ${STATUS[level][1].toLowerCase()}"></span>`;
  })}</div><div class="strip-axis"><span>24 h ago</span><span>now</span></div></div>`;
};
const STATUS_COLOR = {good: "#0ca30c", warning: "#fab219", critical: "#a82a2a"};
const pctOf = (part, whole) => (100 * part) / whole;
const memPct = pi?.memory_mb && pctOf(pi.memory_mb.used, pi.memory_mb.total);
const diskPct = pi?.disk_gb && pctOf(pi.disk_gb.free, pi.disk_gb.total);
// Memory and storage as shares, so they share the meters' zones; power trouble as a level
// (0 none, 1 throttled, 2 under-voltage), taken at its worst in each half hour.
const POWER_ZONES = [[0, 0.5, "good"], [0.5, 1.5, "warning"], [1.5, 2, "critical"]];
const powerText = ["normal", "throttled", "under-voltage"];
for (const h of piHistory) {
  if (h.under_voltage != null) h.power = h.under_voltage ? 2 : h.throttled ? 1 : 0;
  if (h.memory_mb_used != null && pi?.memory_mb) h.memory_pct = pctOf(h.memory_mb_used, pi.memory_mb.total);
  if (h.disk_gb_free != null && pi?.disk_gb) h.disk_pct = pctOf(h.disk_gb_free, pi.disk_gb.total);
}
// Detection confidence over the last 24 hours: one column per hour, confidence up the side in
// 0.05 steps, each cell shaded by its share of that hour's detections (so busy and quiet hours
// read alike); the dashboard's 0.6 threshold dashed. No status: BirdNET's scores run low for
// faint or distant calls, so there's no healthy level to judge against yet.
const CONF_LO = confidences.length ? Math.min(0.5, Math.floor(d3.min(confidences) * 10) / 10) : 0;
const confidenceDensity = () => {
  const end = Date.now(), start = end - 24 * 3600e3, HOUR = 3600e3, STEP = 0.05;
  const rows = confRows.filter((d) => +d.at >= start);
  if (!rows.length) return html`<div class="card-history"><p class="sub">No detections in the last 24 hours</p></div>`;
  const cells = [];
  for (const [h, v] of d3.group(rows, (d) => Math.floor((+d.at - start) / HOUR))) {
    for (const [b, w] of d3.group(v, (d) => Math.min(Math.floor((d.confidence - CONF_LO) / STEP), Math.round((1 - CONF_LO) / STEP) - 1))) {
      const y1 = CONF_LO + b * STEP;
      cells.push({x1: new Date(start + h * HOUR), x2: new Date(start + (h + 1) * HOUR), y1, y2: y1 + STEP, count: w.length, of: v.length, share: w.length / v.length});
    }
  }
  return html`<div class="card-history">${resize((width) => Plot.plot({
    width, height: 84, marginTop: 2, marginBottom: 2, marginLeft: 0, marginRight: 22,
    x: {type: "time", domain: [new Date(start), new Date(end)], axis: null},
    y: {domain: [CONF_LO, 1], ticks: [THRESHOLD, 1], tickFormat: (v) => d3.format(".1f")(v), tickSize: 0, tickPadding: 3, axis: "right", label: null},
    color: sequential(dark, {domain: [0, d3.max(cells, (c) => c.share)]}),
    marks: [
      Plot.rect(cells, {x1: "x1", x2: "x2", y1: "y1", y2: "y2", fill: "share", inset: 0.5}),
      Plot.ruleY([THRESHOLD], {stroke: "currentColor", strokeOpacity: 0.5, strokeDasharray: "3,2"}),
      Plot.tip(cells, Plot.pointer({x1: "x1", x2: "x2", y1: "y1", y2: "y2", title: (c) => `${clock(c.x1)}\nConfidence ${d3.format(".2f")(c.y1)}–${d3.format(".2f")(c.y2)}\n${c.count} of ${c.of} detections that hour`}))
    ]
  }))}<div class="strip-axis"><span>24 h ago</span><span>now</span></div></div>`;
};
const noData = (title) => html`<div class="card"><h2>${title}</h2><div class="big">–</div><div class="sub">No data yet</div></div>`;
const pctFormat = (v) => `${d3.format(".0f")(v)}%`;
// The Pi's software: the code deployed on it against main, and the operating system's pending
// updates (status.json's code and updates, absent until the Pi reports them). Code is matched
// on the fingerprint of the files the Pi runs, not the commit, since the Pi is often deployed from a
// branch that's later squash-merged.
const day = (iso) => new Date(iso).toLocaleDateString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric"});
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const softwareCard = (title, big, level, notes, details) => html`<div class="card${alertClass(level)}"><h2>${title}</h2><div class="big">${big}</div>
  <div class="sub">${statusTag(level)}${notes.filter(Boolean).map((n) => html` · ${n}`)}</div>${details ?? ""}</div>`;
const codeCard = (() => {
  const code = pi?.code;
  if (!code || !piCode.commits.length) return noData("Code version");
  // Deployments before the fingerprint left out unrun files reported all deployed files ("files").
  const at = piCode.commits.find((c) => c.fingerprint === code.fingerprint || c.files === code.fingerprint);
  // Only commits that changed what the Pi runs count, not tests or laptop-only scripts.
  const changed = piCode.commits.filter((c, i) => c.fingerprint !== piCode.commits[i + 1]?.fingerprint);
  const behind = at ? changed.findIndex((c) => c.fingerprint === at.fingerprint) : -1;
  const deployed = code.deployed_at && `deployed ${day(code.deployed_at)}`;
  const changes = code.changed && "with uncommitted changes";
  if (behind === 0) return softwareCard("Code version", "Up to date", "good", [`commit ${code.commit}`, deployed, changes]);
  if (behind > 0) {
    const missing = changed.slice(0, behind);
    return softwareCard("Code version", `${behind} behind main`, "warning", [plural(behind, "newer commit"), deployed, changes],
      html`<ul class="software-list">${missing.slice(0, 5).map((c) => html`<li><span>${c.title}</span><span class="sub">${day(c.committed_at)}</span></li>`)}${missing.length > 5 ? html`<li class="sub">${missing.length - 5} more</li>` : ""}</ul>`);
  }
  return softwareCard("Code version", "Not on main", "warning", [`commit ${code.commit}${code.branch ? ` on ${code.branch}` : ""}`, deployed, changes]);
})();
const updatesCard = (() => {
  const u = pi?.updates;
  if (!u) return noData("OS updates");
  const level = u.security || u.reboot_required ? "warning" : "good";
  return softwareCard("OS updates", u.upgradable ? plural(u.upgradable, "update") : "Up to date", level,
    [u.security ? `${u.security} security` : null, u.reboot_required ? "reboot required" : null, u.security && Date.parse(u.next_install) > Date.now() ? `install queued ${clock(u.next_install)}` : null, `checked ${day(u.checked)}`, u.lists_refreshed === false ? "package lists not refreshed; counts may be stale" : null],
    html`<div class="sub">${[u.os, u.kernel && `kernel ${u.kernel}`].filter(Boolean).join(" · ")}</div>${u.packages?.length ? html`<details class="software-packages"><summary>${u.packages.length < u.upgradable ? `First ${u.packages.length} packages` : "Packages"}</summary>
      <ul class="software-list">${u.packages.map((p) => html`<li><span>${p.name}${p.security ? html` <span class="status status-warning"><span class="status-icon" aria-hidden="true">▲</span>security</span>` : ""}</span><span class="sub">${p.from ? `${p.from} → ` : "new · "}${p.to}</span></li>`)}</ul></details>` : ""}`);
})();
// An open package list closes on a click outside it.
const closePackages = (e) => document.querySelectorAll(".software-packages[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
document.addEventListener("click", closePackages);
invalidation.then(() => document.removeEventListener("click", closePackages));
// The history bars' values, shown at once on hover (a title attribute waits about a second).
const stripTip = document.body.appendChild(html`<div class="strip-tip" hidden></div>`);
const showStripTip = (e) => {
  const bar = e.target.closest?.(".strip-bar[data-tip]");
  if (!bar) { stripTip.hidden = true; return; }
  const r = bar.getBoundingClientRect();
  stripTip.textContent = bar.dataset.tip;
  stripTip.hidden = false;
  const w = stripTip.offsetWidth;
  stripTip.style.left = `${Math.max(4, Math.min(document.documentElement.clientWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
  stripTip.style.top = `${r.top - stripTip.offsetHeight - 6}px`;
};
const hideStripTip = () => { stripTip.hidden = true; };
document.addEventListener("pointerover", showStripTip);
addEventListener("scroll", hideStripTip, {passive: true});
invalidation.then(() => { document.removeEventListener("pointerover", showStripTip); removeEventListener("scroll", hideStripTip); stripTip.remove(); });
const piSection = pi && html`<div class="grid stats">
  ${pi.temp_c != null ? meterCard("CPU temperature", `${d3.format(".0f")(pi.temp_c)} °C`, meter(pi.temp_c, TEMP_ZONES, (v) => `${v}°`), "CPU throttles at 80 °C", statusStrip(piHistory, "temp_c", TEMP_ZONES, (v) => `${v} °C`)) : ""}
  ${pi.cpu_percent != null ? meterCard("CPU in use", pctFormat(pi.cpu_percent), meter(pi.cpu_percent, CPU_ZONES, pctFormat), `1-min average · load ${pi.load?.[0] ?? "–"} on 4 cores`, statusStrip(piHistory, "cpu_percent", CPU_ZONES, pctFormat)) : ""}
  ${pi.memory_mb ? meterCard("Memory in use", `${d3.format(".0f")(pi.memory_mb.used)} MB`, meter(memPct, MEMORY_ZONES, pctFormat), `of ${d3.format(".0f")(pi.memory_mb.total)} MB`, statusStrip(piHistory, "memory_pct", MEMORY_ZONES, pctFormat)) : ""}
  ${pi.disk_gb ? meterCard("Storage free", `${d3.format(".1f")(pi.disk_gb.free)} GB`, meter(diskPct, STORAGE_ZONES, pctFormat), `of ${d3.format(".0f")(pi.disk_gb.total)} GB`, statusStrip(piHistory, "disk_pct", STORAGE_ZONES, pctFormat)) : ""}
  ${powerShown ? html`<div class="card${alertClass(powerShown[0])}"><h2>Power supply</h2><div class="big">${powerShown[2]}</div><div class="sub">${statusTag(powerShown[0])} · ${powerShown[1]}</div>${statusStrip(piHistory, "power", POWER_ZONES, (v) => powerText[v], d3.max, false)}</div>` : ""}
  ${pi.uptime_s != null ? html`<div class="card"><h2>Time since restart</h2><div class="big">${duration(pi.uptime_s)}</div><div class="sub">booted ${clock(new Date(Date.parse(pi.updated) - pi.uptime_s * 1e3))}</div></div>` : ""}
  ${codeCard}${updatesCard}
</div>`;

```

# Hardware analytics

<p class="sub">${hasRecs ? dateRange(windowStart, latest) : "No recorder data yet"}</p>

<!-- End to end: what both halves together deliver. -->
<div class="grid stats">
  ${confidences.length
    ? html`<div class="card"><h2>Detection confidence</h2><div class="big">${d3.format(".2f")(confMedian)}</div><div class="sub">median · IQR ${d3.format(".2f")(d3.quantile(confidences, 0.25))}–${d3.format(".2f")(d3.quantile(confidences, 0.75))} · ${d3.format(",")(confidences.length)} detections since ${formatDate(confFrom)}</div>${confidenceDensity()}</div>`
    : noData("Detection confidence")}
  ${hasRecs ? [
    meterCard("Uptime", d3.format(".1%")(Math.min(1, uptime)), meter(100 * Math.min(1, uptime), UPTIME_ZONES, pctFormat), `since ${clock(new Date(LAUNCH))}`, statusStrip(slots, "received", COVERAGE_ZONES, (v) => `${pctFormat(v)} received`)),
    meterCard("Recording → dashboard delay", `${d3.format(".1f")(d3.median(recent, (d) => d.delay) / 60)} min`, meter(d3.median(recent, (d) => d.delay) / 60, DELAY_ZONES, (v) => `${v}m`), `median since ${formatDate(windowStart)}`, statusStrip(slots, "delay", DELAY_ZONES, (v) => `${d3.format(".1f")(v)} min`))
  ] : ["Uptime", "Recording → dashboard delay"].map(noData)}
</div>

<div class="section-top"><p class="eyebrow">Outdoor recorder</p>${hasRecs ? html`<p class="sub section-sub">FireBeetle · last recording ${clock(last.time)}</p>` : ""}</div>
${hasRecs && !recorderFresh ? unreachable(dataEnd) : ""}
<div class="grid stats">
  ${hasRecs ? [
    meterCard("Wifi signal", `${d3.format(".0f")(d3.median(recent, (d) => d.rssi))} dBm`, meter(d3.median(recent, (d) => d.rssi), WIFI_ZONES, (v) => `${v}`.replace("-", "−")), `median since ${formatDate(windowStart)}`, statusStrip(slots, "rssi", WIFI_ZONES, (v) => `${d3.format(".0f")(v)} dBm`)),
    backgroundCard()
  ] : ["Wifi signal", "Background level"].map(noData)}
  ${(() => {
    const last = recs.findLast((d) => d.packet != null);
    const recent = recs.filter((d) => d.packet != null && +d.time >= dataEnd - HOUR_MS);
    const value = recent.length ? pooledPacket(recent) : NaN;
    return last && Number.isFinite(value)
      ? meterCard("Packet success", `${d3.format(".1f")(value)}%`, meter(value, PACKET_ZONES, (v) => `${v}%`), "frames sent over wifi, last hour", statusStrip(slots, "packet", PACKET_ZONES, (v) => `${d3.format(".1f")(v)}%`))
      : noData("Packet success");
  })()}
  ${(() => {
    const recent = recs.filter((d) => d.power != null && +d.time >= dataEnd - HOUR_MS);
    if (!recent.length) return noData("Power draw (estimate)");
    const mw = d3.mean(recent, (d) => d.power), tx = d3.mean(recent, (d) => d.tx);
    return html`<div class="card"><h2>Power draw (estimate)</h2><div class="big">${d3.format(",.0f")(mw)} mW</div><div class="sub">last hour · ${d3.format(".0f")(tx)} mW transmitting · ${d3.format(",.0f")(energyToday() / 5)} mAh / ${d3.format(",.0f")(energyToday())} mWh today</div>${statusStrip(slots, "power", null, (v) => `${d3.format(",.0f")(v)} mW`, d3.median, true, 50)}</div>`;
  })()}
  ${(() => {
    const board = recs.findLast((d) => d.boardTemp != null);
    return board
      ? meterCard("Board temperature", `${d3.format(".0f")(board.boardTemp)} °C`, meter(board.boardTemp, BOARD_TEMP_ZONES, (v) => `${v}°`), board.boardUptime != null ? `ESP32 sensor · booted ${clock(new Date(+board.time - board.boardUptime * 1e3))}` : "ESP32 sensor", statusStrip(slots, "boardTemp", BOARD_TEMP_ZONES, (v) => `${d3.format(".0f")(v)} °C`))
      : noData("Board temperature");
  })()}
</div>

<div class="section-top"><p class="eyebrow">Indoor computer</p>${pi ? html`<p class="sub section-sub">${pi.host} · last report ${clock(pi.updated)}${piFresh ? "" : " (over 5 min ago)"}</p>` : ""}</div>
${pi && !piFresh ? unreachable(pi.updated) : ""}
${pi ? piSection : html`<div class="card"><p class="sub">No data yet</p></div>`}

<div class="section-top"><p class="eyebrow">Coverage, last 90 days</p></div>
<div class="card"><div class="chart-slot" data-skeleton="grid" style="--chart-height: 330px">${resize((width) => Plot.plot({
  width, height: 260, marginLeft: 40, marginRight: 64,
  x: windowX,
  y: {domain: [24, 0], ticks: [0, 6, 12, 18, 24], tickFormat: (h) => ["12a", "6a", "12p", "6p", "12a"][h / 6], label: null},
  color: sequential(dark, {legend: true, label: "Minutes of audio received per hour", domain: [0, 60], marginLeft: 40, ticks: [0, 15, 30, 45, 60]}),
  marks: [
    Plot.rect(coverage, {x1: "date", x2: (d) => d3.utcDay.offset(d.date, 1), y1: "hour", y2: (d) => d.hour + 1, fill: "minutes", inset: 0.3,
      tip: {format: {x1: false, x2: false, y1: false, y2: false, fill: false}}, channels: {Day: (d) => formatDate(d.day), Hour: (d) => `${d.hour}:00`, Minutes: (d) => d3.format(".0f")(d.minutes)}}),
    ...["sunrise", "sunset"].flatMap((k) => [
      Plot.line(sunLines, {x: (d) => d3.utcHour.offset(d.date, 12), y: k, stroke: "#f4f1e8", strokeOpacity: 0.5, strokeWidth: 3.5}),
      Plot.line(sunLines, {x: (d) => d3.utcHour.offset(d.date, 12), y: k, stroke: "#1b1a17", strokeOpacity: 0.75, strokeWidth: 1.5, strokeDasharray: "4,3"})
    ]),
    Plot.text(sunLines.length ? ["sunrise", "sunset"] : [], {x: () => windowX.domain[1], y: (k) => sunLines.at(-1)[k], text: (k) => k, dx: 4, textAnchor: "start", fill: "currentColor", fontSize: 10})
  ]
}))}</div></div>

<div class="section-top"><p class="eyebrow">Background level, last 90 days</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 220px">${resize((width) => Plot.plot({
  width, height: 220, marginLeft: 50, marginRight: 110,
  x: windowX,
  y: {label: "Background level (dBFS)", grid: true},
  marks: [
    Plot.areaY(daily, {x: "date", y1: "rmsLow", y2: "rmsHigh", fill: seriesColor(dark), fillOpacity: 0.18, curve: "monotone-x"}),
    Plot.lineY(daily, {x: "date", y: "rms", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.text(daily.slice(-1), {x: "date", y: "rms", text: () => "median", dx: 6, textAnchor: "start", fill: "currentColor", fontSize: 10}),
    Plot.text(daily.slice(-1), {x: "date", y: "rmsHigh", text: () => "10th–90th percentile", dx: 6, dy: -6, textAnchor: "start", fill: "currentColor", fillOpacity: 0.7, fontSize: 10}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "rms", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".1f")(d.rms)} dBFS\n10th–90th percentile: ${d3.format(".0f")(d.rmsLow)} to ${d3.format(".0f")(d.rmsHigh)}`}))
  ]
}))}
</div></div>

<div class="grid grid-cols-2">
<div>
<div class="section-top"><p class="eyebrow">Wifi signal, last 90 days</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 200px">${resize((width) => Plot.plot({
  width, height: 200, marginLeft: 50,
  x: windowX,
  y: {label: "Wifi signal (dBm)", grid: true, domain: [-90, -40]},
  marks: [
    Plot.ruleY([-70], {stroke: "currentColor", strokeOpacity: 0.35, strokeDasharray: "4,3"}),
    Plot.text([-70], {y: (d) => d, frameAnchor: "left", dx: 4, dy: 8, text: () => "−70 dBm", fill: "currentColor", fillOpacity: 0.7, fontSize: 10, textAnchor: "start"}),
    Plot.lineY(daily, {x: "date", y: "rssi", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "rssi", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".0f")(d.rssi)} dBm`}))
  ]
}))}</div></div>
</div>
<div>
<div class="section-top"><p class="eyebrow">Recording → dashboard delay, last 90 days</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 200px">${resize((width) => Plot.plot({
  width, height: 200, marginLeft: 50, marginRight: 60,
  x: windowX,
  y: {label: "Delay (min)", grid: true, zero: true},
  marks: [
    Plot.lineY(daily, {x: "date", y: "delay95", stroke: "currentColor", strokeOpacity: 0.45, strokeWidth: 1.5, curve: "step"}),
    Plot.lineY(daily, {x: "date", y: "delay", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.text(daily.slice(-1), {x: "date", y: "delay", text: () => "median", dx: 6, textAnchor: "start", fill: "currentColor", fontSize: 10}),
    Plot.text(daily.length ? [d3.greatest(daily, (d) => d.delay95)] : [], {x: "date", y: "delay95", text: () => "95th percentile", dx: 6, dy: -7, textAnchor: "start", fill: "currentColor", fillOpacity: 0.7, fontSize: 10}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "delay", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".1f")(d.delay)} min\n95th percentile: ${d3.format(".0f")(d.delay95)} min`}))
  ]
}))}
</div>
</div>
</div>
</div>

<div class="pause-section">
<div class="section-top"><p class="eyebrow">Pause recording</p></div>
<div class="card pause-card">
  <p class="sub">Stops saving recorder audio. Takes effect within 2 minutes.</p>
  <form class="pause-form" id="pause-form">
    <label class="pause-field"><span>Control password</span><input type="password" name="password" autocomplete="current-password"></label>
    <select name="minutes" class="pause-field" aria-label="Duration">
      <option value="30">30 minutes</option>
      <option value="60" selected>1 hour</option>
      <option value="90">1.5 hours</option>
      <option value="120">2 hours</option>
    </select>
    <button type="submit" class="live-button" id="pause-start">Pause</button>
    <button type="button" class="live-button" id="pause-resume" hidden>Resume now</button>
  </form>
  <p class="sub" id="pause-status">Recording</p>
</div>
</div>

```js
// The recorder pause (deploy/password-worker.js /api/pause). Paused, Pause is grayed out until
// another duration is picked, which sets a new end from now; Resume now ends it.
{
  const form = document.getElementById("pause-form"), status = document.getElementById("pause-status");
  const start = document.getElementById("pause-start"), resume = document.getElementById("pause-resume");
  const show = (until) => {
    const paused = until && Date.parse(until) > Date.now();
    status.textContent = paused ? `Paused until ${new Date(until).toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"})}` : "Recording";
    start.disabled = !!paused;
    resume.hidden = !paused;
  };
  let until = null;
  const refresh = () => fetch("/api/pause", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { until = j.until; show(until); } }).catch(() => {});
  const send = async (minutes) => {
    start.disabled = resume.disabled = true;
    try {
      const password = form.password.value;
      form.password.value = ""; // never left filled in on the page
      const r = await fetch("/api/pause", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({password, minutes})});
      if (r.ok) { until = (await r.json()).until; show(until); return; }
      show(until);
      const error = (await r.json().catch(() => null))?.error;
      status.textContent = error === "password" ? "Wrong password" : "Couldn't change the pause. Try again.";
    } catch {
      show(until);
      status.textContent = "Couldn't change the pause. Try again.";
    } finally {
      resume.disabled = false;
    }
  };
  form.onsubmit = (e) => { e.preventDefault(); send(Number(form.minutes.value)); };
  // Opening the menu counts as picking, so the same duration can be picked again to extend.
  for (const type of ["change", "pointerdown", "keydown"]) form.minutes.addEventListener(type, () => { start.disabled = false; });
  resume.onclick = () => send(0);
  refresh();
  const timer = setInterval(() => { if (until && Date.parse(until) <= Date.now()) show(until = null); }, 15e3);
  invalidation.then(() => clearInterval(timer));
}
```
