---
title: Detections
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

```js
import {loadDetections, loadPhotos, loadCategories, rangeInput, confidenceInput, RANGES, windowStart, speciesHref, speciesCards, speciesInfoFrom, minutesHeard} from "./components/birds.js";
```

```js
const all = await loadDetections();
if (!all.length) {
  // Nothing recorded yet: say so, and leave the rest of the page waiting instead of erroring.
  display(html`<p class="sub">No recordings yet. Detections show up here once the recorder has sent some audio.</p>`);
  await new Promise(() => {});
}
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
```

```js
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
const rangeIn = rangeInput("30 days");
const range = Generators.input(rangeIn);
```

<div class="page-top">
  <h1>Detections</h1>
  <div class="filters">${confIn}</div>
</div>

```js
const start = windowStart(latest, RANGES.get(range), dataStart);
const inRange = all.filter((d) => d.confidence >= minConf && d.date >= start).reverse(); // newest first
const searchIn = Inputs.search(inRange, {placeholder: "Search species…", columns: ["species", "scientific"]});
const found = Generators.input(searchIn);
```

```js
// Tapping a species name opens its mini card (More details goes to its page).
const [photos, categories] = await Promise.all([loadPhotos(), loadCategories()]);
const rangeMinutes = d3.rollup(minutesHeard(inRange), (v) => v.length, (d) => d.species);
const stopSpeciesCards = speciesCards(speciesInfoFrom({all, confident: all.filter((d) => d.confidence >= minConf), photos, categories,
  extraRows: (species) => [[range === "All time" ? "All time" : `Last ${range}`, `${d3.format(",")(rangeMinutes.get(species) ?? 0)} minutes heard`]]}));
invalidation.then(stopSpeciesCards);
```

<div class="section-top">
  <div class="filters">${rangeIn}${searchIn}</div>
</div>

```js
const narrow = width < 520;
const clock = (t) => t.toLocaleString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})
  .replace(" AM", "a").replace(" PM", "p");
```

<div class="card">
  <div class="table-slot">
  ${Inputs.table(found, {
    select: false,
    rows: 25,
    // Clips come later; until some exist the column would just be empty.
    columns: found.some((d) => d.clip) ? ["time", "species", "confidence", "clip"] : ["time", "species", "confidence"],
    header: {time: "Time", species: "Species", confidence: narrow ? "Conf." : "Confidence", clip: "Clip"},
    ...(narrow ? {layout: "fixed", width: {time: 104, confidence: 40}} : {layout: "auto"}),
    format: {
      time: clock,
      species: (s) => htl.html`<a href=${speciesHref(s)}>${s}</a>`,
      confidence: d3.format(".0%"),
      clip: (c) => (c ? htl.html`<audio controls preload="none" src=${c}></audio>` : "–")
    }
  })}
  </div>
</div>
