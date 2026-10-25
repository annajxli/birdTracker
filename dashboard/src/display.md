---
title: Display
toc: false
header: false
footer: false
---

<!-- A slideshow of the overview's charts for a screen on the wall: full width, one at a time,
     advancing every SLIDE_SECONDS. Arrow keys or a tap step through; F or the button goes
     fullscreen. Reloads every RELOAD_MINUTES to pick up new detections. -->

```js
import {loadDetections, loadPhotos, loadSun, loadCategories, recentSpecies, birdCard, dayTimeline, minutesHeard, birdsongMinutes, seriesColor, sequential, nameMargin, nameAxis, dateSpan, dateRange, formatDate, addDays} from "./components/birds.js";
```

```js
const SLIDE_SECONDS = 15, RELOAD_MINUTES = 30, MIN_CONF = 0.6;
const [all, photos, sun, categories] = await Promise.all([loadDetections(), loadPhotos(), loadSun(), loadCategories()]);
const confident = all.filter((d) => d.confidence >= MIN_CONF);
const latest = d3.max(all, (d) => d.date);
const recorded = new Set(all.map((d) => d.date));
const week = dateSpan(addDays(latest, -6), latest).filter((d) => recorded.has(d));
const yearDates = dateSpan(addDays(latest, -364), latest).filter((d) => recorded.has(d));
setTimeout(() => location.reload(), RELOAD_MINUTES * 60e3);
```

```js
const W = Math.min(1600, width);
const inSpan = (dates) => { const s = new Set(dates); return confident.filter((d) => s.has(d.date)); };

// Most heard this week, by minutes heard.
const weekMinutes = d3.rollups(minutesHeard(inSpan(week)), (v) => v.length, (d) => d.species)
  .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([species, count]) => ({species, count}));

// When the yard is loud across the year (as on the overview): minutes of birdsong per day by week and hour.
const yearRows = inSpan(yearDates);
const weekOf = (date) => +d3.utcWeek.floor(new Date(date));
const weekDays = d3.rollup(yearDates, (v) => v.length, weekOf);
const weeks = [...weekDays.keys()].sort(d3.ascending);
const byWeekHour = d3.rollup(yearRows, (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size, (d) => weekOf(d.date), (d) => d.hour);
const grid = weeks.flatMap((w, row) => d3.range(24).map((hour) => ({row, hour, perDay: (byWeekHour.get(w)?.get(hour) ?? 0) / weekDays.get(w)})));

const slides = [
  {title: "Recently heard", body: () => html`<div class="display-cards">${recentSpecies(confident, {limit: 12}).map((r) => birdCard(r, photos[r.species]))}</div>`},
  {title: `Today · ${formatDate(latest)}`, body: () => dayTimeline(inSpan([latest]), sun, [latest], {categories, width: W, dark, daylightOnly: true})},
  {title: `This week · ${dateRange(week[0], latest)}`, body: () => dayTimeline(inSpan(week), sun, week, {spanDays: 7, categories, width: W, dark, daylightOnly: true})},
  {title: "Most heard this week", body: () => Plot.plot({
    width: W, height: weekMinutes.length * 40 + 40, marginLeft: nameMargin(W) + 60, marginRight: 60, style: {fontSize: "16px"},
    x: {label: "Minutes heard", labelAnchor: "center", labelArrow: "none"}, y: {label: null, domain: weekMinutes.map((d) => d.species)},
    marks: [
      Plot.barX(weekMinutes, {x: "count", y: "species", fill: seriesColor(dark), insetTop: 7, insetBottom: 7, rx2: 4}),
      Plot.text(weekMinutes, {x: "count", y: "species", text: (d) => d3.format(",")(d.count), dx: 8, textAnchor: "start", fill: "currentColor"}),
      Plot.ruleX([0], {strokeOpacity: 0.3})
    ]
  })},
  {title: "Birdsong through the year, by hour", body: () => Plot.plot({
    width: W, height: Math.min(640, innerHeight - 220), marginLeft: 60, style: {fontSize: "15px"},
    x: {domain: [0, 24], ticks: [0, 6, 12, 18, 24], tickFormat: (h) => ["12a", "6a", "12p", "6p", "12a"][h / 6], label: null},
    y: {domain: [weeks.length, 0], ticks: weeks.map((w, i) => i).filter((i) => i > 0 && new Date(weeks[i]).getUTCMonth() !== new Date(weeks[i - 1]).getUTCMonth()).map((i) => i + 0.5),
      tickFormat: (y) => new Date(weeks[Math.floor(y)]).toLocaleDateString("en-US", {timeZone: "UTC", month: "short"}), tickSize: 0, label: null},
    color: sequential(dark, {type: "sqrt", legend: true, label: "Minutes of birdsong per day, by hour", domain: [0, Math.max(1, d3.quantile(grid, 0.995, (d) => d.perDay))], clamp: true, marginLeft: 60}),
    marks: [Plot.rect(grid, {x1: "hour", x2: (d) => d.hour + 1, y1: "row", y2: (d) => d.row + 1, fill: "perDay"})]
  })}
];
```

```js
const stage = html`<div class="display">
  <div class="display-top"><h1 class="display-title"></h1><span class="display-dots"></span>
    <button class="display-full" type="button" title="Fullscreen (F)">⛶</button></div>
  <div class="display-slide"></div>
</div>`;
let i = 0, timer;
const titleEl = stage.querySelector(".display-title"), slideEl = stage.querySelector(".display-slide"), dots = stage.querySelector(".display-dots");
const go = (n) => {
  i = (n + slides.length) % slides.length;
  titleEl.textContent = slides[i].title;
  slideEl.replaceChildren(slides[i].body());
  slideEl.animate([{opacity: 0}, {opacity: 1}], {duration: 600});
  dots.textContent = slides.map((_, k) => (k === i ? "●" : "○")).join(" ");
  clearTimeout(timer);
  timer = setTimeout(() => go(i + 1), SLIDE_SECONDS * 1e3);
};
const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
stage.querySelector(".display-full").onclick = (e) => { e.stopPropagation(); full(); };
slideEl.onclick = () => go(i + 1);
const keys = (e) => {
  if (e.key === "ArrowRight" || e.key === " ") go(i + 1);
  else if (e.key === "ArrowLeft") go(i - 1);
  else if (e.key === "f" || e.key === "F") full();
};
addEventListener("keydown", keys);
invalidation.then(() => { clearTimeout(timer); removeEventListener("keydown", keys); });
go(0);
display(stage);
```

<style>
#observablehq-center { margin: 0 !important; max-width: none !important; }
#observablehq-main { max-width: none; padding: 0 2rem; }
.display { min-height: 100vh; display: flex; flex-direction: column; padding: 1.5rem 0; box-sizing: border-box; }
.display-top { display: flex; align-items: baseline; gap: 1.5rem; margin-bottom: 1.25rem; }
.display-title { font-size: 2.2rem; margin: 0; flex: 1; }
.display-dots { color: var(--theme-foreground-muted); letter-spacing: 0.2em; }
.display-full { background: none; border: 1px solid var(--theme-foreground-faintest); color: inherit; border-radius: 6px; font-size: 1.2rem; padding: 0.1rem 0.6rem; cursor: pointer; }
.display-slide { flex: 1; cursor: pointer; }
.display-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1.25rem; }
.display-cards img { width: 100%; }
.display .timeline-expand { display: none; }
</style>
