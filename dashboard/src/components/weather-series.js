/** Extend each contiguous weather run to its own half-day edges, never over missing dates. */
export function dailyTemperatureSeries(dates, weather) {
  const days = [], edges = [];
  let run = [], segment = 0;
  const flush = () => {
    if (!run.length) return;
    const first = run[0], last = run.at(-1), halfDay = 12 * 36e5;
    edges.push({...first, day: new Date(+first.day - halfDay)}, ...run,
      {...last, day: new Date(+last.day + halfDay)});
    run = [];
    segment++;
  };
  for (const date of dates) {
    const w = weather[date];
    if (!w || !Number.isFinite(w.low) || !Number.isFinite(w.high)) { flush(); continue; }
    const day = new Date(date);
    if (run.length && +day - +run.at(-1).day !== 864e5) flush();
    const row = {...w, date, day, segment};
    days.push(row);
    run.push(row);
  }
  flush();
  return {days, edges};
}
