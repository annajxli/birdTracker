export const PERIODS = {D: "Day", W: "Week", M: "Month", Y: "Year"};

export function periodBounds(scale, date) {
  const start = new Date(`${date}T00:00:00Z`);
  if (scale === "W") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (scale === "M") start.setUTCDate(1);
  if (scale === "Y") start.setUTCMonth(0, 1);
  const next = new Date(start);
  if (scale === "D") next.setUTCDate(next.getUTCDate() + 1);
  if (scale === "W") next.setUTCDate(next.getUTCDate() + 7);
  if (scale === "M") next.setUTCMonth(next.getUTCMonth() + 1);
  if (scale === "Y") next.setUTCFullYear(next.getUTCFullYear() + 1);
  const key = (d) => d.toISOString().slice(0, 10);
  return {start: key(start), end: key(new Date(+next - 86400000))};
}

export function shiftPeriod(scale, date, direction) {
  const bounds = periodBounds(scale, date);
  const edge = new Date(`${direction < 0 ? bounds.start : bounds.end}T00:00:00Z`);
  edge.setUTCDate(edge.getUTCDate() + (direction < 0 ? -1 : 1));
  return periodBounds(scale, edge.toISOString().slice(0, 10));
}

export function periodLabel(scale, date) {
  const options = {timeZone: "UTC"};
  if (scale === "M") return new Date(date).toLocaleDateString("en-US", {...options, month: "long", year: "numeric"});
  if (scale === "Y") return date.slice(0, 4);
  const {start, end} = periodBounds(scale, date);
  const format = (d) => new Date(d).toLocaleDateString("en-US", {...options, month: "short", day: "numeric", year: "numeric"});
  if (scale === "D") return format(date);
  const from = new Date(start).toLocaleDateString("en-US", {...options, month: "short", day: "numeric", ...(start.slice(0, 4) !== end.slice(0, 4) ? {year: "numeric"} : {})});
  const to = start.slice(0, 7) === end.slice(0, 7)
    ? `${Number(end.slice(8, 10))}, ${end.slice(0, 4)}`
    : format(end);
  return `${from} – ${to}`;
}

export function calendarDays(month, scale, selectedDate) {
  const first = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCDate(1 - (first.getUTCDay() + 6) % 7);
  const selected = periodBounds(scale, selectedDate);
  return Array.from({length: 42}, (_, i) => {
    const date = new Date(+first + i * 86400000).toISOString().slice(0, 10);
    return {date, inMonth: date.slice(0, 7) === month.slice(0, 7),
      selected: date >= selected.start && date <= selected.end,
      rangeStart: date === selected.start || i % 7 === 0,
      rangeEnd: date === selected.end || i % 7 === 6};
  });
}
