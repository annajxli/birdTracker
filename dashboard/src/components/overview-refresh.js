/** Overview data checks use metadata only; the published tables change less often. */
export const OVERVIEW_REFRESH_MS = 60_000;
export const OVERVIEW_RESOURCES = {
  detections: "/api/data/detections.parquet",
  recordings: "/api/data/recordings.parquet",
  thresholds: "/api/live/thresholds.json"
};

export async function overviewVersions(fetcher = fetch) {
  const entries = await Promise.all(Object.entries(OVERVIEW_RESOURCES).map(async ([key, url]) => {
    try {
      const response = await fetcher(url, {method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(30_000)});
      return [key, response.ok ? response.headers.get("ETag") : null];
    } catch {
      return [key, null];
    }
  }));
  return Object.fromEntries(entries);
}

/** Calendar limits without tying the lifetime of the picker to a refreshing table. */
export function overviewLimits({all, recordings}, fallback) {
  let first, last;
  const include = (date) => {
    if (!date) return;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  };
  for (const row of all) include(row.date);
  const dates = recordings?.getChild("date");
  const simulated = recordings?.getChild("simulated");
  for (let i = 0; dates && i < recordings.numRows; ++i) if (!simulated?.get(i)) include(dates.get(i));
  return {first: first ?? fallback, last: last ?? fallback};
}

/** One request at a time; hidden pages and disposed Observable cells do no work. */
export function startOverviewRefresh({initial, versions, load, publish,
  probe = overviewVersions, visibility = document, focusTarget = window,
  setTimer = setTimeout, clearTimer = clearTimeout, beforeUpdate = () => {},
  onError = (error) => console.warn("Overview refresh failed; keeping the last data.", error),
  interval = OVERVIEW_REFRESH_MS}) {
  let current = initial, known = {...versions}, timer, busy = false, stopped = false;
  const visible = () => visibility.visibilityState !== "hidden";
  const cancel = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (!stopped && visible()) timer = setTimer(check, interval);
  };
  const check = async () => {
    cancel();
    if (stopped || busy || !visible()) return;
    busy = true;
    try {
      const next = await probe();
      if (stopped || !visible()) return;
      // A failed HEAD, expired session or missing optional file isn't a new version.
      const changed = Object.keys(next).filter((key) => next[key] && next[key] !== known[key]);
      if (changed.length) {
        const data = await load({previous: current, changed});
        if (stopped || !visible()) return;
        beforeUpdate();
        publish(data);
        current = data;
        for (const key of changed) known[key] = next[key];
      }
    } catch (error) {
      if (!stopped) onError(error);
      // Don't advance known versions on failure; the next check retries.
    } finally {
      busy = false;
      schedule();
    }
  };
  const resume = () => { cancel(); if (visible()) void check(); };
  visibility.addEventListener("visibilitychange", resume);
  focusTarget.addEventListener("focus", resume);
  schedule();
  return {
    check,
    stop() {
      stopped = true;
      cancel();
      visibility.removeEventListener("visibilitychange", resume);
      focusTarget.removeEventListener("focus", resume);
    }
  };
}

/** Keep scroll coordinates through async chart layout, until the viewer interacts. */
export function preserveOverviewScroll() {
  const x = window.scrollX, y = window.scrollY;
  const hold = () => window.scrollTo(x, y);
  const observer = new ResizeObserver(hold);
  observer.observe(document.querySelector("main") ?? document.body);
  const release = () => {
    observer.disconnect();
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) window.removeEventListener(event, release);
  };
  const frame = requestAnimationFrame(hold);
  const timer = setTimeout(release, 2500);
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) window.addEventListener(event, release, {passive: true});
  return release;
}
