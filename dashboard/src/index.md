---
title: Overview
toc: false
---

<link rel="stylesheet" href="./components/birds.css">


```js
import {loadDetections, loadPhotos, loadSun, loadCategories, loadWeather, dayFrame, dayInset, changeChart, temperatureStrip, conditionsStrip, dayAxis, sortInput, SORTS, dayTimeline, dayTicks, dayTickFormat, recentSpecies, minutesHeard, birdsongMinutes, birdCard, untabbable, confidenceInput, nameMargin, nameAxis, dateSpan, dateRange, seriesColor, sequential, formatDate, speciesHref, weatherKind} from "./components/birds.js";
import {periodInput, bindPeriodSwipe} from "./components/period-input.js";
import {periodBounds, shiftPeriod, periodLabel} from "./components/period.js";
import {biggestMonthlyChanges} from "./components/changes.js";
```

```js
const [all, photos, sun, categories, weather] = await Promise.all([
  loadDetections(), loadPhotos(), loadSun(), loadCategories(), loadWeather()
]);
if (!all.length) {
  // Nothing recorded yet: say so, and leave the rest of the page waiting instead of erroring.
  display(html`<p class="sub">No recordings yet. Detections show up here once the recorder has sent some audio.</p>`);
  await new Promise(() => {});
}
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
const yearAgo = d3.utcDay.offset(d3.utcYear.offset(new Date(latest), -1), 1).toISOString().slice(0, 10);
const presenceStart = yearAgo < dataStart ? dataStart : yearAgo;
const presenceEnd = latest;
const recordedDates = new Set(all.map((d) => d.date));
```

```js
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
```

<div class="page-top">
  <h1>What's singing in the yard</h1>
</div>

```js
const periodIn = periodInput({first: dataStart, last: latest});
invalidation.then(() => periodIn.destroy());
const selection = Generators.input(periodIn);
const sortIn = sortInput();
const sortBy = Generators.input(sortIn);
```


```js
const bounds = periodBounds(selection.scale, selection.date);
const start = bounds.start < dataStart ? dataStart : bounds.start;
const end = bounds.end > latest ? latest : bounds.end;
const period = dateSpan(start, end);
const confident = all.filter((d) => d.confidence >= minConf);
const rows = confident.filter((d) => d.date >= start && d.date <= end);
const recent = recentSpecies(rows, {limit: 12});
```

<p class="eyebrow">Recently heard</p>
<div id="home-recent" class="recent-row layout-reserve">${recent.length ? recent.map((r) => birdCard(r, photos[r.species])) : html`<p class="sub">No species heard in this period.</p>`}</div>

<div class="overview-navigation">
  ${periodIn}
  <details class="more-options overview-options">
    <summary>More options</summary>
    <div class="filters">${confIn}</div>
  </details>
</div>


```js
// The viewer's expand/collapse choices for the timeline (category or "*" -> collapsed?).
const timelineOverrides = Mutable(new Map());
const setTimelineCollapsed = (pairs) => { timelineOverrides.value = new Map([...timelineOverrides.value, ...pairs]); };
// Only when there's something to reset, so a control change doesn't draw the timeline twice.
const resetTimelineCollapsed = () => { if (timelineOverrides.value.size) timelineOverrides.value = new Map(); };
```

```js
// Back to the automatic choice whenever what's shown changes.
selection, sortBy, minConf;
resetTimelineCollapsed();
```

```js
// The same calendar period drives every overview chart.
const spanDates = period.filter((d) => recordedDates.has(d));
const spanDateSet = new Set(spanDates);
const calendarSpanDays = dateSpan(bounds.start, bounds.end).length;
// How many species rows fit on one screen; more than this and the timeline starts collapsed.
const timelineMaxRows = Math.max(10, Math.floor((window.innerHeight - 220) / 17));
const timelineDates = selection.scale === "D" ? formatDate(selection.date)
  : `${dateRange(start, end)}, overlaid`;
```

<section class="zoom">
  <div class="zoom-main">
  <div class="section-top">
    <p class="eyebrow">Daily rhythm of detected species</p>
    <p class="sub section-sub">${timelineDates}</p>
  </div>
  <div id="home-timeline" class="card layout-reserve">
    ${spanDates.length
      ? resize((width) => dayTimeline(confident.filter((d) => spanDateSet.has(d.date)), sun, spanDates, {spanDays: calendarSpanDays, categories, sort: SORTS.get(sortBy), width, dark, daylightOnly: true, controls: sortIn, maxRows: timelineMaxRows, overrides: timelineOverrides, onToggle: setTimelineCollapsed}))
      : html`<p class="sub">No recordings ${selection.scale === "D" ? "on this day" : "in this period"}; the recorder was offline.</p>`}
  </div>
  </div>
</section>

```js
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
const daySun = sun[selection.date];
const daylightWindow = daySun ? [new Date(+new Date(daySun.sunrise) - 90 * 6e4), new Date(+new Date(daySun.sunset) + 90 * 6e4)] : null;
const songBinMs = 15 * 6e4;
const clockMinutes = d3.rollup(selection.scale === "D" && daylightWindow ? rows.filter((d) => d.time >= daylightWindow[0] && d.time <= daylightWindow[1]) : [],
  (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size,
  (d) => Math.floor(+d.time / songBinMs));
const songBins = [...clockMinutes].map(([bin, count]) => ({x1: new Date(bin * songBinMs), x2: new Date((bin + 1) * songBinMs), count}));
```

```js
const top = d3.rollups(minutes, (v) => v.length, (d) => d.species)
  .sort((a, b) => d3.descending(a[1], b[1]))
  .slice(0, 15)
  .map(([species, count]) => ({species, count}));
```
```js
// Compare with the preceding calendar day, week, month, or year.
const previous = shiftPeriod(selection.scale, selection.date, -1);
const cmp = {nowFrom: start, nowTo: end, prevFrom: previous.start, prevTo: previous.end,
  nowLabel: periodLabel(selection.scale, selection.date), prevLabel: periodLabel(selection.scale, previous.start)};
const comparable = cmp.prevFrom >= dataStart && [...recordedDates].some((d) => d >= cmp.prevFrom && d <= cmp.prevTo);
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
const historicalChanges = comparable ? [] : biggestMonthlyChanges(minutes, period.filter((d) => recordedDates.has(d)));

// Every species' first confident detection, for the running species list.
const firstDay = d3.rollup(confident, (v) => v[0].date, (d) => d.species);
const additions = d3.rollups([...firstDay], (v) => v.map(([s]) => s), ([, date]) => date)
  .filter(([date]) => date >= presenceStart && date <= presenceEnd)
  .map(([date, species]) => ({date, day: new Date(date), species}))
  .sort((a, b) => d3.ascending(a.date, b.date));
const initialTotal = [...firstDay.values()].filter((date) => date < presenceStart).length;
let runningTotal = initialTotal;
for (const a of additions) a.total = (runningTotal += a.species.length);
const allDates = dateSpan(presenceStart, presenceEnd);
const listSteps = [{day: new Date(presenceStart), total: initialTotal}, ...additions, {day: new Date(presenceEnd), total: runningTotal}];
```

<section class="zoom">
  <div class="zoom-main">
    <div class="section-top">
      <p class="eyebrow">Activity over time</p>
      <p class="sub section-sub">${dateRange(start, end)}</p>
    </div>
    <div class="card activity-layout">
    <div class="grid grid-cols-3 stats activity-stats">
      <div class="card">
        <h2>Species heard</h2>
        <div class="big">${speciesCount}</div>
        <div class="sub date">${dateRange(start, end)}</div>
      </div>
      <div class="card">
        <h2>Minutes of birdsong</h2>
        <div class="big">${d3.format(",")(songMinutes.size)}</div>
        ${selection.scale === "D" ? "" : html`<div class="sub">${daysUp ? d3.format(",")(Math.round(songMinutes.size / daysUp)) : 0} minutes per day</div>`}
      </div>
      <div class="card">
        <h2>Most heard</h2>
        <div class="big">${mostHeard ? html`<a class="stat-link" href=${speciesHref(mostHeard[0])}>${mostHeard[0]}</a>` : "–"}</div>
        <div class="sub">${mostHeard ? `${d3.format(",")(mostHeard[1])} minutes heard` : "Nothing heard"}</div>
      </div>
    </div>
    <div id="home-activity" class="day-stack layout-reserve">
      <div class="chart-slot" style="--chart-height: 372px">
      ${resize((width) => {
        const alongside = window.innerWidth > 960;
        const margins = {marginLeft: alongside ? 44 : nameMargin(width), marginRight: 16};
        const fullWidth = width + (alongside ? 126 : 0);
        if (selection.scale === "D") {
          const w = weather[selection.date];
          if (!daylightWindow) return html`<p class="sub">Sunrise and sunset times are unavailable for this day.</p>`;
          return html`<div>${Plot.plot({
            width, height: alongside ? 300 : 220, ...margins,
            x: {type: "time", domain: daylightWindow, ticks: d3.timeHour.every(fullWidth < 480 ? 4 : fullWidth < 800 ? 2 : 1), tickFormat: (t) => t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric"}).replace(" AM", "a").replace(" PM", "p"), label: null},
            y: {label: "Minutes of birdsong", labelAnchor: "center", labelArrow: "none", grid: true, domain: [0, Math.max(1, d3.max(songBins, (d) => d.count) ?? 0)], nice: true},
            marks: [Plot.rectY(songBins, {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: 1, insetRight: 1, clip: true, channels: {Time: (d) => [d.x1, d.x2].map((t) => t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"})).join("–")}, tip: {format: {x1: false, x2: false, Time: true, y: true}}}), Plot.ruleY([0], {strokeOpacity: 0.3})]
          })}<div class="period-weather">${w ? `${weatherKind(w.code)[1]} · ${Math.round(w.low)}–${Math.round(w.high)}°F · ${d3.format(".2f")(w.precip)}" rain` : "Weather unavailable"}</div></div>`;
        }
        const ticks = dayTicks(period, width - margins.marginLeft - margins.marginRight);
        const tickFormat = dayTickFormat(period);
        const frame = dayFrame(period, width, margins);
        const inset = dayInset(period, width, gap, margins);
        // Strips under the detections, top to bottom.
        const strips = [
          conditionsStrip(period, weather, {width, dark, ...margins}),
          temperatureStrip(period, weather, {width, ...margins})
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
        return html`<div>${detections}${strips}${strips.length ? dayAxis(period, {width, ticks, tickFormat, ...margins}) : ""}</div>`;
      })}
      </div>
    </div>
    </div>
    <div class="pair-grid">
    <section class="zoom">
      <div class="section-top">
        <p class="eyebrow">Most heard species</p>
        <p class="sub section-sub">${dateRange(start, end)}</p>
      </div>
      <div id="home-ranking" class="card layout-reserve">
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
        <p class="eyebrow">${comparable ? "Trends in detected species" : "Largest monthly changes"}</p>
        <p class="sub section-sub">${comparable ? compareDates : dateRange(start, end)}</p>
      </div>
      <div id="home-trends" class="card layout-reserve">
        ${comparable
          ? resize((width) => changeChart(changes, {width, dark, beforeLabel: cmp.prevLabel, nowLabel: cmp.nowLabel}))
          : historicalChanges.length
            ? resize((width) => changeChart(historicalChanges, {width, dark, beforeLabel: "Earlier month", nowLabel: "Following month", annotatePeriods: true}))
            : html`<p class="sub">${selection.scale === "D" || selection.scale === "W" ? "No earlier recorded period to compare with yet." : "Monthly comparisons need two complete months with enough recordings and a change in activity."}</p>`}
      </div>
    </section>
    </div>
  </div>
</section>

```js
const presenceRows = confident.filter((d) => d.date >= presenceStart && d.date <= presenceEnd);
const week = (date) => d3.utcWeek.floor(new Date(date));

// Days per week the recorder was up, so a week with outages isn't read as "no birds".
const recordedDays = d3.rollup(new Set(all.filter((d) => d.date >= presenceStart && d.date <= presenceEnd).map((d) => d.date)), (v) => v.length, (date) => +week(date));
const weeks = [...recordedDays.keys()].sort(d3.ascending).map((t) => new Date(t));

// For each species and week: share of recorded days it was heard.
const speciesWeekDays = d3.rollup(presenceRows, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +week(d.date));
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
const recordedMonthDays = d3.rollup(new Set(all.filter((d) => d.date >= presenceStart && d.date <= presenceEnd).map((d) => d.date)), (v) => v.length, (date) => +month(date));
const months = [...recordedMonthDays.keys()].sort(d3.ascending).map((t) => new Date(t));
const monthPresence = [];
for (const [species, byMonth] of d3.rollup(presenceRows.filter((d) => shownSet.has(d.species)), (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +month(d.date))) {
  for (const [t, days] of byMonth) monthPresence.push({species, week: new Date(t), days, share: days / recordedMonthDays.get(t)});
}
```

```js
const speciesPerWeek = d3.rollup(presenceRows, (v) => new Set(v.map((d) => d.species)).size, (d) => +week(d.date));
const richness = weeks.map((w) => ({week: w, species: speciesPerWeek.get(+w) ?? 0}));
```

<section class="zoom">
  <div class="section-top">
    <p class="eyebrow">Year-round presence</p>
    <p class="sub section-sub">${dateRange(presenceStart, presenceEnd)}</p>
  </div>
  <div id="home-seasons" class="card layout-reserve">
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
      <div class="chart-slot">
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
    </div>
    <div class="card">
      <div class="chart-slot">
      ${resize((width) => Plot.plot({
        width,
        height: 220,
        marginLeft: 62,
        marginRight: 36,
        x: {label: null, ticks: dayTicks(allDates, width - 76), tickFormat: dayTickFormat(allDates)},
        y: {label: "Species heard, all time", labelAnchor: "center", labelArrow: "none", grid: true, zero: true},
        marks: [
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
      <div class="big">${d3.format(".0%")(1 - rows.length / Math.max(1, all.filter((d) => d.date >= start && d.date <= end).length))}</div>
      <div class="sub">of detections in this period are below the threshold</div>
    </div>
  </div>
</details>

```js
const swipeTargets = [document.getElementById("home-timeline"), document.getElementById("home-activity")].filter(Boolean);
const removeSwipes = swipeTargets.map((node) => bindPeriodSwipe(node, periodIn));
invalidation.then(() => removeSwipes.forEach((remove) => remove()));
```
