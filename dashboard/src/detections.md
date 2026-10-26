---
title: Detections
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

```js
import {includedDetection} from "./components/detection-policy.js";
import {loadDetections, loadPhotos, loadCategories, rangeInput, confidenceInput, RANGES, windowStart, speciesHref, speciesCards, speciesInfoFrom, minutesHeard, clipPlayer, postReview, reviewAt} from "./components/birds.js";
```

```js
// Every detection, rejected ones too (the table shows them, to undo); counts use `all`.
const everything = await loadDetections({includeRejected: true});
const all = everything.filter((d) => d.review !== "rejected");
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
// "" for missing clips and reviews: the table skips formatting null cells, and these need it.
const inRange = everything.filter((d) => (d.review || includedDetection(d, minConf)) && d.date >= start).reverse() // newest first
  .map((d) => ({...d, clip: d.clip ?? "", review: d.review ?? ""}));
const searchIn = Inputs.search(inRange, {placeholder: "Search species…", columns: ["species", "scientific"]});
const found = Generators.input(searchIn);
```

```js
// Tapping a species name opens its mini card (More details goes to its page).
const [photos, categories] = await Promise.all([loadPhotos(), loadCategories()]);
const rangeMinutes = d3.rollup(minutesHeard(inRange.filter((d) => d.review !== "rejected")), (v) => v.length, (d) => d.species);
const stopSpeciesCards = speciesCards(speciesInfoFrom({all, confident: all.filter((d) => includedDetection(d, minConf)), photos, categories,
  extraRows: (species) => [[range === "All time" ? "All time" : `Last ${range}`, `${d3.format(",")(rangeMinutes.get(species) ?? 0)} minutes heard`]]}));
invalidation.then(stopSpeciesCards);
```

<div class="section-top">
  <div class="filters">${rangeIn}${searchIn}</div>
</div>

```js
const narrow = width < 520;
// Review: Confirm or Reject a detection you've listened to; the verdict shows at once (the Pi
// applies it at its next review check). A rejected row is struck through, with Undo; it no longer
// counts anywhere on the site.
const reviewCell = (d) => {
  const cell = htl.html`<span class="review-cell"></span>`;
  const set = (verdict) => {
    d.review = verdict ?? ""; // never null: the table skips formatting null cells when it re-renders
    cell.className = `review-cell${verdict ? ` is-${verdict}` : ""}`;
    const button = (label, v, cls = "") => Object.assign(htl.html`<button type="button" class="review-button ${cls}">${label}</button>`, {
      onclick: async () => { set(v); if (!(await postReview(v, [{at: reviewAt(d.time), scientific: d.scientific}]))) cell.title = "Couldn't save this; try again"; }
    });
    cell.replaceChildren(...(verdict === "rejected" ? [htl.html`<span class="review-state">Rejected</span>`, button("Undo", null)]
      : verdict === "confirmed" ? [htl.html`<span class="review-state">✓ Confirmed</span>`, button("Undo", null)]
      : [button("Confirm", "confirmed", "is-confirm"), button("Reject", "rejected", "is-reject")]));
  };
  set(d.review || null);
  return cell;
};
const clock = (t) => t.toLocaleString("en-US", {timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})
  .replace(" AM", "a").replace(" PM", "p");
```

<div class="card">
  <div class="table-slot">
  ${Inputs.table(found, {
    select: false,
    rows: 25,
    // Clips come later; until some exist the column would just be empty.
    columns: found.some((d) => d.clip) ? ["time", "species", "confidence", "clip", "review"] : ["time", "species", "confidence"],
    header: {time: "Time", species: "Species", confidence: narrow ? "Conf." : "Confidence", clip: "Clip", review: "Review"},
    ...(narrow ? {layout: "fixed", width: {time: 104, confidence: 40}} : {layout: "auto"}),
    format: {
      // Within the week Live keeps, the time opens Live at that moment.
      time: (t) => (Date.now() - t < 7 * 864e5 ? htl.html`<a href=${`./live?t=${reviewAt(t)}`} title="Play this in Live">${clock(t)}</a>` : clock(t)),
      species: (s) => htl.html`<a href=${speciesHref(s)}>${s}</a>`,
      confidence: d3.format(".0%"),
      clip: clipPlayer,
      review: (_, i, data) => (data[i].clip ? reviewCell(data[i]) : "–") // only where there's a clip to hear
    }
  })}
  </div>
</div>
