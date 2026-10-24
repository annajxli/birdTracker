import * as htl from "npm:htl";
import {PERIODS, shiftPeriod, periodLabel, calendarDays} from "./period.js";

export function periodInput({first, last}) {
  const root = htl.html`<div class="period-picker">
    <div class="period-segments" role="group" aria-label="Time range">${Object.entries(PERIODS).map(([key, name]) => htl.html`<button type="button" data-scale=${key} aria-label=${name} title=${name}>${key}</button>`)}</div>
    <div class="period-navigation">
      <button type="button" data-step="-1" aria-label="Previous day">‹</button>
      <button type="button" class="period-label" data-calendar-toggle aria-haspopup="dialog" aria-expanded="false"><span class="period-label-text" aria-live="polite"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></button>
      <button type="button" data-step="1" aria-label="Next day">›</button>
    </div>
    <div class="period-calendar" role="dialog" aria-label="Choose a date" hidden></div>
  </div>`;
  root.value = {scale: "D", date: last};
  const calendar = root.querySelector(".period-calendar");
  const trigger = root.querySelector("[data-calendar-toggle]");
  let calendarMonth = last.slice(0, 7) + "-01";
  const fullDate = (date) => new Date(date).toLocaleDateString("en-US", {timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric"});
  const closeCalendar = (focus = false) => {
    calendar.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  };
  const renderCalendar = () => {
    const cells = calendarDays(calendarMonth, root.value.scale, root.value.date);
    const focusDate = cells.some((d) => d.date === root.value.date) ? root.value.date : cells.find((d) => d.inMonth && d.date >= first && d.date <= last)?.date;
    const previous = shiftPeriod("M", calendarMonth, -1);
    const next = shiftPeriod("M", calendarMonth, 1);
    calendar.replaceChildren(htl.html`<div class="calendar-heading">
      <button type="button" data-calendar-step="-1" aria-label="Previous calendar month" disabled=${previous.end < first}>‹</button>
      <span aria-live="polite">${periodLabel("M", calendarMonth)}</span>
      <button type="button" data-calendar-step="1" aria-label="Next calendar month" disabled=${next.start > last}>›</button>
    </div>`, htl.html`<div class="calendar-weekdays" aria-hidden="true">${["M", "T", "W", "T", "F", "S", "S"].map((d) => htl.html`<span>${d}</span>`)}</div>`,
      htl.html`<div class="calendar-grid" role="grid" aria-label=${periodLabel("M", calendarMonth)}>${Array.from({length: 6}, (_, row) => htl.html`<div class="calendar-week" role="row">${cells.slice(row * 7, row * 7 + 7).map((d) => htl.html`<button type="button" role="gridcell" data-date=${d.date} class=${[d.inMonth ? "" : "outside-month", d.selected ? "in-range" : "", d.rangeStart ? "range-start" : "", d.rangeEnd ? "range-end" : "", d.date === root.value.date ? "selected-date" : ""].filter(Boolean).join(" ")} aria-label=${fullDate(d.date)} aria-selected=${String(d.selected)} tabindex=${d.date === focusDate ? 0 : -1} disabled=${d.date < first || d.date > last}>${Number(d.date.slice(-2))}</button>`)}</div>`)}</div>`);
  };
  const render = (emit = true) => {
    const {scale, date} = root.value;
    for (const button of root.querySelectorAll("[data-scale]")) button.setAttribute("aria-pressed", String(button.dataset.scale === scale));
    root.querySelector(".period-label-text").textContent = periodLabel(scale, date);
    trigger.setAttribute("aria-label", `Choose ${PERIODS[scale].toLowerCase()}: ${periodLabel(scale, date)}`);
    for (const button of root.querySelectorAll("[data-step]")) {
      const direction = Number(button.dataset.step);
      const candidate = shiftPeriod(scale, date, direction);
      button.disabled = candidate.end < first || candidate.start > last;
      button.setAttribute("aria-label", `${direction < 0 ? "Previous" : "Next"} ${PERIODS[scale].toLowerCase()}`);
    }
    if (!calendar.hidden) renderCalendar();
    if (emit) root.dispatchEvent(new Event("input", {bubbles: true}));
  };
  root.move = (direction) => {
    const candidate = shiftPeriod(root.value.scale, root.value.date, direction);
    if (candidate.end < first || candidate.start > last) return;
    root.value = {...root.value, date: candidate.start < first ? first : candidate.start > last ? last : candidate.start};
    calendarMonth = root.value.date.slice(0, 7) + "-01";
    closeCalendar();
    render();
  };
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-calendar-toggle")) {
      if (!calendar.hidden) return closeCalendar();
      calendarMonth = root.value.date.slice(0, 7) + "-01";
      renderCalendar();
      calendar.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      calendar.querySelector('[tabindex="0"]')?.focus();
    } else if (button.dataset.calendarStep) {
      calendarMonth = shiftPeriod("M", calendarMonth, Number(button.dataset.calendarStep)).start;
      renderCalendar();
      calendar.querySelector(`[data-calendar-step="${button.dataset.calendarStep}"]`)?.focus();
    } else if (button.dataset.date) {
      root.value = {...root.value, date: button.dataset.date};
      closeCalendar(true);
      render();
    } else if (button.dataset.scale) {
      root.value = {...root.value, scale: button.dataset.scale};
      render();
    } else if (button.dataset.step) root.move(Number(button.dataset.step));
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !calendar.hidden) {
      event.preventDefault();
      closeCalendar(true);
      return;
    }
    if (calendar.contains(event.target)) {
      const date = event.target.dataset.date;
      const offset = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key];
      if (!date || !offset) return;
      event.preventDefault();
      const target = new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
      if (target < first || target > last) return;
      calendarMonth = target.slice(0, 7) + "-01";
      renderCalendar();
      const cell = calendar.querySelector(`[data-date="${target}"]`);
      for (const button of calendar.querySelectorAll("[data-date]")) button.tabIndex = button === cell ? 0 : -1;
      cell?.focus();
      return;
    }
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    root.move(event.key === "ArrowLeft" ? -1 : 1);
  });
  const dismiss = (event) => { if (!root.contains(event.target)) closeCalendar(); };
  document.addEventListener("pointerdown", dismiss);
  root.destroy = () => document.removeEventListener("pointerdown", dismiss);
  render(false);
  return root;
}

export function bindPeriodSwipe(node, picker) {
  let start;
  const begin = (event) => {
    start = event.touches.length === 1 ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : null;
  };
  const end = (event) => {
    if (!start || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) picker.move(dx < 0 ? 1 : -1);
  };
  const cancel = () => { start = null; };
  node.addEventListener("touchstart", begin, {passive: true});
  node.addEventListener("touchend", end, {passive: true});
  node.addEventListener("touchcancel", cancel, {passive: true});
  return () => {
    node.removeEventListener("touchstart", begin);
    node.removeEventListener("touchend", end);
    node.removeEventListener("touchcancel", cancel);
  };
}
