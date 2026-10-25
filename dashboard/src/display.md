---
title: Display
toc: false
header: false
footer: false
---

<link rel="stylesheet" href="./components/birds.css">

<!-- A slideshow of the overview's charts for a screen on the wall: full width, one at a time,
     advancing every SLIDE_SECONDS. Arrow keys or a tap step through; F or the button goes
     fullscreen. Reloads every RELOAD_MINUTES to pick up new detections. -->

<div class="display-skeleton" aria-hidden="true"><div class="skeleton" data-skeleton="cards" style="height: 70vh"><observablehq-loading></observablehq-loading></div></div>

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
// The window's height, live: entering fullscreen or resizing re-fits the slides in place
// (reloading here would drop out of fullscreen).
const screenSize = Generators.observe((notify) => {
  // Window resize events alone can fire before fullscreen has settled, so also watch the
  // page's own box and the fullscreen change, and report the size once it stops changing.
  let last = "", frame;
  const update = () => {
    clearTimeout(frame);
    frame = setTimeout(() => {
      const size = {width: document.documentElement.clientWidth, height: innerHeight};
      const key = `${size.width}x${size.height}`;
      if (key !== last) { last = key; notify(size); }
    }, 60);
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(document.documentElement);
  addEventListener("resize", update);
  document.addEventListener("fullscreenchange", update);
  // Some changes (a viewport resize without a resize event) report no event at all; a cheap
  // check twice a second catches them.
  const poll = setInterval(update, 500);
  return () => { observer.disconnect(); clearInterval(poll); removeEventListener("resize", update); document.removeEventListener("fullscreenchange", update); };
});
```

```js
const W = screenSize.width - 64; // the whole screen, less the page's side padding
const H = Math.max(360, screenSize.height - 150); // room under the title bar
const inSpan = (dates) => { const s = new Set(dates); return confident.filter((d) => s.has(d.date)); };

// Most heard this week, by minutes heard: as many bars as fit.
const weekRows = minutesHeard(inSpan(week));
const weekMinutes = d3.rollups(weekRows, (v) => v.length, (d) => d.species)
  .sort((a, b) => b[1] - a[1]).slice(0, Math.max(5, Math.floor((H - 80) / 34))).map(([species, count]) => ({species, count}));
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
// Recently heard is laid out by CSS, not measured: a 5 × 2 grid that fills the screen below
// the title (one row on very short screens), each card a column of photo, text and a
// histogram that split the card's height about 60/40. So entering fullscreen or resizing
// re-fits it instantly, with no JavaScript involved.
const MAX_CARDS = 10;
const shown = recentSpecies(confident, {limit: MAX_CARDS});
const dayLetter = (d) => new Date(d).toLocaleDateString("en-US", {timeZone: "UTC", weekday: "narrow"});
// Minutes heard per day this week. Every card shares one scale (the busiest bird-day on screen);
// the first card in each row shows it: a 0 tick and the top value.
const dailyMax = d3.max(shown, ({species}) => d3.max(week, (d) => perDay.get(species)?.get(d) ?? 0)) || 1;
const spark = (species) => html`<div class="display-hist">
  <div class="display-hist-axis"><span>${d3.format(",.0f")(dailyMax)} min</span><span></span></div>
  <div class="display-hist-bars">${week.map((d) => {
    const v = perDay.get(species)?.get(d) ?? 0;
    return html`<div class="display-hist-day" title=${`${v} min`}><div class="display-hist-track"><div class="display-hist-bar" style=${`height: ${100 * v / dailyMax}%`}></div></div><span>${dayLetter(d)}</span></div>`;
  })}</div>
</div>`;
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
  {title: "Recently heard", body: () => html`<div class="display-cards">${shown.map(card)}</div>`},
  {title: `Today · ${formatDate(latest)}`, body: () => timeline([latest], 1)},
  {title: `This week · ${dateRange(week[0], latest)}`, body: () => timeline(week, 7)},
  {title: "Most heard this week", body: () => Plot.plot({
    width: W, height: Math.min(H, weekMinutes.length * 34 + 70), marginLeft: nameMargin(W) + 60, marginRight: 60, marginBottom: 64, style: {fontSize: "16px"},
    x: {label: "Minutes heard", labelAnchor: "center", labelArrow: "none", labelOffset: 52}, y: {label: null, domain: weekMinutes.map((d) => d.species)},
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
    <button class="display-pause" type="button" title="Pause (P)" aria-label="Pause" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="icon-pause" d="M8 5v14M16 5v14"/><path class="icon-play" d="M8 5l11 7-11 7z"/></svg></button>
    <button class="display-full" type="button" title="Fullscreen (F)">⛶</button>
    <a class="display-home" href="./" title="Back to the overview" aria-label="Back to the overview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/></svg></a></div>
  <div class="display-slide"></div>
</div>`;
// Re-fitting rebuilds this cell; carry on from the same slide and pause state.
let i = window.__displaySlide ?? 0;
const titleEl = stage.querySelector(".display-title"), slideEl = stage.querySelector(".display-slide"), dots = stage.querySelector(".display-dots"), ring = stage.querySelector(".display-timer .ring");
const go = (n) => {
  i = window.__displaySlide = (n + slides.length) % slides.length;
  titleEl.textContent = slides[i].title;
  slideEl.replaceChildren(slides[i].body());
  slideEl.animate([{opacity: 0}, {opacity: 1}], {duration: 600});
  dots.textContent = slides.map((_, k) => (k === i ? "●" : "○")).join(" ");
  ring.getAnimations().forEach((a) => a.cancel());
  const ringAnim = ring.animate([{strokeDashoffset: 0}, {strokeDashoffset: 100}], {duration: SLIDE_SECONDS * 1e3, easing: "linear", fill: "forwards"});
  ringAnim.onfinish = () => go(i + 1); // the ring is the clock, so pausing it pauses the slideshow
  if (paused) ringAnim.pause();
};
const full = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
// Pause/play: freezes the ring (and with it the next-slide clock) where it is.
let paused = window.__displayPaused ?? false;
const pauseBtn = stage.querySelector(".display-pause");
const setPaused = (p) => {
  paused = window.__displayPaused = p;
  ring.getAnimations().forEach((a) => (p ? a.pause() : a.play()));
  pauseBtn.setAttribute("aria-pressed", String(p));
  pauseBtn.setAttribute("aria-label", p ? "Play" : "Pause");
  pauseBtn.title = p ? "Play (P)" : "Pause (P)";
  stage.classList.toggle("paused", p);
};
pauseBtn.onclick = (e) => { e.stopPropagation(); setPaused(!paused); };
stage.querySelector(".display-full").onclick = (e) => { e.stopPropagation(); full(); };
slideEl.onclick = () => go(i + 1);
const keys = (e) => {
  if (e.key === "ArrowRight" || e.key === " ") go(i + 1);
  else if (e.key === "ArrowLeft") go(i - 1);
  else if (e.key === "f" || e.key === "F") full();
  else if (e.key === "p" || e.key === "P") setPaused(!paused);
};
addEventListener("keydown", keys);

invalidation.then(() => { ring.getAnimations().forEach((a) => a.cancel()); removeEventListener("keydown", keys); });
setPaused(paused);
go(i);
display(stage);
```

<style>
.display-skeleton { padding: 7rem 0 0; }
body:has(.display) .display-skeleton { display: none; }
body { max-width: none !important; margin: 0 !important; }
#observablehq-center { margin: 0 !important; max-width: none !important; padding: 0 !important; }
#observablehq-main { max-width: none !important; width: 100%; padding: 0 32px; box-sizing: border-box; margin: 0 !important; }
.display { min-height: 100vh; display: flex; flex-direction: column; padding: 1.5rem 0; box-sizing: border-box; }
.display-top { display: flex; align-items: center; gap: 1.5rem; margin-bottom: 1.25rem; }
.display-title { font-size: 2.2rem; margin: 0; flex: 1; }
.display-dots { color: var(--theme-foreground-muted); letter-spacing: 0.2em; }
.display-full { background: none; border: 1px solid var(--theme-foreground-faintest); color: inherit; border-radius: 6px; font-size: 1.2rem; padding: 0.1rem 0.6rem; cursor: pointer; }
.display-slide { flex: 1; cursor: pointer; }
.display-cards { display: grid; gap: 20px; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); height: calc(100vh - 150px); }
@media (max-height: 480px) { .display-cards { grid-template-rows: minmax(0, 1fr); grid-auto-rows: 0; overflow: hidden; } }
@media (max-width: 900px) { .display-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); } .display-card:nth-child(n+7) { display: none; } }
.display-card { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.display-photo { flex: 62 1 0; min-height: 60px; border-radius: 8px; overflow: hidden; background: var(--theme-background-alt); }
.display-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.display-name { flex: none; font-size: 1.25rem; font-weight: 600; margin-top: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.display-meta { flex: none; color: var(--theme-foreground-muted); font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.display-hist { flex: 38 1 0; min-height: 50px; display: flex; gap: 6px; margin-top: 0.6rem; font-size: 11px; color: var(--theme-foreground-muted); }
.display-hist-axis { display: none; flex-direction: column; justify-content: space-between; padding-bottom: 18px; text-align: right; white-space: nowrap; }
.display-card:nth-child(5n + 1) .display-hist-axis { display: flex; }
@media (max-width: 900px) { .display-card:nth-child(5n + 1) .display-hist-axis { display: none; } .display-card:nth-child(3n + 1) .display-hist-axis { display: flex; } }
.display-hist-axis span:last-child { border-top: 1px solid currentColor; width: 4px; align-self: flex-end; }
.display-hist-bars { flex: 1; display: flex; gap: 6%; align-items: stretch; border-bottom: 0; }
.display-hist-day { flex: 1; display: grid; grid-template-rows: minmax(0, 1fr) 18px; text-align: center; }
.display-hist-track { display: flex; align-items: flex-end; border-bottom: 1px solid color-mix(in srgb, currentColor 35%, transparent); }
.display-hist-bar { width: 100%; background: #8aa83a; border-radius: 2px 2px 0 0; min-height: 1px; }
.display-hist-day span { height: 18px; line-height: 18px; }
.display-meta b { color: var(--theme-foreground); font-weight: 600; }
.display-home { border: 1px solid var(--theme-foreground-faintest); color: inherit; border-radius: 6px; width: 34px; height: 30px; display: grid; place-items: center; }
.display-home svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.display-pause { background: none; border: 1px solid var(--theme-foreground-faintest); color: inherit; border-radius: 6px; width: 34px; height: 30px; padding: 0; cursor: pointer; display: grid; place-items: center; }
.display-pause svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.display-pause .icon-play { display: none; fill: currentColor; stroke-width: 1.5; }
.display.paused .display-pause .icon-play { display: inline; }
.display.paused .display-pause .icon-pause { display: none; }
.display-timer { width: 26px; height: 26px; transform: rotate(-90deg); }
.display-timer circle { fill: none; stroke-width: 3; }
.display-timer .track { stroke: var(--theme-foreground-faintest); }
.display-timer .ring { stroke: var(--theme-foreground-muted); stroke-dasharray: 100; stroke-linecap: round; }
.display .timeline-expand { display: none; }
.display-slide svg[class^="plot"] { font-size: 15px; }
</style>
