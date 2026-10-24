---
title: Species
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

```js
import {loadDetections, loadPhotos, birdPhoto, hourTicks, confidenceInput, seriesColor, MUTED, formatHour, formatDate, guideHref} from "./components/birds.js";
```

```js
const all = await loadDetections();
const photos = await loadPhotos();
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
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

<div class="filters">${speciesIn}${confIn}</div>

```js
const sp = all.filter((d) => d.species === species);
const heard = sp.filter((d) => d.confidence >= minConf);
const daysHeard = new Set(heard.map((d) => d.date)).size;
const hours = d3.rollup(heard, (v) => v.length, (d) => d.hour);
const byHour = d3.range(24).map((hour) => ({hour, count: hours.get(hour) ?? 0}));
const peakHour = heard.length ? d3.greatest(byHour, (d) => d.count).hour : null;
```

```js
const photo = photos[species];
```

<div class="species-head">
  <div>
    <p class="eyebrow">Species</p>
    <h1>${species}</h1>
    <p class="sub"><i>${sp[0]?.scientific}</i> · ${html`<a href=${guideHref(species)} target="_blank" rel="noopener">All About Birds guide ↗</a>`}${photo ? html` · <a href=${photo.wikipedia} target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</p>
  </div>
  ${photo ? birdPhoto(species, photo) : ""}
</div>

<div class="grid grid-cols-4 stats">
  <div class="card">
    <h2>Detections</h2>
    <div class="big">${d3.format(",")(heard.length)}</div>
    <div class="sub">${formatDate(dataStart)} – ${formatDate(latest)}</div>
  </div>
  <div class="card">
    <h2>Days heard</h2>
    <div class="big">${daysHeard}</div>
  </div>
  <div class="card">
    <h2>First and last heard</h2>
    <div class="big">${heard.length ? `${formatDate(heard[0].date)} – ${formatDate(heard.at(-1).date)}` : "–"}</div>
  </div>
  <div class="card">
    <h2>Busiest hour</h2>
    <div class="big">${peakHour === null ? "–" : formatHour(peakHour)}</div>
  </div>
</div>

${heard.length ? "" : html`<p class="sub">No detections at or above ${d3.format(".0%")(minConf)} confidence. Try lowering the threshold.</p>`}

<div class="card">
  ${resize((width) => Plot.plot({
    width,
    height: 220,
    x: {domain: [new Date(dataStart), d3.utcDay.offset(new Date(latest), 1)], label: null},
    y: {label: "Detections per week", grid: true, tickFormat: "s"},
    marks: [
      Plot.rectY(heard, Plot.binX({y: "count"}, {x: (d) => new Date(d.date), interval: d3.utcWeek, fill: seriesColor(dark), insetLeft: 1, insetRight: 1, ry2: 2, tip: true})),
      Plot.ruleY([0], {strokeOpacity: 0.3})
    ]
  }))}
</div>

<div class="grid grid-cols-2">
  <div class="card">
    ${resize((width) => Plot.plot({
      width,
      height: 220,
      x: {domain: d3.range(24), ticks: hourTicks(width), tickFormat: formatHour, label: "Hour (Pacific)", labelAnchor: "center", labelArrow: "none"},
      y: {label: "Detections", grid: true, tickFormat: "s"},
      marks: [
        Plot.barY(byHour, {x: "hour", y: "count", fill: seriesColor(dark), insetLeft: 1, insetRight: 1, ry2: 2, tip: {format: {x: formatHour}}}),
        Plot.ruleY([0], {strokeOpacity: 0.3})
      ]
    }))}
  </div>
  <div class="card">
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
  ${Inputs.table(heard.slice(-200).reverse(), {
    select: false,
    rows: 10,
    // Clips come later; until some exist the column would just be empty.
    columns: sp.some((d) => d.clip) ? ["time", "confidence", "clip"] : ["time", "confidence"],
    header: {time: "Time", confidence: "Confidence", clip: "Clip"},
    format: {
      time: (t) => t.toLocaleString("en-US", {timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}).replace(" AM", "a").replace(" PM", "p"),
      confidence: d3.format(".0%"),
      clip: (c) => (c ? htl.html`<audio controls preload="none" src=${c}></audio>` : "–")
    }
  })}
</div>
