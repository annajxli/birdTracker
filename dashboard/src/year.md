---
title: Year
toc: false
---

<link rel="stylesheet" href="./components/birds.css">


```js
import {loadDetections, confidenceInput, seriesColor, sequential, speciesHref, nameMargin, nameAxis} from "./components/birds.js";
```

```js
const all = await loadDetections();
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
```

<div class="page-top">
  <h1>Who's around when</h1>
  <div class="filters">${confIn}</div>
</div>

```js
const week = (date) => d3.utcWeek.floor(new Date(date));
const heard = all.filter((d) => d.confidence >= minConf);

// Days per week the recorder was up, so a week with outages isn't read as "no birds".
const recordedDays = d3.rollup(new Set(all.map((d) => d.date)), (v) => v.length, (date) => +week(date));
const weeks = [...recordedDays.keys()].sort(d3.ascending).map((t) => new Date(t));

// For each species and week: share of recorded days it was heard.
const speciesWeekDays = d3.rollup(heard, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +week(d.date));
const presence = [];
for (const [species, byWeek] of speciesWeekDays) {
  for (const [t, days] of byWeek) presence.push({species, week: new Date(t), days, share: days / recordedDays.get(t)});
}

// Top 40 species by days heard; residents (heard most weeks) first, then visitors by when they peak.
const stats = d3.rollups(presence, (v) => ({
  days: d3.sum(v, (d) => d.days),
  weeks: v.length,
  center: d3.sum(v, (d) => +d.week * d.days) / d3.sum(v, (d) => d.days)
}), (d) => d.species);
const shown = stats.sort((a, b) => d3.descending(a[1].days, b[1].days)).slice(0, 40);
const resident = ([, s]) => s.weeks >= 0.75 * weeks.length;
const order = [
  ...shown.filter(resident).sort((a, b) => d3.descending(a[1].days, b[1].days)),
  ...shown.filter((d) => !resident(d)).sort((a, b) => d3.ascending(a[1].center, b[1].center))
].map(([s]) => s);
const shownSet = new Set(order);

// The same shares by month, for narrow screens where 52 week columns would be ~2px each.
const month = (date) => d3.utcMonth.floor(new Date(date));
const recordedMonthDays = d3.rollup(new Set(all.map((d) => d.date)), (v) => v.length, (date) => +month(date));
const months = [...recordedMonthDays.keys()].sort(d3.ascending).map((t) => new Date(t));
const monthPresence = [];
for (const [species, byMonth] of d3.rollup(heard.filter((d) => shownSet.has(d.species)), (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +month(d.date))) {
  for (const [t, days] of byMonth) monthPresence.push({species, week: new Date(t), days, share: days / recordedMonthDays.get(t)});
}
```

<div class="card">
  ${resize((width) => {
    const byMonth = width < 520;
    const fmt = (d, opts) => d.toLocaleDateString("en-US", {timeZone: "UTC", ...opts});
    return Plot.plot({
    width,
    height: order.length * 18 + 70,
    marginLeft: nameMargin(width),
    padding: 0,
    x: byMonth
      ? {type: "band", domain: months, tickFormat: (d) => (d.getUTCMonth() % 3 === 0 ? fmt(d, {month: "short"}) : ""), tickSize: 0, label: null}
      : {type: "band", domain: weeks, tickFormat: (d) => (d.getUTCDate() <= 7 ? fmt(d, {month: "short"}) : ""), tickSize: 0, label: null},
    y: {domain: order, label: null},
    color: sequential(dark, {legend: true, label: "Share of days heard", domain: [0, 1], tickFormat: ".0%"}),
    marks: [
      nameAxis(width),
      Plot.cell(byMonth ? monthPresence : presence.filter((d) => shownSet.has(d.species)), {
        x: "week", y: "species", fill: "share", inset: byMonth ? 1 : 0.5, href: (d) => speciesHref(d.species),
        tip: {format: {x: (d) => (byMonth ? fmt(d, {month: "long", year: "numeric"}) : `Week of ${fmt(d, {month: "short", day: "numeric"})}`), fill: ".0%"}}
      })
    ]
    });
  })}
</div>

```js
const speciesPerWeek = d3.rollup(heard, (v) => new Set(v.map((d) => d.species)).size, (d) => +week(d.date));
const richness = weeks.map((w) => ({week: w, species: speciesPerWeek.get(+w) ?? 0}));
```

<div class="card">
  ${resize((width) => Plot.plot({
    width,
    height: 200,
    x: {label: null},
    y: {label: "Species heard per week", grid: true, zero: true},
    marks: [
      Plot.areaY(richness, {x: "week", y: "species", fill: seriesColor(dark), fillOpacity: 0.1, curve: "monotone-x"}),
      Plot.lineY(richness, {x: "week", y: "species", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
      Plot.ruleY([0], {strokeOpacity: 0.3}),
      Plot.tip(richness, Plot.pointerX({x: "week", y: "species", format: {x: (d) => `Week of ${d.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric"})}`}}))
    ]
  }))}
</div>
