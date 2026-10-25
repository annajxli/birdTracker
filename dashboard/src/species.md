---
title: Species
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

```js
import {loadDetections, loadPhotos, birdPhoto, minutesHeard, dateSpan, sequential, dateRange, confidenceInput, seriesColor, MUTED, formatHour, formatDate, guideHref, clipPlayer} from "./components/birds.js";
```

```js
const [all, photos] = await Promise.all([loadDetections(), loadPhotos()]);
if (!all.length) {
  // Nothing recorded yet: say so, and leave the rest of the page waiting instead of erroring.
  display(html`<p class="sub">No recordings yet. Detections show up here once the recorder has sent some audio.</p>`);
  await new Promise(() => {});
}
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
const heardRange = dateRange(dataStart, latest).split(" – ");
const byCount = d3.rollups(all, (v) => v.length, (d) => d.species)
  .sort((a, b) => d3.descending(a[1], b[1]))
  .map(([s]) => s);
```

```js
const requested = new URLSearchParams(location.search).get("name");
const speciesIn = Inputs.select(byCount, {label: "Species", value: byCount.includes(requested) ? requested : byCount[0]});
const species = Generators.input(speciesIn);
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
```

```js
// Keep the URL in sync so a species page can be bookmarked or shared.
history.replaceState(null, "", `?name=${encodeURIComponent(species)}`);
```

<div class="filters species-filters">${speciesIn}${confIn}</div>

```js
const sp = all.filter((d) => d.species === species);
const heard = sp.filter((d) => d.confidence >= minConf);
// Counted in minutes heard: minutes with at least one detection, not raw 3-second detections.
const heardMinutes = minutesHeard(heard);
const daysHeard = new Set(heard.map((d) => d.date)).size;
const hours = d3.rollup(heardMinutes, (v) => v.length, (d) => d.hour);
const byHour = d3.range(24).map((hour) => ({hour, count: hours.get(hour) ?? 0}));
const peakHour = heard.length ? d3.greatest(byHour, (d) => d.count).hour : null;
```

```js
const photo = photos[species];
```

<div class="species-summary">
<div class="species-head">
  <div>
    <p class="eyebrow">Species</p>
    <h1>${species}</h1>
    <p class="sub"><i>${sp[0]?.scientific}</i> · ${html`<a href=${guideHref(species)} target="_blank" rel="noopener">All About Birds guide ↗</a>`}${photo ? html` · <a href=${photo.wikipedia} target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</p>
  </div>
  <div class="species-photo-slot">${birdPhoto(species, photo)}</div>
</div>

<div class="grid grid-cols-4 stats">
  <div class="card">
    <h2>Minutes heard</h2>
    <div class="stat-content">
    <div class="big">${d3.format(",")(heardMinutes.length)}</div>
    <div class="sub date date-range"><span>${heardRange[0]}</span>${heardRange.length > 1 ? html`<span class="date-end"> – ${heardRange[1]}</span>` : ""}</div>
    </div>
  </div>
  <div class="card">
    <h2>Days heard</h2>
    <div class="stat-content">
    <div class="big">${daysHeard}</div>
    </div>
  </div>
  <div class="card">
    <h2>First and last heard</h2>
    <div class="stat-content">
    <div class="big">${heard.length ? `${formatDate(heard[0].date)} – ${formatDate(heard.at(-1).date)}` : "–"}</div>
    </div>
  </div>
  <div class="card">
    <h2>Busiest hour</h2>
    <div class="stat-content">
    <div class="big">${peakHour === null ? "–" : formatHour(peakHour)}</div>
    </div>
  </div>
</div>

</div>

${heard.length ? "" : html`<p class="sub">No detections at or above ${d3.format(".0%")(minConf)} confidence. Try lowering the threshold.</p>`}

```js
const calendarDays = dateSpan(dataStart, latest);
const recordedDays = new Set(all.map((d) => d.date));
// Count distinct wall-clock minutes so the repeated DST hour still fits 0–60.
const minutesByHour = d3.rollup(heardMinutes,
  (v) => new Set(v.map((d) => d.time.getUTCMinutes())).size,
  (d) => d.date, (d) => d.hour);
const calendar = calendarDays.flatMap((date) => d3.range(24).map((hour) => ({
  date, hour,
  minutes: minutesByHour.get(date)?.get(hour) ?? 0,
  recorded: recordedDays.has(date)
})));
```

<section class="zoom">
  <div class="section-top">
    <p class="eyebrow">When this species is heard</p>
    <p class="sub section-sub">${dateRange(dataStart, latest)}</p>
  </div>
  <div class="card">
    <div class="chart-slot species-calendar" style="--chart-height: 368px" tabindex="0" role="region" aria-label="Daily and hourly activity calendar; scroll horizontally to explore dates">
      ${resize((width) => {
        const plotWidth = Math.max(width, calendarDays.length * 3 + 60);
        const ticks = d3.utcMonth.range(new Date(dataStart), d3.utcDay.offset(new Date(latest), 1)).map((d) => d.toISOString().slice(0, 10));
        return Plot.plot({
          width: plotWidth,
          height: 330,
          marginLeft: 44,
          marginRight: 8,
          marginTop: 8,
          marginBottom: 36,
          x: {type: "band", domain: calendarDays, ticks, tickFormat: (d) => formatDate(d, d.endsWith("-01-01") ? {month: "short", year: "numeric"} : {month: "short"}), label: null, tickSize: 0, padding: 0},
          y: {type: "band", domain: d3.range(24), ticks: [0, 3, 6, 9, 12, 15, 18, 21], tickFormat: formatHour, label: null, tickSize: 0, padding: 0},
          color: sequential(dark, {type: "sqrt", domain: [0, 60], legend: true, label: "Minutes heard per hour", ticks: [0, 60], marginLeft: 8, marginRight: 8}),
          marks: [
            Plot.cell(calendar.filter((d) => d.recorded), {
              x: "date", y: "hour", fill: "minutes", inset: 0.5,
              channels: {Day: (d) => formatDate(d.date, {month: "short", day: "numeric", year: "numeric"}), Hour: (d) => `${formatHour(d.hour)}–${formatHour((d.hour + 1) % 24)}`, "Minutes heard": "minutes"},
              tip: {format: {x: false, y: false, fill: false, Day: true, Hour: true, "Minutes heard": true}}
            })
          ]
        });
      })}
    </div>
  </div>
</section>

<div class="grid grid-cols-2">
  <div class="card">
    <div class="chart-slot chart-slot-legend">
    ${resize((width) => Plot.plot({
      width,
      height: 220,
      x: {domain: [0.25, 1], tickFormat: ".0%", label: "BirdNET confidence"},
      y: {label: "Detections", grid: true, tickFormat: "s"},
      marks: [
        Plot.rectY(sp, Plot.binX({y: "count"}, {x: "confidence", thresholds: d3.range(0.25, 1.0001, 0.05), fill: (d) => (d.confidence >= minConf ? "shown" : "below threshold"), insetLeft: 1, insetRight: 1, ry2: 2, tip: {format: {x: ".0%"}}})),
        Plot.ruleX([minConf], {stroke: "currentColor", strokeWidth: 1.5}),
        Plot.ruleY([0], {strokeOpacity: 0.3})
      ],
      color: {domain: ["shown", "below threshold"], range: [seriesColor(dark), MUTED], legend: true}
    }))}
    </div>
  </div>

<div class="card">
  <div class="table-slot" style="--table-height: 241px">
  ${Inputs.table(heard.slice(-200).reverse(), {
    select: false,
    rows: 10,
    // Clips come later; until some exist the column would just be empty.
    columns: sp.some((d) => d.clip) ? ["time", "confidence", "clip"] : ["time", "confidence"],
    header: {time: "Time", confidence: "Confidence", clip: "Clip"},
    format: {
      time: (t) => t.toLocaleString("en-US", {timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}).replace(" AM", "a").replace(" PM", "p"),
      confidence: d3.format(".0%"),
      clip: clipPlayer
    }
  })}
  </div>
</div>

</div>
