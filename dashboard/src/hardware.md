---
title: Hardware analytics
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- How well the recorder is doing its job: whether audio arrived (coverage), what it sounded
     like (background level), how it got here (wifi), and how fast it became detections
     (pipeline delay). One row per uploaded recording, from the recordings table. Above them, the
     indoor computer's health, from the status.json pipeline/publish.py writes there each minute
     (read when the page opens, so it's current without a rebuild). -->

```js
import {loadSun, seriesColor, sequential, formatDate, addDays, dateSpan, dateRange} from "./components/birds.js";
```

```js
const table = await FileAttachment("data/recordings.parquet").parquet();
const col = (k) => table.getChild(k);
const recs = Array.from({length: table.numRows}, (_, i) => ({
  time: new Date(Number(col("time").get(i))), date: col("date").get(i), hour: col("hour").get(i), seconds: col("seconds").get(i),
  rms: col("rms").get(i), rssi: col("rssi").get(i), upload: col("upload").get(i), delay: col("delay").get(i)
}));
const sun = await loadSun();
// Share of BirdNET's detections below the dashboard's 0.6 confidence threshold.
const detections = await FileAttachment("data/detections.parquet").parquet();
const simulated = table.numRows > 0 && col("simulated").get(0);
// The indoor computer's health, as of its last report (null if it hasn't reported).
const pi = await fetch("/api/live/status.json", {cache: "no-store"}).then((r) => (r.ok ? r.json() : null)).catch(() => null);
```

```js
if (!recs.length) {
  display(html`<p class="sub">No recordings yet. This page fills in once the recorder uploads audio.</p>`);
  await new Promise(() => {});
}
const latest = d3.max(recs, (d) => d.date);
const DAYS = 90;
const from = addDays(latest, -(DAYS - 1));
const span = dateSpan(from, latest);
const recent = recs.filter((d) => d.date >= from);
const byDate = d3.group(recent, (d) => d.date);
// Uptime: the share of the time since recording began (within the window) that audio arrived.
const upFrom = d3.min(recent, (d) => +d.time), upTo = d3.max(recent, (d) => +d.time + d.seconds * 1e3);
const uptime = upTo > upFrom ? d3.sum(recent, (d) => d.seconds) * 1e3 / (upTo - upFrom) : 0;
const daily = span.filter((d) => byDate.has(d)).map((date) => {
  const v = byDate.get(date);
  return {date: new Date(date), day: date,
    hours: d3.sum(v, (d) => d.seconds) / 3600,
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
let detTotal = 0, detLow = 0;
for (let i = 0; i < detections.numRows; ++i) if (detDate.get(i) >= from) { ++detTotal; if (detConf.get(i) < 0.6) ++detLow; }
```

```js
// The indoor computer: its latest numbers as cards, and the last day of temperature and CPU use.
const piFresh = pi && Date.now() - Date.parse(pi.updated) < 5 * 60e3;
const duration = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`; };
const warnings = pi?.throttled ? [
  pi.throttled.under_voltage ? "under-voltage now" : pi.throttled.under_voltage_since_boot ? "under-voltage since boot" : null,
  pi.throttled.throttled ? "slowed down now" : pi.throttled.throttled_since_boot ? "slowed down since boot" : null
].filter(Boolean) : [];
const piHistory = (pi?.history ?? []).map((h) => ({...h, at: new Date(h.at)}));
const piChart = (key, label, domain, rule) => resize((width) => Plot.plot({
  width, height: 160, marginLeft: 44,
  x: {type: "time", label: null, tickFormat: (d) => d.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric"})},
  y: {label, grid: true, domain},
  marks: [
    rule ? Plot.ruleY([rule[0]], {stroke: "currentColor", strokeOpacity: 0.35, strokeDasharray: "4,3"}) : null,
    rule ? Plot.text([rule[0]], {y: (d) => d, frameAnchor: "left", dx: 4, dy: -6, text: () => rule[1], fill: "currentColor", fillOpacity: 0.7, fontSize: 10, textAnchor: "start"}) : null,
    Plot.lineY(piHistory.filter((h) => h[key] != null), {x: "at", y: key, stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.tip(piHistory.filter((h) => h[key] != null), Plot.pointerX({x: "at", y: key, title: (h) => `${clock(h.at)}\n${label}: ${h[key]}`}))
  ]
}));
const piSection = pi && html`<div class="grid stats" style="grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));">
  ${pi.temp_c != null ? html`<div class="card"><h2>Temperature</h2><div class="big">${d3.format(".0f")(pi.temp_c)} °C</div><div class="sub">the Pi slows itself down near 80 °C</div></div>` : ""}
  ${pi.cpu_percent != null ? html`<div class="card"><h2>CPU</h2><div class="big">${d3.format(".0f")(pi.cpu_percent)}%</div><div class="sub">busy over the last minute; load ${pi.load?.[0] ?? "–"}</div></div>` : ""}
  ${pi.memory_mb ? html`<div class="card"><h2>Memory</h2><div class="big">${d3.format(".0f")(pi.memory_mb.used)} MB</div><div class="sub">in use of ${d3.format(".0f")(pi.memory_mb.total)} MB</div></div>` : ""}
  ${pi.disk_gb ? html`<div class="card"><h2>Storage</h2><div class="big">${d3.format(".1f")(pi.disk_gb.free)} GB</div><div class="sub">free of ${d3.format(".0f")(pi.disk_gb.total)} GB</div></div>` : ""}
  ${pi.uptime_s != null ? html`<div class="card"><h2>Running for</h2><div class="big">${duration(pi.uptime_s)}</div><div class="sub">since it last started${warnings.length ? html`; <strong>${warnings.join(", ")}</strong>: check its power supply` : ""}</div></div>` : ""}
</div>
${piHistory.length > 1 ? html`<div class="grid grid-cols-2">
  <div class="card"><div class="chart-slot" style="--chart-height: 160px">${piChart("temp_c", "Temperature (°C)", [30, 85], [80, "slows down from here"])}</div></div>
  <div class="card"><div class="chart-slot" style="--chart-height: 160px">${piChart("cpu_percent", "CPU busy (%)", [0, 100])}</div></div>
</div>` : ""}`;
```

# Hardware analytics

<p class="sub">${dateRange(from, latest)}${simulated ? " · simulated until the recorder is running" : ""}</p>

<div class="grid stats" style="grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));">
  <div class="card"><h2>Low-confidence fraction</h2><div class="big">${d3.format(".0%")(detTotal ? detLow / detTotal : 0)}</div><div class="sub">of BirdNET detections are below the 0.6 threshold</div></div>
  <div class="card"><h2>Uptime</h2><div class="big">${d3.format(".1%")(Math.min(1, uptime))}</div><div class="sub">of the time since ${formatDate(new Date(upFrom).toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"}))} had audio</div></div>
  <div class="card"><h2>Audio per day</h2><div class="big">${d3.format(".1f")(d3.mean(daily, (d) => d.hours))} h</div><div class="sub">average on days recorded</div></div>
  <div class="card"><h2>Wifi signal</h2><div class="big">${d3.format(".0f")(d3.median(recent, (d) => d.rssi))} dBm</div><div class="sub">median; −70 or better is solid</div></div>
  <div class="card"><h2>Recording → dashboard delay</h2><div class="big">${d3.format(".1f")(d3.median(recent, (d) => d.delay) / 60)} min</div><div class="sub">median; latest recording ${last.time.toLocaleString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}</div></div>
</div>

<div class="section-top"><p class="eyebrow">Indoor computer</p>${pi ? html`<p class="sub section-sub">${pi.host} · ${piFresh ? "reported" : "no report since"} ${clock(pi.updated)}</p>` : ""}</div>
${pi ? piSection : html`<div class="card"><p class="sub">The indoor computer hasn't reported yet. Its health shows here once publish.py is running on it.</p></div>`}

<div class="section-top"><p class="eyebrow">Coverage</p></div>
<div class="card"><div class="chart-slot" data-skeleton="grid" style="--chart-height: 330px">${resize((width) => Plot.plot({
  width, height: 260, marginLeft: 40, marginRight: 64,
  x: {type: "utc", label: null},
  y: {domain: [24, 0], ticks: [0, 6, 12, 18, 24], tickFormat: (h) => ["12a", "6a", "12p", "6p", "12a"][h / 6], label: null},
  color: sequential(dark, {legend: true, label: "Minutes of audio received per hour", domain: [0, 60], marginLeft: 40, ticks: [0, 15, 30, 45, 60]}),
  marks: [
    Plot.rect(coverage, {x1: "date", x2: (d) => d3.utcDay.offset(d.date, 1), y1: "hour", y2: (d) => d.hour + 1, fill: "minutes", inset: 0.3,
      tip: {format: {x1: false, x2: false, y1: false, y2: false, fill: false}}, channels: {Day: (d) => formatDate(d.day), Hour: (d) => `${d.hour}:00`, Minutes: (d) => d3.format(".0f")(d.minutes)}}),
    Plot.line(sunLines, {x: (d) => d3.utcHour.offset(d.date, 12), y: "sunrise", stroke: "#1b1a17", strokeOpacity: 0.75, strokeWidth: 1.5, strokeDasharray: "4,3"}),
    Plot.line(sunLines, {x: (d) => d3.utcHour.offset(d.date, 12), y: "sunset", stroke: "#1b1a17", strokeOpacity: 0.75, strokeWidth: 1.5, strokeDasharray: "4,3"}),
    Plot.text([["sunrise", "sunrise"], ["sunset", "sunset"]], {x: () => sunLines.at(-1)?.date, y: ([, k]) => sunLines.at(-1)?.[k], text: ([k]) => k, dx: 10, textAnchor: "start", fill: "currentColor", fontSize: 10})
  ]
}))}</div></div>

<div class="section-top"><p class="eyebrow">Background level</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 220px">${resize((width) => Plot.plot({
  width, height: 220, marginLeft: 50, marginRight: 110,
  x: {type: "utc", label: null},
  y: {label: "Background level (dBFS)", grid: true},
  marks: [
    Plot.areaY(daily, {x: "date", y1: "rmsLow", y2: "rmsHigh", fill: seriesColor(dark), fillOpacity: 0.18, curve: "monotone-x"}),
    Plot.lineY(daily, {x: "date", y: "rms", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.text(daily.slice(-1), {x: "date", y: "rms", text: () => "daily median", dx: 6, textAnchor: "start", fill: "currentColor", fontSize: 10}),
    Plot.text(daily.slice(-1), {x: "date", y: "rmsHigh", text: () => "middle 80% of files", dx: 6, dy: -6, textAnchor: "start", fill: "currentColor", fillOpacity: 0.7, fontSize: 10}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "rms", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".1f")(d.rms)} dBFS\nQuietest–loudest 10%: ${d3.format(".0f")(d.rmsLow)} to ${d3.format(".0f")(d.rmsHigh)}`}))
  ]
}))}
</div>

<div class="grid grid-cols-2">
<div>
<div class="section-top"><p class="eyebrow">Wifi signal</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 200px">${resize((width) => Plot.plot({
  width, height: 200, marginLeft: 50,
  x: {type: "utc", label: null},
  y: {label: "Wifi signal (dBm)", grid: true, domain: [-90, -40]},
  marks: [
    Plot.ruleY([-70], {stroke: "currentColor", strokeOpacity: 0.35, strokeDasharray: "4,3"}),
    Plot.text([-70], {y: (d) => d, frameAnchor: "left", dx: 4, dy: 8, text: () => "weaker than −70: uploads slow down", fill: "currentColor", fillOpacity: 0.7, fontSize: 10, textAnchor: "start"}),
    Plot.lineY(daily, {x: "date", y: "rssi", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "rssi", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".0f")(d.rssi)} dBm\nUpload ${d3.format(".0f")(d.upload)} s per file`}))
  ]
}))}</div></div>
</div>
<div>
<div class="section-top"><p class="eyebrow">Recording → dashboard delay</p></div>
<div class="card"><div class="chart-slot" style="--chart-height: 200px">${resize((width) => Plot.plot({
  width, height: 200, marginLeft: 50, marginRight: 60,
  x: {type: "utc", label: null},
  y: {type: "log", label: "Minutes to the dashboard", grid: true},
  marks: [
    Plot.lineY(daily, {x: "date", y: "delay95", stroke: "currentColor", strokeOpacity: 0.45, strokeWidth: 1.5, curve: "step"}),
    Plot.lineY(daily, {x: "date", y: "delay", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
    Plot.text(daily.slice(-1), {x: "date", y: "delay", text: () => "median", dx: 6, textAnchor: "start", fill: "currentColor", fontSize: 10}),
    Plot.text([d3.greatest(daily, (d) => d.delay95)], {x: "date", y: "delay95", text: () => "slowest 5%", dx: 6, textAnchor: "start", fill: "currentColor", fillOpacity: 0.7, fontSize: 10}),
    Plot.tip(daily, Plot.pointerX({x: "date", y: "delay", title: (d) => `${formatDate(d.day)}\nMedian ${d3.format(".1f")(d.delay)} min\nSlowest 5%: ${d3.format(".0f")(d.delay95)} min`}))
  ]
}))}
</div>
</div>
</div>
