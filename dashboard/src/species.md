---
title: Species
toc: false
---

<link rel="stylesheet" href="./components/birds.css">

```js
import {includedDetection, speciesThreshold} from "./components/detection-policy.js";
import {sizeText} from "./components/species-size.js";
import {loadDetections, loadSun, loadPhotos, loadTraits, loadCategories, loadThresholds, thresholdText, birdPhoto, minutesHeard, dateSpan, sequential, dateRange, confidenceInput, seriesColor, MUTED, formatHour, formatDate, guideHref, clipPlayer} from "./components/birds.js";
```

```js
const [all, photos, categories, thresholdsFile, sun, traits] = await Promise.all([loadDetections(), loadPhotos(), loadCategories(), loadThresholds(), loadSun(), loadTraits()]);
const thresholds = thresholdsFile?.species ?? null; // learned per-species thresholds; the control covers the rest
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
// Opened without a species named (the header link): a random one heard at the default threshold.
const confidentSpecies = [...new Set(all.filter((d) => includedDetection(d, 0.6, thresholds)).map((d) => d.species))];
const pool = confidentSpecies.length ? confidentSpecies : byCount;
const speciesIn = speciesPicker(byCount.includes(requested) ? requested : pool[Math.floor(Math.random() * pool.length)]);
const species = Generators.input(speciesIn);

// Species picker: a button reading "Category › Species" that opens category tabs over a tray of
// the open category's species, most heard first, with minutes heard at the default threshold.
// Picking one closes it. Works as an input: .value and "input" events, like Inputs.select.
function speciesPicker(value) {
  const minutes = d3.rollup(minutesHeard(all.filter((d) => includedDetection(d, 0.6, thresholds))), (v) => v.length, (d) => d.species);
  const categoryOf = (s) => categories?.species?.[s] ?? "Other";
  const rank = (c) => { const i = categories?.order?.indexOf(c) ?? -1; return i < 0 ? 1e3 : i; };
  const groups = d3.groups(byCount, categoryOf).sort(([a], [b]) => rank(a) - rank(b))
    .map(([c, list]) => [c, list.slice().sort((a, b) => d3.descending(minutes.get(a) ?? 0, minutes.get(b) ?? 0) || d3.ascending(a, b))]);
  const root = html`<div class="species-picker"><span class="picker-label">Species</span><button type="button" class="picker-button" aria-expanded="false"></button><button type="button" class="picker-random" title="A random species confirmed or heard at 0.6 confidence or above"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h3.5c4 0 6 10 10 10H21M3 17h3.5c1.6 0 2.8-1.6 3.9-3.6M13.6 9.6C14.7 8 15.6 7 17 7h4"/><path d="m18.5 4.5 2.5 2.5-2.5 2.5M18.5 14.5l2.5 2.5-2.5 2.5"/></svg>Random species</button><div class="picker-panel" hidden><div class="picker-tabs" role="tablist"></div><div class="picker-tray"></div></div></div>`;
  const [button, panel] = [root.querySelector(".picker-button"), root.querySelector(".picker-panel")];
  let tab = categoryOf(value);
  const render = () => {
    // Every option's label sits invisibly in the same grid cell, so the button keeps the width of
    // the longest and the controls beside it don't shift when the species changes.
    const label = (sp, current) => html`<span class="picker-text" aria-hidden=${current ? null : "true"}><span class="picker-cat">${categoryOf(sp)}</span><span class="picker-sep">›</span><b>${sp}</b><span class="picker-sep">${panel.hidden ? "▾" : "▴"}</span></span>`;
    button.replaceChildren(label(root.value, true), ...byCount.map((sp) => Object.assign(label(sp, false), {className: "picker-text picker-sizer"})));
    root.querySelector(".picker-tabs").replaceChildren(...groups.map(([c, list]) => {
      const b = html`<button type="button" role="tab" class="picker-tab" aria-selected="${c === tab}">${c}<small>${list.length}</small></button>`;
      b.onclick = () => { tab = c; render(); };
      return b;
    }));
    root.querySelector(".picker-tray").replaceChildren(...(groups.find(([c]) => c === tab)?.[1] ?? []).map((s) => {
      const b = html`<button type="button" class="picker-species" aria-pressed="${s === root.value}">${s}<small>${minutes.get(s) ?? 0} min</small></button>`;
      b.onclick = () => choose(s);
      return b;
    }));
  };
  root.value = value;
  const choose = (s) => { root.value = s; panel.hidden = true; button.setAttribute("aria-expanded", "false"); render(); root.dispatchEvent(new Event("input", {bubbles: true})); };
  root.querySelector(".picker-random").onclick = () => { const others = pool.filter((s) => s !== root.value); if (others.length) choose(others[Math.floor(Math.random() * others.length)]); };
  button.onclick = () => { panel.hidden = !panel.hidden; button.setAttribute("aria-expanded", String(!panel.hidden)); if (!panel.hidden) tab = categoryOf(root.value); render(); };
  const close = () => { if (!panel.hidden) { panel.hidden = true; button.setAttribute("aria-expanded", "false"); render(); } };
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  addEventListener("click", (e) => { if (!root.contains(e.target)) close(); });
  render();
  return root;
}
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
const heard = sp.filter((d) => includedDetection(d, minConf, thresholds));
// This species' threshold: learned from reviews, null when blocked, else the control's.
const speciesMin = speciesThreshold(sp[0]?.scientific, minConf, thresholds);
// Counted in minutes heard: minutes with at least one detection, not raw 3-second detections.
const heardMinutes = minutesHeard(heard);
const daysHeard = new Set(heard.map((d) => d.date)).size;
const hours = d3.rollup(heardMinutes, (v) => v.length, (d) => d.hour);
const byHour = d3.range(24).map((hour) => ({hour, count: hours.get(hour) ?? 0}));
const peakHour = heard.length ? d3.greatest(byHour, (d) => d.count).hour : null;
```

```js
const photo = photos[species];
const trait = traits[sp[0]?.scientific] ?? {};
```

<div class="species-summary">
<div class="species-head">
  <div>
    <p class="eyebrow">Species</p>
    <h1>${species}</h1>
    <p class="sub"><i>${sp[0]?.scientific}</i> · ${html`<a href=${guideHref(species)} target="_blank" rel="noopener">All About Birds guide ↗</a>`}${photo ? html` · <a href=${photo.wikipedia} target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}${trait.ebird ? html` · <a href=${`https://birdsoftheworld.org/bow/species/${trait.ebird}/cur/introduction`} target="_blank" rel="noopener">Birds of the World ↗</a>` : ""}</p>
    ${sizeText(trait) ? html`<p class="sub">${sizeText(trait)}${trait.mass_g ? html` <small>Mass: AVONET (Tobias et al. 2022)</small>` : ""}</p>` : ""}
    <p class="sub">Threshold: ${thresholdText(sp[0]?.scientific, minConf, thresholds)}</p>
  </div>
  <div class="species-photo-slot">${birdPhoto(species, photo)}</div>
</div>

<div class="grid grid-cols-4 stats">
  <div class="card">
    <h2>Total minutes heard</h2>
    <div class="stat-content">
    <div class="big">${d3.format(",")(heardMinutes.length)}</div>
    <div class="sub date date-range"><span>${heardRange[0]}</span>${heardRange.length > 1 ? html`<span class="date-end"> – ${heardRange[1]}</span>` : ""}</div>
    </div>
  </div>
  <div class="card">
    <h2>Total days heard</h2>
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

${heard.length ? "" : html`<p class="sub">${speciesMin === null ? "No confirmed detections; this species counts only when confirmed." : `No detections at or above ${d3.format(".0%")(speciesMin)} confidence.${speciesMin === minConf ? " Try lowering the threshold." : ""}`}</p>`}

```js
// The shortest of 1, 3, 6 or 12 months that holds all the recordings (a year at most), so early on
// a few days aren't stretched across the whole chart; days without recordings are gray.
const spanMonths = [1, 3, 6, 12].find((m) => d3.utcMonth.offset(new Date(latest), -m) < new Date(dataStart)) ?? 12;
const calendarStart = d3.utcDay.offset(d3.utcMonth.offset(new Date(latest), -spanMonths), 1).toISOString().slice(0, 10);
const calendarDays = dateSpan(calendarStart, latest);
// Sunrise and sunset as hours after local midnight, for each day in the calendar that has them.
const sunHours = calendarDays.filter((d) => sun[d]).map((date) => {
  const {start, sunrise, sunset} = sun[date], at = (t) => (Date.parse(t) - Date.parse(start)) / 3600e3;
  return {date, sunrise: at(sunrise), sunset: at(sunset)};
});
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
    <p class="sub section-sub">${dateRange(calendarStart, latest)}</p>
  </div>
  <div class="card">
    ${Plot.legend({color: sequential(dark, {type: "sqrt", domain: [0, 60], label: "Minutes heard per hour", ticks: [0, 60], marginLeft: 8, marginRight: 8})})}
    <div class="calendar-wrap">
      <!-- Hour labels stay put while the days scroll beside them. -->
      ${Plot.plot({
        width: 44, height: 330, marginLeft: 44, marginRight: 0, marginTop: 8, marginBottom: 36,
        x: {axis: null, domain: [0, 1]},
        y: {type: "band", domain: d3.range(24), ticks: [0, 3, 6, 9, 12, 15, 18, 21], tickFormat: formatHour, label: null, tickSize: 0, padding: 0},
        marks: [Plot.axisY({ticks: [0, 3, 6, 9, 12, 15, 18, 21], tickFormat: formatHour, tickSize: 0, label: null})]
      })}
      <div class="chart-slot species-calendar" style="--chart-height: 330px" tabindex="0" role="region" aria-label="Daily and hourly activity calendar; scroll horizontally to explore dates">
      ${resize((width) => {
        const plotWidth = Math.max(width, calendarDays.length * 3 + 16);
        // Ticks: the newest day ("Today" when it is), the 1st of each month, and between them each
        // Monday for a month's span or the 15th for three months. A tick too close to a more
        // important one is dropped so the labels don't collide.
        const today = new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
        const iso = (d) => d.toISOString().slice(0, 10);
        const stop = d3.utcDay.offset(new Date(latest), 1);
        const monthStarts = d3.utcMonth.range(new Date(calendarStart), stop).map(iso);
        const mids = spanMonths === 1 ? d3.utcMonday.range(new Date(calendarStart), stop).map(iso)
          : spanMonths === 3 ? d3.utcDay.range(new Date(calendarStart), stop).filter((d) => d.getUTCDate() === 15).map(iso) : [];
        const gap = (spanMonths === 1 ? 4 : spanMonths === 3 ? 8 : 20) * 864e5;
        const ticks = [];
        for (const d of [latest, ...monthStarts, ...mids]) if (ticks.every((t) => Math.abs(new Date(t) - new Date(d)) >= gap)) ticks.push(d);
        ticks.sort();
        const tickLabel = (d) => d === latest ? (latest === today ? "Today" : formatDate(d, {month: "short", day: "numeric"}))
          : formatDate(d, spanMonths <= 3 ? {month: "short", day: "numeric"} : d.endsWith("-01-01") ? {month: "short", year: "numeric"} : {month: "short"});
        const plot = Plot.plot({
          width: plotWidth,
          height: 330,
          marginLeft: 0,
          marginRight: 8,
          marginTop: 8,
          marginBottom: 36,
          x: {type: "band", domain: calendarDays, ticks, tickFormat: tickLabel, label: null, tickSize: 0, padding: 0},
          y: {type: "band", domain: d3.range(24), axis: null, padding: 0},
          color: sequential(dark, {type: "sqrt", domain: [0, 60]}),
          marks: [
            Plot.cell(calendar.filter((d) => !d.recorded), {x: "date", y: "hour", fill: "var(--theme-foreground-faintest)", inset: 0.5}),
            Plot.cell(calendar.filter((d) => d.recorded), {
              x: "date", y: "hour", fill: "minutes", inset: 0.5,
              channels: {Day: (d) => formatDate(d.date, {month: "short", day: "numeric", year: "numeric"}), Hour: (d) => `${formatHour(d.hour)}–${formatHour((d.hour + 1) % 24)}`, "Minutes heard": "minutes"},
              tip: {format: {x: false, y: false, fill: false, Day: true, Hour: true, "Minutes heard": true}}
            }),
            // Sunrise and sunset, dashed, through the middle of each day's column. The hour rows
            // are bands, so a time is placed by hand within its hour's band.
            (index, {x, y}) => {
              const at = (h) => y(Math.floor(h)) + (h % 1) * y.bandwidth();
              const line = (key) => d3.line()(sunHours.map((d) => [x(d.date) + x.bandwidth() / 2, at(d[key])]));
              return htl.svg`<g fill="none" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.25" stroke-dasharray="4,3" aria-hidden="true">
                <path d=${line("sunrise")}></path><path d=${line("sunset")}></path></g>`;
            }
          ]
        });
        // Start scrolled to the newest days, at the right end.
        requestAnimationFrame(() => { const slot = plot.closest(".species-calendar"); if (slot) slot.scrollLeft = slot.scrollWidth; });
        return plot;
      })}
      </div>
    </div>
  </div>
</section>

<div class="grid grid-cols-2">
  <div class="card">
    <div class="chart-slot chart-slot-legend">
    ${resize((width) => Plot.plot({
      width,
      height: 220,
      marginBottom: 42,
      marginRight: 20,
      x: {domain: [0.25, 1], tickFormat: ".0%", label: "BirdNET confidence", labelOffset: 36},
      y: {label: "Detections", grid: true, tickFormat: "s"},
      marks: [
        Plot.rectY(sp, Plot.binX({y: "count"}, {x: "confidence", thresholds: d3.range(0.25, 1.0001, 0.05), fill: (d) => (includedDetection(d, minConf, thresholds) ? "shown" : "below threshold"), insetLeft: 1, insetRight: 1, ry2: 2, tip: {format: {x: ".0%"}}})),
        speciesMin === null ? null : Plot.ruleX([speciesMin], {stroke: "currentColor", strokeWidth: 1.5}),
        Plot.ruleY([0], {strokeOpacity: 0.3})
      ],
      color: {domain: ["shown", "below threshold"], range: [seriesColor(dark), MUTED], legend: true}
    }))}
    </div>
  </div>

<div class="card">
  <div class="table-slot" style="--table-height: 241px">
  ${Inputs.table(heard.slice(-200).reverse().map((d) => ({...d, clip: d.clip ?? ""})), { // "" so the table still formats it (shows "–"); it skips nulls
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
