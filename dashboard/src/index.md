---
title: Overview
toc: false
---

<link rel="stylesheet" href="./components/birds.css">


```js
import {loadDetections, loadPhotos, loadSun, loadCategories, loadWeather, dayFrame, dayInset, declineColor, temperatureStrip, conditionsStrip, dayAxis, dayInput, dateKey, spanInput, SPANS, sortInput, SORTS, windowStart, dayTimeline, dayTicks, dayTickFormat, recentSpecies, birdCard, rangeInput, confidenceInput, nameMargin, nameAxis, RANGES, addDays, dateSpan, seriesColor, formatDate, speciesHref} from "./components/birds.js";
```

```js
const all = await loadDetections();
const photos = await loadPhotos();
const sun = await loadSun();
const categories = await loadCategories();
const weather = await loadWeather();
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
const recordedDates = new Set(all.map((d) => d.date));
```

```js
const rangeIn = rangeInput("30 days");
const range = Generators.input(rangeIn);
const weatherIn = Inputs.checkbox(["Conditions", "Temperature"], {label: "Weather", value: ["Conditions", "Temperature"]});
const weatherShown = Generators.input(weatherIn);
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
```

<div class="page-top">
  <h1>What's singing in the yard</h1>
  <div class="filters">${confIn}</div>
</div>

```js
const confident = all.filter((d) => d.confidence >= minConf);
const recent = recentSpecies(confident, {limit: 12});
```

<p class="eyebrow">Recently heard</p>
<div class="recent-row">${recent.map((r) => birdCard(r, photos[r.species]))}</div>

```js
const dayIn = dayInput([...recordedDates].sort());
const dayValue = Generators.input(dayIn);
const spanIn = spanInput();
const span = Generators.input(spanIn);
const daylightIn = Inputs.toggle({label: "Daylight only", value: true});
const sortIn = sortInput();
const sortBy = Generators.input(sortIn);
const daylightOnly = Generators.input(daylightIn);
```

```js
// Days that had recordings in the chosen span, ending on the chosen day.
const day = dateKey(dayValue);
const spanDates = day ? dateSpan(windowStart(day, SPANS.get(span), dataStart), day).filter((d) => recordedDates.has(d)) : [];
const spanDateSet = new Set(spanDates);
```

<section class="zoom">
  <div class="section-top">
    <p class="eyebrow">A day in the yard</p>
    <div class="filters">${spanIn}${sortIn}${dayIn}${daylightIn}</div>
  </div>
  <div class="card">
    ${spanDates.length
      ? resize((width) => dayTimeline(confident.filter((d) => spanDateSet.has(d.date)), sun, spanDates, {spanDays: SPANS.get(span), categories, sort: SORTS.get(sortBy), width, dark, daylightOnly}))
      : html`<p class="sub">No recordings ${SPANS.get(span) === 1 ? "on this day" : "in these days"}; the recorder was offline.</p>`}
  </div>
</section>

<section class="zoom">
  <div class="section-top">
    <div class="filters">${rangeIn}${weatherIn}</div>
  </div>
</section>

```js
const start = windowStart(latest, RANGES.get(range), dataStart);
const period = dateSpan(start, latest);
const rows = confident.filter((d) => d.date >= start);

const mostHeard = d3.greatest(d3.rollups(rows, (v) => v.length, (d) => d.species), ([, n]) => n);
const daysUp = period.filter((d) => recordedDates.has(d)).length;
const speciesCount = new Set(rows.map((d) => d.species)).size;
```

<div class="grid grid-cols-3 stats">
  <div class="card">
    <h2>Species heard</h2>
    <div class="big">${speciesCount}</div>
    <div class="sub">${formatDate(start)} – ${formatDate(latest)}</div>
  </div>
  <div class="card">
    <h2>Detections</h2>
    <div class="big">${d3.format(",")(rows.length)}</div>
    <div class="sub">${daysUp ? d3.format(",")(Math.round(rows.length / daysUp)) : 0} per recorded day</div>
  </div>
  <div class="card">
    <h2>Most heard</h2>
    <div class="big">${mostHeard ? html`<a class="stat-link" href=${speciesHref(mostHeard[0])}>${mostHeard[0]}</a>` : "–"}</div>
    <div class="sub">${mostHeard ? `${d3.format(",")(mostHeard[1])} detections` : "Nothing heard"}</div>
  </div>
</div>

```js
const perDay = d3.rollup(rows, (v) => v.length, (d) => d.date);
// Each bar spans noon-to-noon around its date, so it's centered on that date's axis tick.
const halfDay = 12 * 36e5;
const daily = period.map((date) => {
  const day = new Date(date);
  return {date, day, x1: new Date(+day - halfDay), x2: new Date(+day + halfDay), count: perDay.get(date) ?? 0, offline: !recordedDates.has(date)};
});
const gap = period.length <= 90 ? 1 : 0;
```

<div class="card day-stack">
  ${resize((width) => {
    const ticks = dayTicks(period, width - 74);
    const tickFormat = dayTickFormat(period);
    const frame = dayFrame(period, width);
    const inset = dayInset(period, width, gap);
    // Strips under the detections, top to bottom.
    const strips = [
      weatherShown.includes("Conditions") ? conditionsStrip(period, weather, {width, dark}) : null,
      weatherShown.includes("Temperature") ? temperatureStrip(period, weather, {width}) : null
    ].filter(Boolean);
    const detections = Plot.plot({
      ...frame,
      height: strips.length ? 200 : 230,
      marginTop: 10,
      marginBottom: strips.length ? 6 : 30,
      x: {...frame.x, ...(strips.length ? {axis: null} : {ticks, tickFormat})},
      y: {label: "Detections per day", labelAnchor: "center", labelArrow: "none", grid: true, tickFormat: "s"},
      marks: [
        Plot.rectY(daily.filter((d) => !d.offline), {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: inset, insetRight: inset, ry2: gap ? 2 : 0, channels: {Day: (d) => formatDate(d.date)}, tip: {format: {Day: true, x1: false, x2: false, y: ","}}}),
        Plot.ruleY([0], {strokeOpacity: 0.3})
      ]
    });
    return html`<div>${detections}${strips}${strips.length ? dayAxis(period, {width, ticks, tickFormat}) : ""}</div>`;
  })}
</div>

```js
const top = d3.rollups(rows, (v) => v.length, (d) => d.species)
  .sort((a, b) => d3.descending(a[1], b[1]))
  .slice(0, 15)
  .map(([species, count]) => ({species, count}));
```

<div class="grid grid-cols-2">
  <div class="card">
    ${resize((width) => Plot.plot({
      width,
      height: top.length * 28 + 30,
      marginLeft: nameMargin(width),
      marginRight: 48,
      x: {label: "Detections", tickFormat: "s", ticks: 4},
      y: {label: null, domain: top.map((d) => d.species)},
      marks: [
        nameAxis(width),
        Plot.barX(top, {x: "count", y: "species", fill: seriesColor(dark), insetTop: 5, insetBottom: 5, rx2: 4, href: (d) => speciesHref(d.species), tip: {format: {x: ","}}}),
        Plot.text(top, {x: "count", y: "species", text: (d) => d3.format(",")(d.count), dx: 6, textAnchor: "start", fill: "currentColor"}),
        Plot.ruleX([0], {strokeOpacity: 0.3})
      ]
    }))}
    <details class="table-view"><summary>Show as table</summary>${Inputs.table(top, {select: false, header: {species: "Species", count: "Detections"}})}</details>
  </div>
  <div class="card">
    ${Inputs.table(rows.slice(-200).reverse(), {
      select: false,
      // On narrow screens fix the columns so long names shorten instead of pushing Confidence off-screen.
      ...(width < 520 ? {layout: "fixed", width: {time: 82, confidence: 40}} : {layout: "auto"}),
      rows: 14,
      columns: ["time", "species", "confidence"],
      header: {time: "Time", species: "Species", confidence: width < 520 ? "Conf." : "Confidence"},
      format: {
        time: (t) => t.toLocaleString("en-US", {timeZone: "America/Los_Angeles", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"}).replace(",", "").replace(" AM", "a").replace(" PM", "p"),
        species: (s) => htl.html`<a href=${speciesHref(s)}>${s}</a>`,
        confidence: d3.format(".0%")
      }
    })}
  </div>
</div>

```js
// Compare the chosen period with the one just before it, of the same length.
const prevStart = Number.isFinite(RANGES.get(range)) ? addDays(start, -period.length) : null;
const prevEnd = addDays(start, -1);
const comparable = prevStart !== null && prevStart >= dataStart;
const recordedIn = (from, to) => dateSpan(from, to).filter((d) => recordedDates.has(d)).length;
const changeLabel = (d) => `${d3.format("+.1f")(d.delta)}${d.status ? ` · ${d.status}` : ""}`;
const changes = (() => {
  if (!comparable) return [];
  const daysNow = Math.max(1, daysUp);
  const daysPrev = Math.max(1, recordedIn(prevStart, prevEnd));
  const now = d3.rollup(rows, (v) => v.length, (d) => d.species);
  const before = d3.rollup(confident.filter((d) => d.date >= prevStart && d.date <= prevEnd), (v) => v.length, (d) => d.species);
  const all = [...new Set([...now.keys(), ...before.keys()])].map((species) => {
    const a = (now.get(species) ?? 0) / daysNow;
    const b = (before.get(species) ?? 0) / daysPrev;
    return {species, now: a, before: b, delta: a - b, status: b === 0 ? "new" : a === 0 ? "gone" : null};
  });
  const up = all.filter((d) => d.delta > 0).sort((x, y) => d3.descending(x.delta, y.delta)).slice(0, 8);
  const down = all.filter((d) => d.delta < 0).sort((x, y) => d3.ascending(x.delta, y.delta)).slice(0, 8).reverse();
  return [...up, ...down];
})();

const changeDomain = (() => {
  const [lo, hi] = [Math.min(0, d3.min(changes, (d) => d.delta) ?? 0), Math.max(0, d3.max(changes, (d) => d.delta) ?? 0)];
  const pad = (hi - lo) * 0.2;
  return [lo - (lo < 0 ? pad : 0), hi + (hi > 0 ? pad : 0)];
})();

// Every species' first confident detection, for the running species list.
const firstDay = d3.rollup(confident, (v) => v[0].date, (d) => d.species);
const additions = d3.rollups([...firstDay], (v) => v.map(([s]) => s), ([, date]) => date)
  .map(([date, species]) => ({date, day: new Date(date), species}))
  .sort((a, b) => d3.ascending(a.date, b.date));
let runningTotal = 0;
for (const a of additions) a.total = (runningTotal += a.species.length);
const allDates = dateSpan(dataStart, latest);
const listSteps = [{day: new Date(dataStart), total: 0}, ...additions, {day: new Date(latest), total: runningTotal}];
```

<section class="zoom">
  <div class="section-top">
    <p class="eyebrow">Changes</p>
  </div>
  <div class="grid grid-cols-2">
    <div class="card">
      ${comparable
        ? resize((width) => Plot.plot({
            width,
            height: changes.length * 26 + 50,
            marginLeft: nameMargin(width),
            marginRight: width < 520 ? 76 : 64,
            // Room past both ends of the bars for their value labels.
            x: {domain: width < 520 ? undefined : changeDomain, label: `Change in detections per day vs ${formatDate(prevStart)} – ${formatDate(prevEnd)}`, labelAnchor: "center", labelArrow: "none", grid: true, tickFormat: (d) => (d > 0 ? `+${d}` : `${d}`)},
            y: {domain: changes.map((d) => d.species), label: null},
            marks: [
              nameAxis(width),
              Plot.barX(changes, {x: "delta", y: "species", fill: (d) => (d.delta > 0 ? seriesColor(dark) : declineColor(dark)), insetTop: 5, insetBottom: 5, href: (d) => speciesHref(d.species)}),
              Plot.ruleX([0], {strokeOpacity: 0.4}),
              ...(width < 520
                ? // Narrow: values in a column at the right, clear of the names.
                  [Plot.text(changes, {y: "species", text: changeLabel, frameAnchor: "right", textAnchor: "start", dx: 8, fill: "currentColor"})]
                : // Wide: value at each bar's end (alignment can't vary per mark, so ups and downs are separate).
                  [
                    Plot.text(changes.filter((d) => d.delta > 0), {x: "delta", y: "species", text: changeLabel, textAnchor: "start", dx: 6, fill: "currentColor"}),
                    Plot.text(changes.filter((d) => d.delta < 0), {x: "delta", y: "species", text: changeLabel, textAnchor: "end", dx: -6, fill: "currentColor"})
                  ]),
              Plot.tip(changes, Plot.pointerY({
                x: "delta", y: "species",
                channels: {Species: "species", "Now (per day)": (d) => d3.format(".1f")(d.now), "Before (per day)": (d) => d3.format(".1f")(d.before)},
                format: {x: false, y: false, Species: true, "Now (per day)": true, "Before (per day)": true}
              }))
            ]
          }))
        : html`<p class="sub">There's no earlier period of the same length to compare with yet. Try a shorter range.</p>`}
    </div>
    <div class="card">
      ${resize((width) => Plot.plot({
        width,
        height: width < 520 ? 280 : 26 * 16 + 50,
        marginLeft: 62,
        marginRight: 36,
        x: {label: null, ticks: dayTicks(allDates, width - 76), tickFormat: dayTickFormat(allDates)},
        y: {label: "Species heard, all time", labelAnchor: "center", labelArrow: "none", grid: true, zero: true},
        marks: [
          Plot.rectX([{x1: new Date(start), x2: new Date(latest)}], {x1: "x1", x2: "x2", fill: "currentColor", fillOpacity: 0.06}),
          Plot.lineY(listSteps, {x: "day", y: "total", curve: "step-after", stroke: seriesColor(dark), strokeWidth: 2}),
          Plot.dot(additions, {x: "day", y: "total", r: 3.5, fill: seriesColor(dark), stroke: "var(--theme-background-alt)", strokeWidth: 1.5}),
          Plot.text([listSteps.at(-1)], {x: "day", y: "total", text: (d) => d.total, dx: 8, textAnchor: "start", fill: "currentColor", fontWeight: 600}),
          Plot.tip(additions, Plot.pointer({
            x: "day", y: "total",
            channels: {Date: (d) => formatDate(d.date), "First heard": (d) => d.species.join(", "), Total: "total"},
            format: {x: false, y: false, Date: true, "First heard": true, Total: true}
          }))
        ]
      }))}
    </div>
  </div>
</section>

<details class="advanced">
  <summary>Recorder status</summary>
  <div class="grid grid-cols-3" style="margin-top: 1rem;">
    <div class="card">
      <h2>Uptime</h2>
      <div class="big">${daysUp} of ${period.length} days</div>
      <div class="sub">${period.length - daysUp ? `${period.length - daysUp} days with no recordings` : "No gaps"}</div>
    </div>
    <div class="card">
      <h2>Latest recording</h2>
      <div class="big">${formatDate(latest)}</div>
      <div class="sub">${all.at(-1).time.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"})} (last detection)</div>
    </div>
    <div class="card">
      <h2>Low-confidence share</h2>
      <div class="big">${d3.format(".0%")(1 - rows.length / Math.max(1, all.filter((d) => d.date >= start).length))}</div>
      <div class="sub">of detections in this period are below the threshold</div>
    </div>
  </div>
</details>
