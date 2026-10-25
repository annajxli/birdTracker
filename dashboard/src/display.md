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
import {loadDetections, loadPhotos, loadSun, loadCategories, recentSpecies, dayTimeline, minutesHeard, birdsongMinutes, seriesColor, sequential, nameMargin, nameAxis, dateSpan, dateRange, formatDate, addDays} from "./components/birds.js";
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
const W = width;
const H = Math.max(360, innerHeight - 150); // room under the title bar
const inSpan = (dates) => { const s = new Set(dates); return confident.filter((d) => s.has(d.date)); };

// Most heard this week, by minutes heard: as many bars as fit.
const weekRows = minutesHeard(inSpan(week));
const weekMinutes = d3.rollups(weekRows, (v) => v.length, (d) => d.species)
  .sort((a, b) => b[1] - a[1]).slice(0, Math.max(5, Math.floor((H - 50) / 34))).map(([species, count]) => ({species, count}));
const perDay = d3.rollup(weekRows, (v) => v.length, (d) => d.species, (d) => d.date);

// When the yard is loud across the year (as on the overview): minutes of birdsong per day by week and hour.
const yearRows = inSpan(yearDates);
const weekOf = (date) => +d3.utcWeek.floor(new Date(date));
const weekDays = d3.rollup(yearDates, (v) => v.length, weekOf);
const weeks = [...weekDays.keys()].sort(d3.ascending);
const byWeekHour = d3.rollup(yearRows, (v) => new Set(v.map((d) => Math.floor(+d.time / 6e4))).size, (d) => weekOf(d.date), (d) => d.hour);
// Each week's mid-week sunrise and sunset, as wall-clock hours.
const wallHours = (iso) => { const [h, m] = new Date(iso).toLocaleTimeString("en-GB", {timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit"}).split(":"); return +h + m / 60; };
const weekSun = weeks.map((w, row) => { const mid = sun[new Date(w + 3 * 864e5).toISOString().slice(0, 10)]; return mid && {row, sunrise: wallHours(mid.sunrise), sunset: wallHours(mid.sunset)}; }).filter(Boolean);
const grid = weeks.flatMap((w, row) => d3.range(24).map((hour) => ({row, hour, perDay: (byWeekHour.get(w)?.get(hour) ?? 0) / weekDays.get(w)})));

// A daily-rhythm timeline that fills the screen: open as many categories as fit (smallest first,
// so the most categories show their species), then stretch the rows to use the height.
const timeline = (dates, spanDays) => {
  const rows = inSpan(dates);
  const sizes = d3.rollups(rows, (v) => new Set(v.map((d) => d.species)).size, (d) => categories.species[d.species] ?? "Other");
  const budget = (H - 60) / 17;
  let units = sizes.length * 1.6;
  const open = new Set();
  for (const [cat, n] of [...sizes].sort((a, b) => a[1] - b[1])) if (units + n <= budget) { open.add(cat); units += n; }
  const overrides = new Map(categories.order.concat("Other").map((c) => [c, !open.has(c)]));
  return dayTimeline(rows, sun, dates, {spanDays, categories, width: W, dark, daylightOnly: true, overrides, rowPx: Math.min(34, (H - 60) / units)});
};

// Recently heard: photo cards (fixed 4:3 crop) with a few numbers and this week's minutes per day.
const clock = (t) => t.toLocaleTimeString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit"});
const cols = Math.max(2, Math.floor(W / 250));
const cardW = (W - (cols - 1) * 20) / cols;
const perCol = Math.max(1, Math.floor((H + 20) / (cardW * 0.75 + 120)));
// Minutes heard per day this week, labelled by day. No y axis: every card shares one scale (the
// tallest bar on screen is the busiest bird-day), so the bars compare across cards.
const dayLetter = (d) => new Date(d).toLocaleDateString("en-US", {timeZone: "UTC", weekday: "narrow"});
const shownSpecies = recentSpecies(confident, {limit: cols * perCol}).map((r) => r.species);
const dailyMax = d3.max(shownSpecies, (sp) => d3.max(week, (d) => perDay.get(sp)?.get(d) ?? 0)) || 1;
const spark = (species) => Plot.plot({
  width: cardW, height: 62, marginTop: 4, marginLeft: 0, marginRight: 0, marginBottom: 18, style: {fontSize: "11px"},
  x: {type: "band", domain: week, tickFormat: dayLetter, tickSize: 0, label: null, padding: 0.25},
  y: {domain: [0, dailyMax], axis: null},
  marks: [Plot.barY(week, {x: (d) => d, y: (d) => perDay.get(species)?.get(d) ?? 0, fill: seriesColor(dark), rx2: 2}), Plot.ruleY([0], {strokeOpacity: 0.3})]
});
const card = ({species, times}) => {
  const p = photos[species], mins = d3.sum(week, (d) => perDay.get(species)?.get(d) ?? 0);
  return html`<div class="display-card">
    <div class="display-photo">${p ? html`<img src=${p.image} alt="" style=${`object-position: ${p.focus.x * 100}% ${p.focus.y * 100}%`}>` : ""}</div>
    <div class="display-name">${species}</div>
    <div class="display-meta"><b>${clock(times[0])}</b> · avg <b>${d3.format(".1f")(mins / week.length)}</b> min/day this week</div>
    ${spark(species)}
  </div>`;
};

const slides = [
  {title: "Recently heard", body: () => html`<div class="display-cards" style=${`grid-template-columns: repeat(${cols}, 1fr)`}>${recentSpecies(confident, {limit: cols * perCol}).map(card)}</div>`},
  {title: `Today · ${formatDate(latest)}`, body: () => timeline([latest], 1)},
  {title: `This week · ${dateRange(week[0], latest)}`, body: () => timeline(week, 7)},
  {title: "Most heard this week", body: () => Plot.plot({
    width: W, height: Math.min(H, weekMinutes.length * 34 + 50), marginLeft: nameMargin(W) + 60, marginRight: 60, style: {fontSize: "16px"},
    x: {label: "Minutes heard", labelAnchor: "center", labelArrow: "none"}, y: {label: null, domain: weekMinutes.map((d) => d.species)},
    marks: [
      Plot.barX(weekMinutes, {x: "count", y: "species", fill: seriesColor(dark), insetTop: 7, insetBottom: 7, rx2: 4}),
      Plot.text(weekMinutes, {x: "count", y: "species", text: (d) => d3.format(",")(d.count), dx: 8, textAnchor: "start", fill: "currentColor"}),
      Plot.ruleX([0], {strokeOpacity: 0.3})
    ]
  })},
  {title: "Birdsong through the year", body: () => Plot.plot({
    width: W, height: H - 60, marginLeft: 60, marginTop: 24, style: {fontSize: "15px"},
    x: {domain: [0, 24], ticks: [0, 6, 12, 18, 24], tickFormat: (h) => ["12a", "6a", "12p", "6p", "12a"][h / 6], label: null},
    y: {domain: [weeks.length, 0], ticks: weeks.map((w, i) => i).filter((i) => i > 0 && new Date(weeks[i]).getUTCMonth() !== new Date(weeks[i - 1]).getUTCMonth()).map((i) => i + 0.5),
      tickFormat: (y) => new Date(weeks[Math.floor(y)]).toLocaleDateString("en-US", {timeZone: "UTC", month: "short"}), tickSize: 0, label: null},
    color: sequential(dark, {type: "sqrt", legend: true, label: "Minutes of birdsong per day, by hour", domain: [0, Math.max(1, d3.quantile(grid, 0.995, (d) => d.perDay))], clamp: true, marginLeft: 60}),
    marks: [
      Plot.rect(grid, {x1: "hour", x2: (d) => d.hour + 1, y1: "row", y2: (d) => d.row + 1, fill: "perDay"}),
      ...["sunrise", "sunset"].map((k) => Plot.line(weekSun, {x: k, y: (d) => d.row + 0.5, stroke: "currentColor", strokeOpacity: 0.75, strokeDasharray: "4,4", strokeWidth: 1.5, curve: "monotone-y"})),
      weekSun.length ? Plot.text([["sunrise", weekSun[0].sunrise], ["sunset", weekSun[0].sunset]], {x: ([, h]) => h, y: 0, text: ([k]) => k, dy: -9, fontSize: 13, fill: "currentColor", fillOpacity: 0.8}) : null
    ]
  })}
];
```

```js
const stage = html`<div class="display">
  <div class="display-top"><h1 class="display-title"></h1><span class="display-dots"></span>
    <svg class="display-timer" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" class="track"></circle><circle cx="12" cy="12" r="9" class="ring" pathLength="100"></circle></svg>
    <button class="display-full" type="button" title="Fullscreen (F)">⛶</button></div>
  <div class="display-slide"></div>
</div>`;
let i = 0, timer;
const titleEl = stage.querySelector(".display-title"), slideEl = stage.querySelector(".display-slide"), dots = stage.querySelector(".display-dots"), ring = stage.querySelector(".display-timer .ring");
const go = (n) => {
  i = (n + slides.length) % slides.length;
  titleEl.textContent = slides[i].title;
  slideEl.replaceChildren(slides[i].body());
  slideEl.animate([{opacity: 0}, {opacity: 1}], {duration: 600});
  dots.textContent = slides.map((_, k) => (k === i ? "●" : "○")).join(" ");
  ring.getAnimations().forEach((a) => a.cancel());
  ring.animate([{strokeDashoffset: 0}, {strokeDashoffset: 100}], {duration: SLIDE_SECONDS * 1e3, easing: "linear", fill: "forwards"});
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
let resized;
const onResize = () => { clearTimeout(resized); resized = setTimeout(() => location.reload(), 500); }; // re-fit to the new size
addEventListener("resize", onResize);
invalidation.then(() => { clearTimeout(timer); removeEventListener("keydown", keys); removeEventListener("resize", onResize); });
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
.display-cards { display: grid; gap: 20px; }
.display-card { min-width: 0; }
.display-photo { aspect-ratio: 4 / 3; border-radius: 8px; overflow: hidden; background: var(--theme-background-alt); }
.display-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.display-name { font-size: 1.25rem; font-weight: 600; margin-top: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.display-meta { color: var(--theme-foreground-muted); font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.display-meta b { color: var(--theme-foreground); font-weight: 600; }
.display-timer { width: 26px; height: 26px; transform: rotate(-90deg); }
.display-timer circle { fill: none; stroke-width: 3; }
.display-timer .track { stroke: var(--theme-foreground-faintest); }
.display-timer .ring { stroke: var(--theme-foreground-muted); stroke-dasharray: 100; stroke-linecap: round; }
.display .timeline-expand { display: none; }
.display-slide g[aria-label="y-axis tick label"] text { font-size: 15px; }
</style>
