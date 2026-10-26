export const PERIODS = {D: "Day", W: "Week", M: "Month", Y: "Year", A: "All time"};

// "All time" has no calendar bounds of its own; callers clamp it to the data's first and last day.
const ALL_TIME = {start: "0001-01-01", end: "9999-12-31"};

export const TRAILING_DAYS = {W: 7, M: 30, Y: 365};

export function periodBounds(scale, date) {
  if (scale === "A") return {...ALL_TIME};
  const end = new Date(`${date}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - ((TRAILING_DAYS[scale] ?? 1) - 1));
  return {start: start.toISOString().slice(0, 10), end: date};
}

export function shiftPeriod(scale, date, direction) {
  if (scale === "A") return {...ALL_TIME};
  const anchor = new Date(`${date}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + direction * (TRAILING_DAYS[scale] ?? 1));
  return periodBounds(scale, anchor.toISOString().slice(0, 10));
}

export function periodLabel(scale, date) {
  if (scale === "A") return "All time";
  const options = {timeZone: "UTC"};
  const {start, end} = periodBounds(scale, date);
  const format = (d) => new Date(d).toLocaleDateString("en-US", {...options, month: "short", day: "numeric", year: "numeric"});
  if (scale === "D") return format(date);
  if (scale === "Y" || (scale === "M" && start.slice(0, 4) !== end.slice(0, 4))) return `${format(start)} – ${format(end)}`;
  // Weeks are compact, with no year: "Oct 18 – 24", "Sep 28 – Oct 4", "Dec 28 – Jan 3".
  const short = (d) => new Date(d).toLocaleDateString("en-US", {...options, month: "short", day: "numeric"});
  return start.slice(0, 7) === end.slice(0, 7) ? `${short(start)} – ${Number(end.slice(8, 10))}` : `${short(start)} – ${short(end)}`;
}

export function calendarDays(month, scale, selectedDate) {
  const first = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCDate(1 - first.getUTCDay()); // calendar rows start on Sunday
  const selected = periodBounds(scale, selectedDate);
  // A trailing week ending early in the month can begin before the normal first
  // calendar row. Keep that entire selected range visible.
  if (scale === "W" && selectedDate.slice(0, 7) === month.slice(0, 7) && selected.start < first.toISOString().slice(0, 10)) {
    first.setUTCDate(first.getUTCDate() - 7);
  }
  return Array.from({length: 42}, (_, i) => {
    const date = new Date(+first + i * 86400000).toISOString().slice(0, 10);
    return {date, inMonth: date.slice(0, 7) === month.slice(0, 7),
      selected: date >= selected.start && date <= selected.end,
      rangeStart: date === selected.start || i % 7 === 0,
      rangeEnd: date === selected.end || i % 7 === 6};
  });
}

/** Period views retain their complete span; only All time follows data bounds. */
export function overviewBounds(scale, date, first, last) {
  return scale === "A" ? {start: first, end: last} : periodBounds(scale, date);
}
