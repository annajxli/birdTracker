---
title: Overview
toc: false
---

<link rel="stylesheet" href="./components/birds.css">


```js
import {loadDetections, loadPhotos, loadSun, loadCategories, loadWeather, dayFrame, dayInset, changeChart, temperatureStrip, conditionsStrip, dayAxis, dayInput, dateKey, spanInput, SPANS, sortInput, SORTS, windowStart, dayTimeline, dayTicks, dayTickFormat, recentSpecies, minutesHeard, birdsongMinutes, birdCard, untabbable, rangeInput, confidenceInput, nameMargin, nameAxis, RANGES, addDays, dateSpan, dateRange, seriesColor, sequential, formatDate, speciesHref} from "./components/birds.js";
```

```js
const all = await loadDetections();
if (!all.length) {
  // Nothing recorded yet: say so, and leave the rest of the page waiting instead of erroring.
  display(html`<p class="sub">No recordings yet. Detections show up here once the recorder has sent some audio.</p>`);
  await new Promise(() => {});
}
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
// The viewer's expand/collapse choices for the timeline (category or "*" -> collapsed?).
const timelineOverrides = Mutable(new Map());
const setTimelineCollapsed = (pairs) => { timelineOverrides.value = new Map([...timelineOverrides.value, ...pairs]); };
// Only when there's something to reset, so a control change doesn't draw the timeline twice.
const resetTimelineCollapsed = () => { if (timelineOverrides.value.size) timelineOverrides.value = new Map(); };
```

```js
// Back to the automatic choice whenever what's shown changes.
span, dayValue, sortBy, daylightOnly, minConf;
resetTimelineCollapsed();
```

```js
// Days that had recordings in the chosen span, ending on the chosen day.
const day = dateKey(dayValue);
const spanDates = day ? dateSpan(windowStart(day, SPANS.get(span), dataStart), day).filter((d) => recordedDates.has(d)) : [];
const spanDateSet = new Set(spanDates);
// How many species rows fit on one screen; more than this and the timeline starts collapsed.
const timelineMaxRows = Math.max(10, Math.floor((window.innerHeight - 220) / 17));
// Subtitle: the day, or the days overlaid ("Oct 16 – 22, overlaid").
const timelineDates = !spanDates.length ? formatDate(day ?? latest)
  : spanDates.length === 1 ? formatDate(spanDates[0])
  : `${dateRange(spanDates[0], spanDates.at(-1))}, overlaid`;
```

<section class="zoom zoom-layout">
  <aside class="zoom-controls">
    <div class="filters">${spanIn}${sortIn}${daylightIn}${dayIn}</div>
  </aside>
  <div class="zoom-main">
  <div class="section-top">
    <p class="eyebrow">Daily rhythm of detected species</p>
    <p class="sub section-sub">${timelineDates}</p>
  </div>
  <div class="card">
    ${spanDates.length
      ? resize((width) => dayTimeline(confident.filter((d) => spanDateSet.has(d.date)), sun, spanDates, {spanDays: SPANS.get(span), categories, sort: SORTS.get(sortBy), width, dark, daylightOnly, maxRows: timelineMaxRows, overrides: timelineOverrides, onToggle: setTimelineCollapsed}))
      : html`<p class="sub">No recordings ${SPANS.get(span) === 1 ? "on this day" : "in these days"}; the recorder was offline.</p>`}
  </div>
  </div>
</section>

```js
const start = windowStart(latest, RANGES.get(range), dataStart);
const period = dateSpan(start, latest);
const rows = confident.filter((d) => d.date >= start);
// Counts below are minutes, not raw 3-second detections: "minutes heard" per species,
// and "minutes of birdsong" (clock minutes with any bird) for the whole yard.
const minutes = minutesHeard(rows);
const songMinutes = birdsongMinutes(rows);

const mostHeard = d3.greatest(d3.rollups(minutes, (v) => v.length, (d) => d.species), ([, n]) => n);
const daysUp = period.filter((d) => recordedDates.has(d)).length;
const speciesCount = new Set(rows.map((d) => d.species)).size;
```

```js
const perDay = d3.rollup(minutes, (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size, (d) => d.date);
// Each bar spans noon-to-noon around its date, so it's centered on that date's axis tick.
const halfDay = 12 * 36e5;
const daily = period.map((date) => {
  const day = new Date(date);
  return {date, day, x1: new Date(+day - halfDay), x2: new Date(+day + halfDay), count: perDay.get(date) ?? 0, offline: !recordedDates.has(date)};
});
const gap = period.length <= 90 ? 1 : 0;
```

```js
const top = d3.rollups(minutes, (v) => v.length, (d) => d.species)
  .sort((a, b) => d3.descending(a[1], b[1]))
  .slice(0, 15)
  .map(([species, count]) => ({species, count}));
```
```js
// What "Trends in detected species" compares. With 30 days, calendar months: this
// month so far vs. last month (or the last two full months if this one has barely
// started). Longer ranges compare rolling windows of the same length.
const monthName = (date) => new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {month: "long"});
const monthStart = (date) => `${date.slice(0, 7)}-01`;
const cmp = (() => {
  if (range === "30 days") {
    const thisMonth = monthStart(latest);
    const daysIn = Number(latest.slice(8, 10));
    const nowTo = daysIn >= 7 ? latest : addDays(thisMonth, -1);
    const nowFrom = monthStart(nowTo);
    const prevTo = addDays(nowFrom, -1);
    const prevFrom = monthStart(prevTo);
    const fullMonth = addDays(nowTo, 1).endsWith("-01");
    return {nowFrom, nowTo, prevFrom, prevTo, nowLabel: `${monthName(nowTo)}${fullMonth ? "" : " so far"}`, prevLabel: monthName(prevTo)};
  }
  if (!Number.isFinite(RANGES.get(range))) return null;
  const prevFrom = addDays(start, -period.length);
  const prevTo = addDays(start, -1);
  return {nowFrom: start, nowTo: latest, prevFrom, prevTo, nowLabel: dateRange(start, latest), prevLabel: dateRange(prevFrom, prevTo)};
})();
const comparable = cmp !== null && cmp.prevFrom >= dataStart;
// "Sep 1 – 30 vs. Oct 1 – 22": the exact dates, beside the section label.
const compareDates = comparable ? `${dateRange(cmp.prevFrom, cmp.prevTo)} vs. ${dateRange(cmp.nowFrom, cmp.nowTo)}` : "";
const recordedIn = (from, to) => dateSpan(from, to).filter((d) => recordedDates.has(d)).length;
const changes = (() => {
  if (!comparable) return [];
  const daysNow = Math.max(1, recordedIn(cmp.nowFrom, cmp.nowTo));
  const daysPrev = Math.max(1, recordedIn(cmp.prevFrom, cmp.prevTo));
  const now = d3.rollup(minutesHeard(confident.filter((d) => d.date >= cmp.nowFrom && d.date <= cmp.nowTo)), (v) => v.length, (d) => d.species);
  const before = d3.rollup(minutesHeard(confident.filter((d) => d.date >= cmp.prevFrom && d.date <= cmp.prevTo)), (v) => v.length, (d) => d.species);
  const all = [...new Set([...now.keys(), ...before.keys()])].map((species) => {
    const a = (now.get(species) ?? 0) / daysNow;
    const b = (before.get(species) ?? 0) / daysPrev;
    return {species, now: a, before: b, delta: a - b};
  });
  const up = all.filter((d) => d.delta > 0).sort((x, y) => d3.descending(x.delta, y.delta)).slice(0, 8);
  const down = all.filter((d) => d.delta < 0).sort((x, y) => d3.ascending(x.delta, y.delta)).slice(0, 8).reverse();
  return [...up, ...down];
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

<section class="zoom zoom-layout">
  <aside class="zoom-controls">
    <div class="filters">${rangeIn}${weatherIn}</div>
  </aside>
  <div class="zoom-main">
    <div class="grid grid-cols-3 stats">
      <div class="card">
        <h2>Species heard</h2>
        <div class="big">${speciesCount}</div>
        <div class="sub date">${dateRange(start, latest)}</div>
      </div>
      <div class="card">
        <h2>Minutes of birdsong</h2>
        <div class="big">${d3.format(",")(songMinutes.size)}</div>
        <div class="sub">${daysUp ? d3.format(",")(Math.round(songMinutes.size / daysUp)) : 0} minutes per day</div>
      </div>
      <div class="card">
        <h2>Most heard</h2>
        <div class="big">${mostHeard ? html`<a class="stat-link" href=${speciesHref(mostHeard[0])}>${mostHeard[0]}</a>` : "–"}</div>
        <div class="sub">${mostHeard ? `${d3.format(",")(mostHeard[1])} minutes heard` : "Nothing heard"}</div>
      </div>
    </div>
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
          y: {label: "Minutes of birdsong per day", labelAnchor: "center", labelArrow: "none", grid: true, tickFormat: "s"},
          marks: [
            Plot.rectY(daily.filter((d) => !d.offline), {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: inset, insetRight: inset, ry2: gap ? 2 : 0, channels: {Day: (d) => formatDate(d.date)}, tip: {format: {Day: true, x1: false, x2: false, y: ","}}}),
            Plot.ruleY([0], {strokeOpacity: 0.3})
          ]
        });
        return html`<div>${detections}${strips}${strips.length ? dayAxis(period, {width, ticks, tickFormat}) : ""}</div>`;
      })}
    </div>
    <div class="pair-grid">
    <section class="zoom">
      <div class="section-top">
        <p class="eyebrow">Most heard species</p>
        <p class="sub section-sub">${dateRange(start, latest)}</p>
      </div>
      <div class="card">
        ${resize((width) => {
          // Beside the trends chart, fill the same height (its rows + legend, less this card's
          // "Show as table" line); stacked on narrow screens, use a natural height.
          const besideTrends = comparable && changes.length && window.innerWidth > 960;
          const height = besideTrends ? Math.max(top.length * 20 + 30, changes.length * 26 + 45) : top.length * 24 + 30;
          const band = (height - 30) / Math.max(1, top.length);
          return Plot.plot({
          width,
          height,
          marginLeft: nameMargin(width),
          marginRight: 48,
          marginTop: 0,
          x: {label: "Minutes heard", tickFormat: "s", ticks: 4},
          y: {label: null, domain: top.map((d) => d.species)},
          marks: [
            nameAxis(width),
            Plot.barX(top, {x: "count", y: "species", fill: seriesColor(dark), insetTop: band * 0.18, insetBottom: band * 0.18, rx2: 4, href: (d) => speciesHref(d.species), tip: {format: {x: ","}}}),
            Plot.text(top, {x: "count", y: "species", text: (d) => d3.format(",")(d.count), dx: 6, textAnchor: "start", fill: "currentColor"}),
            Plot.ruleX([0], {strokeOpacity: 0.3})
          ]
        });
        })}
        <details class="table-view"><summary>Show as table</summary>${Inputs.table(top, {select: false, header: {species: "Species", count: "Minutes heard"}})}</details>
      </div>
    </section>
    <section class="zoom">
      <div class="section-top">
        <p class="eyebrow">Trends in detected species</p>
        <p class="sub section-sub">${compareDates}</p>
      </div>
      <div class="card">
        ${comparable
          ? resize((width) => changeChart(changes, {width, dark, beforeLabel: cmp.prevLabel, nowLabel: cmp.nowLabel}))
          : html`<p class="sub">${range === "30 days" ? "There's no full previous month to compare with yet." : "There's no earlier period of the same length to compare with yet. Try a shorter range."}</p>`}
      </div>
    </section>
    </div>
  </div>
</section>

```js
const week = (date) => d3.utcWeek.floor(new Date(date));

// Days per week the recorder was up, so a week with outages isn't read as "no birds".
const recordedDays = d3.rollup(new Set(all.map((d) => d.date)), (v) => v.length, (date) => +week(date));
const weeks = [...recordedDays.keys()].sort(d3.ascending).map((t) => new Date(t));

// For each species and week: share of recorded days it was heard.
const speciesWeekDays = d3.rollup(confident, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +week(d.date));
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
for (const [species, byMonth] of d3.rollup(confident.filter((d) => shownSet.has(d.species)), (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +month(d.date))) {
  for (const [t, days] of byMonth) monthPresence.push({species, week: new Date(t), days, share: days / recordedMonthDays.get(t)});
}
```

```js
const speciesPerWeek = d3.rollup(confident, (v) => new Set(v.map((d) => d.species)).size, (d) => +week(d.date));
const richness = weeks.map((w) => ({week: w, species: speciesPerWeek.get(+w) ?? 0}));
```

<section class="zoom">
  <div class="section-top">
    <p class="eyebrow">Seasons</p>
    <p class="sub section-sub">${dateRange(dataStart, latest)}</p>
  </div>
  <div class="card">
    ${resize((width) => {
      const byMonth = width < 520;
      const fmt = (d, opts) => d.toLocaleDateString("en-US", {timeZone: "UTC", ...opts});
      return untabbable(Plot.plot({
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
      }));
    })}
  </div>
  <div class="grid grid-cols-2">
    <div class="card">
      ${resize((width) => Plot.plot({
        width,
        height: 220,
        x: {label: null},
        y: {label: "Species heard per week", labelAnchor: "center", labelArrow: "none", grid: true, zero: true},
        marks: [
          Plot.areaY(richness, {x: "week", y: "species", fill: seriesColor(dark), fillOpacity: 0.1, curve: "monotone-x"}),
          Plot.lineY(richness, {x: "week", y: "species", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
          Plot.ruleY([0], {strokeOpacity: 0.3}),
          Plot.tip(richness, Plot.pointerX({x: "week", y: "species", format: {x: (d) => `Week of ${d.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric"})}`}}))
        ]
      }))}
    </div>
    <div class="card">
      ${resize((width) => Plot.plot({
        width,
        height: 220,
        marginLeft: 62,
        marginRight: 36,
        x: {label: null, ticks: dayTicks(allDates, width - 76), tickFormat: dayTickFormat(allDates)},
        y: {label: "Species heard, all time", labelAnchor: "center", labelArrow: "none", grid: true, zero: true},
        marks: [
          Plot.rectX([{x1: new Date(start), x2: new Date(latest)}], {x1: "x1", x2: "x2", fill: "currentColor", fillOpacity: 0.06}),
            // Name the shaded band: the period picked in "Show last".
            Plot.text([new Date(start)], {x: (d) => d, text: [range === "All time" ? "" : `last ${range}`], frameAnchor: "bottom", textAnchor: "start", dx: 4, dy: -4, fill: "currentColor", fillOpacity: 0.6, fontSize: 10}),
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
