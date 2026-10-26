---
title: Overview
toc: false
---

<link rel="stylesheet" href="./components/birds.css">


```js
import {loadDetections, loadPhotos, loadSun, loadCategories, loadWeather, loadWeatherHourly, hourlyTemperatureStrip, dayFrame, dayInset, changeChart, temperatureStrip, conditionsStrip, dayAxis, sortInput, SORTS, dayTimeline, loadRecordedUntil, dayTicks, dayTickFormat, recentSpecies, minutesHeard, birdsongMinutes, birdCard, untabbable, HEADER, categoryLabel, wireCategoryToggles, categoryToggleAll, confidenceInput, nameMargin, nameAxis, addDays, dateSpan, dateRange, seriesColor, sequential, formatDate, formatHour, speciesHref, speciesCards, speciesInfoFrom, weatherKind, boldMarkup} from "./components/birds.js";
import {periodInput, bindPeriodSwipe} from "./components/period-input.js";
import {periodBounds} from "./components/period.js";
import {biggestMonthlyChanges, windowChanges} from "./components/changes.js";
```

```js
const [all, photos, sun, categories, weather, weatherHourly, recordedUntil] = await Promise.all([
  loadDetections(), loadPhotos(), loadSun(), loadCategories(), loadWeather(), loadWeatherHourly(), loadRecordedUntil()
]);
if (!all.length) {
  // Nothing recorded yet: say so, and leave the rest of the page waiting instead of erroring.
  display(html`<p class="sub">No recordings yet. Detections show up here once the recorder has sent some audio.</p>`);
  await new Promise(() => {});
}
const latest = d3.max(all, (d) => d.date);
const dataStart = d3.min(all, (d) => d.date);
const yearAgo = d3.utcDay.offset(d3.utcYear.offset(new Date(latest), -1), 1).toISOString().slice(0, 10);
// The year-round charts always span a full year; weeks before recording began stay blank.
const presenceStart = yearAgo;
const presenceEnd = latest;
const recordedDates = new Set(all.map((d) => d.date));
```

```js
const confIn = confidenceInput();
const minConf = Generators.input(confIn);
const daylightIn = Inputs.toggle({label: "Daylight only", value: true});
const daylightOnly = Generators.input(daylightIn);
```

```js
// Depends only on the threshold, so moving between periods doesn't recompute the year-round charts.
const confident = all.filter((d) => d.confidence >= minConf);
```

<div class="page-top">
  <h1>What's singing in the yard</h1>
</div>

```js
const periodIn = periodInput({first: dataStart, last: latest});
invalidation.then(() => periodIn.destroy());
const selection = Generators.input(periodIn);

// Changing the period changes how tall the charts are. Keep whichever chart fills most of the
// screen where it is: note its position when the period changes, and hold it there while the
// charts redraw (for ~2.5 s, or until the viewer scrolls).
{
  let release = null;
  const holdAnchor = () => {
    release?.();
    const ribbon = document.querySelector(".overview-navigation")?.getBoundingClientRect().bottom ?? 0;
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, ribbon));
    };
    const anchor = [...document.querySelectorAll("main .card")].reduce((best, el) => (shown(el) > (best ? shown(best) : 0) ? el : best), null);
    if (!anchor) return;
    const offset = anchor.getBoundingClientRect().top;
    const hold = () => { const drift = anchor.getBoundingClientRect().top - offset; if (Math.abs(drift) > 1) scrollBy(0, drift); };
    const watcher = new ResizeObserver(hold);
    watcher.observe(document.querySelector("main") ?? document.body);
    const stop = () => release?.();
    const timer = setTimeout(stop, 2500);
    addEventListener("wheel", stop, {passive: true});
    addEventListener("touchstart", stop, {passive: true});
    release = () => {
      watcher.disconnect();
      clearTimeout(timer);
      removeEventListener("wheel", stop);
      removeEventListener("touchstart", stop);
      release = null;
    };
  };
  periodIn.addEventListener("input", holdAnchor);
  invalidation.then(() => { periodIn.removeEventListener("input", holdAnchor); release?.(); });
}
const sortIn = sortInput();
const sortBy = Generators.input(sortIn);
```


```js
const bounds = periodBounds(selection.scale, selection.date);
const start = bounds.start < dataStart ? dataStart : bounds.start;
const end = bounds.end > latest ? latest : bounds.end;
const period = dateSpan(start, end);
const rows = confident.filter((d) => d.date >= start && d.date <= end);
```

```js
// Always the latest birds, whatever period the charts below are showing.
const recent = recentSpecies(confident, {limit: 12});
```

<p class="eyebrow">Recently heard</p>
<div id="home-recent" class="recent-row layout-reserve">${recent.length ? recent.map((r) => birdCard(r, photos[r.species])) : html`<p class="sub">Nothing heard yet at this confidence.</p>`}</div>

<!-- The sticky period ribbon only applies to the charts it controls: it scrolls away at the end of this block, before the year-round sections. -->
<div class="period-scope">

<div class="overview-navigation">
  ${periodIn}
  <details class="more-options overview-options">
    <summary aria-label="More options"><svg class="options-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span class="options-text">More options</span></summary>
    <div class="filters">${confIn}${daylightIn}</div>
  </details>
</div>


```js
// The viewer's expand/collapse choices for the timeline (category or "*" -> collapsed?).
const timelineOverrides = Mutable(new Map());
// Kept while the viewer moves between periods, so a category they opened stays open.
const setTimelineCollapsed = (pairs) => { timelineOverrides.value = new Map([...timelineOverrides.value, ...pairs]); };
```

```js
// The same calendar period drives every overview chart.
const spanDates = period.filter((d) => recordedDates.has(d));
const spanDateSet = new Set(spanDates);
const calendarSpanDays = selection.scale === "A" ? period.length : dateSpan(bounds.start, bounds.end).length;
// How many species rows fit on one screen: a collapsed list (sorted other than by category) shows this many.
const timelineMaxRows = Math.max(10, Math.floor((window.innerHeight - 220) / 17));
const timelineDates = selection.scale === "D" ? formatDate(selection.date)
  : dateRange(start, end);
```

<section class="zoom">
  <div class="zoom-main">
  <div class="section-top">
    <p class="eyebrow">Daily rhythm of detected species</p>
    <p class="sub section-sub">${timelineDates}</p>
  </div>
  <div id="home-timeline" class="card layout-reserve timeline-card">
    <div class="filters timeline-sort">${sortIn}</div>
    ${spanDates.length
      ? resize((width) => dayTimeline(confident.filter((d) => spanDateSet.has(d.date)), sun, spanDates, {spanDays: calendarSpanDays, categories, sort: SORTS.get(sortBy), width, dark, daylightOnly, maxRows: timelineMaxRows, overrides: timelineOverrides, onToggle: setTimelineCollapsed, recordedUntil}))
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
// Week view: minutes of birdsong per local hour, placed inside each day's slot of the chart
// (a day's slot runs from 12 hours before to 12 hours after its date's tick).
const weekHours = selection.scale === "W"
  ? d3.rollups(rows, (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size, (d) => d.date, (d) => d.hour)
      .flatMap(([date, byHour]) => byHour.map(([hour, count]) => ({date, hour, count})))
  : [];
```

```js
const top = d3.rollups(minutes, (v) => v.length, (d) => d.species)
  .sort((a, b) => d3.descending(a[1], b[1]))
  .slice(0, 15)
  .map(([species, count]) => ({species, count}));
```
```js
// Trends compare the 30 days ending with the selected period against the 30 days before,
// whatever the period's scale, so a few days of a new month never face a whole month.
const TREND_DAYS = 30, MIN_RECORDED_DAYS = 7;
const recordedIn = (from, to) => dateSpan(from, to).filter((d) => recordedDates.has(d)).length;
const trendFrom = addDays(end, -(TREND_DAYS - 1));
const cmp = {nowFrom: trendFrom, nowTo: end, prevFrom: addDays(trendFrom, -TREND_DAYS), prevTo: addDays(trendFrom, -1)};
cmp.nowLabel = dateRange(cmp.nowFrom, cmp.nowTo);
cmp.prevLabel = dateRange(cmp.prevFrom, cmp.prevTo);
const comparable = cmp.prevFrom >= dataStart
  && recordedIn(cmp.nowFrom, cmp.nowTo) >= MIN_RECORDED_DAYS && recordedIn(cmp.prevFrom, cmp.prevTo) >= MIN_RECORDED_DAYS;
// "Sep 1 – 30 vs. Oct 1 – 22": the exact dates, beside the section label.
const compareDates = comparable ? `${dateRange(cmp.prevFrom, cmp.prevTo)} vs. ${dateRange(cmp.nowFrom, cmp.nowTo)}` : "";
// Only changes unlikely to be chance (see changes.js), ranked by relative size.
const changes = comparable
  ? windowChanges(
      minutesHeard(confident.filter((d) => d.date >= cmp.prevFrom && d.date <= cmp.nowTo)),
      dateSpan(cmp.nowFrom, cmp.nowTo).filter((d) => recordedDates.has(d)),
      dateSpan(cmp.prevFrom, cmp.prevTo).filter((d) => recordedDates.has(d)))
  : [];
const historicalChanges = comparable ? [] : biggestMonthlyChanges(minutes, period.filter((d) => recordedDates.has(d)));

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
        const margins = {marginLeft: 48, marginRight: 16};
        const fullWidth = width;
        if (selection.scale === "D") {
          const w = weather[selection.date];
          if (!daylightWindow) return html`<p class="sub">Sunrise and sunset times are unavailable for this day.</p>`;
          return html`<div>${Plot.plot({
            width, height: 240, ...margins,
            x: {type: "time", domain: daylightWindow, insetLeft: 8, insetRight: 8, ticks: d3.timeHour.every(fullWidth < 480 ? 4 : fullWidth < 800 ? 2 : 1), tickFormat: (t) => t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric"}).replace(" AM", "a").replace(" PM", "p"), label: null},
            y: {label: "Minutes of birdsong", labelAnchor: "center", labelArrow: "none", grid: true, domain: [0, Math.max(1, d3.max(songBins, (d) => d.count) ?? 0)], nice: true},
            marks: [Plot.rectY(songBins, {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: 1, insetRight: 1, clip: true, channels: {Time: (d) => [d.x1, d.x2].map((t) => t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"})).join("–")}, tip: {format: {x1: false, x2: false, Time: true, y: true}}}), Plot.ruleY([0], {strokeOpacity: 0.3})]
          })}${(() => {
            // Hourly temperature for the day, on the same clock as the bars above.
            // The line runs exactly from the chart's left edge to its right edge (values there are
            // interpolated between hours), 8 px in from the axis like the bars.
            const temps = weatherHourly[selection.date] ?? [];
            const midnight = +new Date(daySun.start);
            const hourly = temps.map((temp, hour) => ({t: new Date(midnight + hour * 36e5), temp, when: formatHour(hour)})).filter((d) => d.temp != null);
            const at = (t) => {
              const i = d3.bisector((d) => +d.t).left(hourly, +t);
              const a = hourly[Math.max(0, i - 1)], b = hourly[Math.min(hourly.length - 1, i)];
              const f = +b.t === +a.t ? 0 : (+t - +a.t) / (+b.t - +a.t);
              return {t, temp: a.temp + f * (b.temp - a.temp), when: t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"})};
            };
            const points = hourly.length ? [at(daylightWindow[0]), ...hourly.filter((d) => d.t > daylightWindow[0] && d.t < daylightWindow[1]), at(daylightWindow[1])] : [];
            return points.length ? hourlyTemperatureStrip(points, {width, domain: daylightWindow, inset: 8, ...margins}) : "";
          })()}<div class="period-weather">${w ? `${weatherKind(w.code)[1]} · ${Math.round(w.low)}–${Math.round(w.high)}°F · ${d3.format(".2f")(w.precip)}" rain` : "Weather unavailable"}</div></div>`;
        }
        const ticks = dayTicks(period, width - margins.marginLeft - margins.marginRight);
        const tickFormat = dayTickFormat(period);
        const frame = dayFrame(period, width, margins);
        const inset = dayInset(period, width, gap, margins);
        // Strips under the detections, top to bottom.
        const weekTemps = selection.scale === "W"
          ? period.flatMap((date) => (weatherHourly[date] ?? []).map((temp, hour) => ({
              t: new Date(+new Date(date) - 12 * 36e5 + (hour + 0.5) * 36e5), temp,
              when: `${formatDate(date, {weekday: "short", month: "short", day: "numeric"})}, ${formatHour(hour)}`
            }))).filter((d) => d.temp != null)
          : null;
        const strips = [
          conditionsStrip(period, weather, {width, dark, ...margins}),
          weekTemps ? hourlyTemperatureStrip(weekTemps, {width, domain: frame.x.domain, ...margins}) : temperatureStrip(period, weather, {width, ...margins})
        ].filter(Boolean);
        // Week: hourly bars (3-hourly when an hour would be under ~3 px wide); longer periods: daily.
        const plotWidth = width - margins.marginLeft - margins.marginRight;
        const hoursPerBin = selection.scale !== "W" ? 0 : plotWidth / (period.length * 24) >= 3 ? 1 : 3;
        const hourBins = hoursPerBin ? d3.rollups(weekHours, (v) => d3.sum(v, (d) => d.count), (d) => d.date, (d) => Math.floor(d.hour / hoursPerBin))
          .flatMap(([date, byBin]) => byBin.map(([bin, count]) => {
            const dayStart = +new Date(date) - 12 * 36e5;
            return {date, count, x1: new Date(dayStart + bin * hoursPerBin * 36e5), x2: new Date(dayStart + (bin + 1) * hoursPerBin * 36e5),
              when: `${formatDate(date, {weekday: "short", month: "short", day: "numeric"})}, ${formatHour(bin * hoursPerBin)}–${formatHour((bin + 1) * hoursPerBin % 24)}`};
          })) : [];
        const detections = Plot.plot({
          ...frame,
          height: strips.length ? 200 : 230,
          marginTop: 10,
          marginBottom: strips.length ? 6 : 30,
          x: {...frame.x, ...(strips.length ? {axis: null} : {ticks, tickFormat})},
          y: {label: hoursPerBin ? `Minutes of birdsong per ${hoursPerBin === 1 ? "hour" : "3 hours"}` : "Minutes of birdsong per day", labelAnchor: "center", labelArrow: "none", grid: true, tickFormat: "s"},
          marks: [
            hoursPerBin
              ? Plot.rectY(hourBins, {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: 0.5, insetRight: 0.5, channels: {When: "when"}, tip: {format: {When: true, x1: false, x2: false, y: ","}}})
              : Plot.rectY(daily.filter((d) => !d.offline), {x1: "x1", x2: "x2", y: "count", fill: seriesColor(dark), insetLeft: inset, insetRight: inset, ry2: gap ? 2 : 0, channels: {Day: (d) => formatDate(d.date)}, tip: {format: {Day: true, x1: false, x2: false, y: ","}}}),
            // Midnight lines between days in the hourly view.
            hoursPerBin ? Plot.ruleX(period.slice(1), {x: (d) => new Date(+new Date(d) - 12 * 36e5), strokeOpacity: 0.15}) : null,
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
          // Beside the trends chart, fill the same height (its rows + legend); stacked on narrow
          // screens, use a natural height.
          const besideTrends = comparable && changes.length && window.innerWidth > 960;
          const height = besideTrends ? Math.max(top.length * 20 + 30, changes.length * 26 + 26 * (changes.some((d) => d.now >= d.before) + changes.some((d) => d.now < d.before)) + 45) : top.length * 24 + 30;
          const band = (height - 30) / Math.max(1, top.length);
          return Plot.plot({
          width,
          height,
          marginLeft: nameMargin(width),
          marginRight: 48,
          marginTop: 0,
          x: {label: "Minutes heard", labelAnchor: "center", labelArrow: "none", tickFormat: "s", ticks: 4},
          y: {label: null, domain: top.map((d) => d.species)},
          marks: [
            nameAxis(width),
            Plot.barX(top, {x: "count", y: "species", fill: seriesColor(dark), insetTop: band * 0.18, insetBottom: band * 0.18, rx2: 4, tip: {format: {x: ","}}}),
            Plot.text(top, {x: "count", y: "species", text: (d) => d3.format(",")(d.count), dx: 6, textAnchor: "start", fill: "currentColor"}),
            Plot.ruleX([0], {strokeOpacity: 0.3})
          ]
        });
        })}
      </div>
    </section>
    <section class="zoom">
      <div class="section-top">
        <p class="eyebrow">${comparable ? "Trends in detected species" : "Largest monthly changes"}</p>
        <p class="sub section-sub">${comparable ? compareDates : dateRange(start, end)}</p>
      </div>
      <div id="home-trends" class="card layout-reserve">
        ${comparable
          ? changes.length
            ? resize((width) => changeChart(changes, {width, dark, beforeLabel: cmp.prevLabel, nowLabel: cmp.nowLabel}))
            : html`<p class="sub">No changes beyond normal day-to-day variation.</p>`
          : historicalChanges.length
            ? resize((width) => changeChart(historicalChanges, {width, dark, beforeLabel: "Earlier month", nowLabel: "Following month", annotatePeriods: true}))
            : html`<p class="sub">Trends compare 30 days with the 30 before, so they need about two months of recordings, and only show changes larger than normal day-to-day variation.</p>`}
      </div>
    </section>
    </div>
  </div>
</section>
</div>

```js
const presenceRows = confident.filter((d) => d.date >= presenceStart && d.date <= presenceEnd);
const week = (date) => d3.utcWeek.floor(new Date(date));

// Days per week the recorder was up, so a week with outages isn't read as "no birds".
const recordedDays = d3.rollup(new Set(all.filter((d) => d.date >= presenceStart && d.date <= presenceEnd).map((d) => d.date)), (v) => v.length, (date) => +week(date));
const weeks = d3.utcWeek.range(week(presenceStart), d3.utcDay.offset(new Date(presenceEnd), 1));
const recordedWeeks = recordedDays.size;

// For each species and week: share of recorded days it was heard.
const speciesWeekDays = d3.rollup(presenceRows, (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +week(d.date));
const presence = [];
for (const [species, byWeek] of speciesWeekDays) {
  for (const [t, days] of byWeek) presence.push({species, week: new Date(t), days, of: recordedDays.get(t), share: days / recordedDays.get(t)});
}

// Top 40 species by days heard; residents (heard most weeks) first, then visitors by when they peak.
const stats = d3.rollups(presence, (v) => ({
  days: d3.sum(v, (d) => d.days),
  weeks: v.length,
  center: d3.sum(v, (d) => +d.week * d.days) / d3.sum(v, (d) => d.days)
}), (d) => d.species);
const shown = stats.sort((a, b) => d3.descending(a[1].days, b[1].days)).slice(0, 40);
const resident = ([, s]) => s.weeks >= 0.75 * recordedWeeks;
const order = [
  ...shown.filter(resident).sort((a, b) => d3.descending(a[1].days, b[1].days)),
  ...shown.filter((d) => !resident(d)).sort((a, b) => d3.ascending(a[1].center, b[1].center))
].map(([s]) => s);
const shownSet = new Set(order);

// The same shares by month, for narrow screens where 52 week columns would be ~2px each.
const month = (date) => d3.utcMonth.floor(new Date(date));
const recordedMonthDays = d3.rollup(new Set(all.filter((d) => d.date >= presenceStart && d.date <= presenceEnd).map((d) => d.date)), (v) => v.length, (date) => +month(date));
const months = d3.utcMonth.range(month(presenceStart), d3.utcDay.offset(new Date(presenceEnd), 1));
const monthPresence = [];
for (const [species, byMonth] of d3.rollup(presenceRows.filter((d) => shownSet.has(d.species)), (v) => new Set(v.map((d) => d.date)).size, (d) => d.species, (d) => +month(d.date))) {
  for (const [t, days] of byMonth) monthPresence.push({species, week: new Date(t), days, of: recordedMonthDays.get(t), share: days / recordedMonthDays.get(t)});
}

// Grouped by category like the daily timeline. A collapsed category is one row: the share of
// recorded days on which any of its shown species was heard.
const presenceCategoryOf = (s) => categories?.species[s] ?? "Other";
const presenceGroups = d3.groups(order, presenceCategoryOf)
  .sort(([a], [b]) => (categories?.order.indexOf(a) ?? 0) - (categories?.order.indexOf(b) ?? 0));
const presenceGroupSize = new Map(presenceGroups.map(([g, s]) => [g, s.length]));
const shownPresenceRows = presenceRows.filter((d) => shownSet.has(d.species));
const categoryShares = (bucket, recorded) => [...d3.rollup(shownPresenceRows, (v) => new Set(v.map((d) => d.date)).size, (d) => presenceCategoryOf(d.species), (d) => +bucket(d.date))]
  .flatMap(([category, byT]) => [...byT].map(([t, days]) => ({species: HEADER + category, category, week: new Date(t), days, of: recorded.get(t), share: days / recorded.get(t)})));
const categoryWeek = categoryShares(week, recordedDays);
const categoryMonth = categoryShares(month, recordedMonthDays);
```

```js
// Mini species cards wherever a species name appears: hover on desktop, tap on phones.
const periodMinutes = d3.rollup(minutes, (v) => v.length, (d) => d.species);
const stopSpeciesCards = speciesCards(speciesInfoFrom({all, confident, photos, categories,
  extraRows: (species) => [[selection.scale === "A" ? "All time" : "This period", `${d3.format(",")(periodMinutes.get(species) ?? 0)} minutes heard`]]}));
invalidation.then(stopSpeciesCards);
```

```js
// The viewer's expand/collapse choices for the presence chart (category -> collapsed?).
const presenceOverrides = Mutable(new Map());
const setPresenceCollapsed = (pairs) => { presenceOverrides.value = new Map([...presenceOverrides.value, ...pairs]); };
```

```js
const speciesPerWeek = d3.rollup(presenceRows, (v) => new Set(v.map((d) => d.species)).size, (d) => +week(d.date));
// Unrecorded weeks are left out (a gap), not drawn as zero species.
const richness = weeks.map((w) => ({week: w, species: recordedDays.has(+w) ? speciesPerWeek.get(+w) ?? 0 : NaN}));

// When the yard is loud across the year: minutes of birdsong per recorded day, by week and
// Pacific hour of day, with each week's sunrise and sunset (mid-week) as wall-clock hours.
const songByWeekHour = d3.rollup(presenceRows, (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size, (d) => +week(d.date), (d) => d.hour);
const songGrid = weeks.flatMap((w, row) => !recordedDays.has(+w) ? [] : d3.range(24).map((hour) => {
  const minutes = songByWeekHour.get(+w)?.get(hour) ?? 0;
  return {week: w, row, hour, minutes, days: recordedDays.get(+w), perDay: minutes / recordedDays.get(+w)};
}));
const wallHours = (iso) => {
  const [h, m] = new Date(iso).toLocaleTimeString("en-GB", {timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit"}).split(":");
  return +h + m / 60;
};
const weekSun = weeks.map((w, row) => {
  const mid = sun[d3.utcDay.offset(w, 3).toISOString().slice(0, 10)];
  return mid && {row, sunrise: wallHours(mid.sunrise), sunset: wallHours(mid.sunset)};
}).filter(Boolean);
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
      // Tips read as sentences: "Week of **Nov 30**", "**43%** of days heard", ...
      const period = (d) => (byMonth ? `**${fmt(d, {month: "long", year: "numeric"})}**` : `Week of **${fmt(d, {month: "short", day: "numeric"})}**`);
      const heard = (d) => `**${d3.format(".0%")(d.share)}** of days heard\n${d.days} of ${d.of} recorded days heard`;
      // Starts collapsed when every species wouldn't fit on one screen, as the timeline does.
      const auto = order.length > Math.max(10, Math.floor((window.innerHeight - 220) / 18));
      const collapsedOf = (g) => (presenceOverrides.has(g) ? presenceOverrides.get(g) : auto);
      const rowsOrder = presenceGroups.flatMap(([g, sp]) => (collapsedOf(g) ? [HEADER + g] : [HEADER + g, ...sp]));
      const headerKeys = rowsOrder.filter((k) => k.startsWith(HEADER));
      const speciesCells = (byMonth ? monthPresence : presence.filter((d) => shownSet.has(d.species))).filter((d) => !collapsedOf(presenceCategoryOf(d.species)));
      const groupCells = (byMonth ? categoryMonth : categoryWeek).filter((d) => collapsedOf(d.category));
      const cellInset = byMonth ? 1 : 0.5;
      const plot = untabbable(Plot.plot({
      width,
      height: rowsOrder.length * (width < 480 ? 23 : 18) + 70, // taller rows on phones fit two-line names
      marginLeft: nameMargin(width),
      marginRight: 12,
      padding: 0,
      x: byMonth
        ? {type: "band", domain: months, tickFormat: (d) => (d.getUTCMonth() % 3 === 0 ? fmt(d, {month: "short"}) : ""), tickSize: 0, label: null, round: false}
        : {type: "band", domain: weeks, tickFormat: (d) => (d.getUTCDate() <= 7 ? fmt(d, {month: "short"}) : ""), tickSize: 0, label: null, round: false},
      y: {domain: rowsOrder, label: null},
      // The color bar starts where the heatmap's cells do; on phones it spans them exactly.
      color: sequential(dark, {legend: true, label: "% of days heard", domain: [0, 1], tickFormat: ".0%",
        marginLeft: nameMargin(width) + cellInset, ...(width < 520 ? {width, marginRight: 12 + cellInset, ticks: 3} : {width: nameMargin(width) + 260, marginRight: 20})}),
      marks: [
        nameAxis(width, {tickFormat: (k) => (k.startsWith(HEADER) ? "" : k)}),
        Plot.text(headerKeys, {y: (k) => k, text: (k) => categoryLabel(k.slice(1), collapsedOf(k.slice(1)), presenceGroupSize.get(k.slice(1))), frameAnchor: "left", textAnchor: "end", lineAnchor: "middle", dx: -6, lineWidth: (nameMargin(width) - 10) / 9.5, lineHeight: 1.1, fill: "currentColor", fillOpacity: 0.85, fontSize: 9.5, fontWeight: 900, letterSpacing: "0.05em"}),
        Plot.cell(speciesCells, {
          x: "week", y: "species", fill: "share", inset: cellInset
        }),
        Plot.cell(groupCells, {
          x: "week", y: "species", fill: "share", inset: cellInset
        }),
        Plot.tip(speciesCells, Plot.pointer({x: "week", y: "species", render: boldMarkup,
          title: (d) => `${period(d.week)}\n${heard(d)}\n${d.species}`})),
        Plot.tip(groupCells, Plot.pointer({x: "week", y: "species", render: boldMarkup,
          title: (d) => `${period(d.week)}\n${heard(d)}\nAny of ${presenceGroupSize.get(d.category)} ${d.category.toLowerCase()}`}))
      ]
      }));
      wireCategoryToggles(plot, presenceGroups, collapsedOf, presenceGroupSize, setPresenceCollapsed);
      return html`<div class="timeline"><div class="timeline-toolbar">${categoryToggleAll(presenceGroups, collapsedOf, setPresenceCollapsed)}</div>${plot}</div>`;
    })}
  </div>
  <div class="grid grid-cols-2">
    <div class="card">
      <div class="chart-slot">
      ${resize((width) => Plot.plot({
        width,
        height: 220,
        x: {label: null, domain: [weeks[0], weeks.at(-1)]},
        y: {label: "Species heard per week", labelAnchor: "center", labelArrow: "none", grid: true, zero: true},
        marks: [
          Plot.areaY(richness, {x: "week", y: "species", fill: seriesColor(dark), fillOpacity: 0.1, curve: "monotone-x"}),
          Plot.lineY(richness, {x: "week", y: "species", stroke: seriesColor(dark), strokeWidth: 2, curve: "monotone-x"}),
          // Dots too, so a week standing alone (no recorded neighbour to join) still shows.
          Plot.dot(richness, {x: "week", y: "species", fill: seriesColor(dark), r: 2.5}),
          Plot.ruleY([0], {strokeOpacity: 0.3}),
          Plot.tip(richness, Plot.pointerX({x: "week", y: "species", format: {x: (d) => `Week of ${d.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric"})}`}}))
        ]
      }))}
      </div>
    </div>
    <div class="card">
      <div class="chart-slot">
      ${resize((width) => {
        const hourLabel = (h) => ["12a", "6a", "12p", "6p", "12a"][h / 6];
        // A month label on the first week of every other month (rows are ~3px; monthly labels collide).
        const monthRows = weeks.map((w, row) => ({w, row})).filter(({w}, i) => i > 0 && w.getUTCMonth() !== weeks[i - 1].getUTCMonth());
        const labelRows = monthRows.filter((_, i) => i % 2 === 0);
        const fmtWeek = (w) => w.toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric"});
        const hourSpan = (h) => `${h % 12 || 12}${h < 12 ? "a" : "p"}–${(h + 1) % 12 || 12}${h + 1 < 12 || h + 1 === 24 ? "a" : "p"}`;
        const first = weekSun[0];
        return Plot.plot({
          width,
          height: 210,
          marginLeft: 36,
          marginRight: 8,
          marginTop: 14,
          x: {domain: [0, 24], ticks: [0, 6, 12, 18, 24], tickFormat: hourLabel, label: null},
          y: {domain: [weeks.length, 0], ticks: labelRows.map((d) => d.row + 0.5), tickFormat: (y) => weeks[Math.floor(y)].toLocaleDateString("en-US", {timeZone: "UTC", month: "short"}), tickSize: 0, label: null},
          color: sequential(dark, {type: "sqrt", legend: true, label: "Minutes of birdsong per day, by hour", domain: [0, Math.max(1, d3.quantile(songGrid, 0.995, (d) => d.perDay))], clamp: true, ticks: 4, width: Math.min(width, 260), marginLeft: 36}),
          marks: [
            Plot.rect(songGrid, {x1: "hour", x2: (d) => d.hour + 1, y1: "row", y2: (d) => d.row + 1, fill: "perDay"}),
            Plot.line(weekSun, {x: "sunrise", y: (d) => d.row + 0.5, stroke: "currentColor", strokeOpacity: 0.7, strokeDasharray: "3,3", curve: "monotone-y"}),
            Plot.line(weekSun, {x: "sunset", y: (d) => d.row + 0.5, stroke: "currentColor", strokeOpacity: 0.7, strokeDasharray: "3,3", curve: "monotone-y"}),
            first ? Plot.text([["sunrise", first.sunrise], ["sunset", first.sunset]], {x: ([, h]) => h, y: 0, text: ([k]) => k, dy: -7, fontSize: 10, fill: "currentColor", fillOpacity: 0.75}) : null,
            Plot.tip(songGrid, Plot.pointer({x: (d) => d.hour + 0.5, y: (d) => d.row + 0.5, render: boldMarkup,
              title: (d) => `Week of **${fmtWeek(d.week)}**, ${hourSpan(d.hour)}\n**${d3.format(".1f")(d.perDay)}** minutes of birdsong per day`}))
          ]
        });
      })}
      </div>
    </div>
  </div>
</section>


```js
const swipeTargets = [document.getElementById("home-timeline"), document.getElementById("home-activity")].filter(Boolean);
const removeSwipes = swipeTargets.map((node) => bindPeriodSwipe(node, periodIn));
invalidation.then(() => removeSwipes.forEach((remove) => remove()));
```
