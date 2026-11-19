// Today's forecast from the National Weather Service (api.weather.gov), hand-adjusted by Seattle
// forecasters so it avoids model artifacts. Grid cell fixed: /points/47.68,-122.26 gives SEW 128,71.
export const NWS_GRID = "https://api.weather.gov/gridpoints/SEW/128,71";
// Weather conditions ("Light Rain", "Cloudy") come from the nearest airport station.
export const NWS_STATION = "https://api.weather.gov/stations/KBFI";
// Current temperature: the nearest hourly station, which reports no conditions and skips hours,
// so the airport's temperature stands in when it's stale.
export const NWS_TEMP_STATION = "https://api.weather.gov/stations/SEAW1";
export const TEMP_MAX_AGE_MS = 2 * 36e5;
// Request time limit before falling back to built-in weather, so a stall can't blank the charts.
export const WEATHER_TIMEOUT_MS = 8000;

/** JSON from url, rejecting on an HTTP error or after timeoutMs. */
export function fetchJSON(url, {headers, timeoutMs = WEATHER_TIMEOUT_MS, fetcher = fetch} = {}) {
  return fetcher(url, {headers, signal: AbortSignal.timeout(timeoutMs)}).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
}

// NWS short forecasts as the dashboard's WMO codes. "Slight Chance" and "Chance" count as cloudy
// (less likely than not).
export function nwsCode(text) {
  const t = text.toLowerCase();
  const likely = !/chance/.test(t) || /likely/.test(t);
  if (likely && /thunder/.test(t)) return 95;
  if (likely && /snow|sleet|flurr/.test(t)) return 73;
  if (likely && /rain|shower/.test(t)) return 63;
  if (likely && /drizzle/.test(t)) return 53;
  if (/fog/.test(t)) return 45;
  if (/chance/.test(t) || /mostly cloudy|cloudy|overcast/.test(t)) return 3;
  if (/partly/.test(t)) return 2;
  return 0; // sunny, clear, mostly sunny, mostly clear
}

// How bad each code is, so a day takes its worst hour, as Open-Meteo's daily codes do.
const severity = (code) => (code >= 95 ? 6 : code >= 71 ? 5 : code >= 61 ? 4 : code >= 51 ? 3 : code === 45 ? 2 : code === 3 ? 1 : code === 2 ? 0.5 : 0);

const pacificDate = (t) => new Date(t).toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
const pacificHour = (t) => +new Date(t).toLocaleString("en-US", {timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23"});

/**
 * A Pacific day from NWS forecast, gridpoint, and observation data: hourly °F from the current
 * hour, the worst weather code, whether observed or forecast, and precipitation (inches, the
 * day's share of each period). Null when the forecast doesn't cover the day.
 */
export function nwsDay(day, hourlyPeriods, quantitativePrecipitation, observations = []) {
  const hourly = Array(24).fill(null);
  let code = null;
  for (const p of hourlyPeriods) {
    if (pacificDate(p.startTime) !== day) continue;
    hourly[pacificHour(p.startTime)] = p.temperatureUnit === "C" ? p.temperature * 9 / 5 + 32 : p.temperature;
    const c = nwsCode(p.shortForecast);
    if (code === null || severity(c) > severity(code)) code = c;
  }
  if (code === null) return null;
  for (const {properties: o} of observations) {
    if (!o.textDescription || pacificDate(o.timestamp) !== day) continue;
    const c = nwsCode(o.textDescription);
    if (severity(c) > severity(code)) code = c;
  }
  // Periods are "START/PTnH": spread each period's amount evenly over its hours.
  let mm = 0;
  for (const {validTime, value} of quantitativePrecipitation?.values ?? []) {
    const [start, duration] = validTime.split("/");
    const hours = +(/PT?(?:(\d+)D)?T?(?:(\d+)H)?/.exec(duration) ?? []).slice(1).reduce((h, v, i) => h + (v ? +v * (i ? 1 : 24) : 0), 0);
    for (let h = 0; h < hours; h++) if (pacificDate(Date.parse(start) + h * 36e5) === day) mm += value / hours;
  }
  return {hourly, code, precip: Math.round(mm / 25.4 * 100) / 100};
}

const celsiusToF = (c) => (c == null ? null : c * 9 / 5 + 32);

/**
 * The airport's newest described observation: {text, time, tempF, tempTime, nearTemp}. The
 * temperature comes from tempObservations when under TEMP_MAX_AGE_MS old (nearTemp), else the
 * airport. Null if no observation has a description.
 */
export function nwsNow(observations, tempObservations = [], now = Date.now()) {
  const newest = (list, keep) => [...list].map((f) => f.properties).filter(keep)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  const sky = newest(observations, (o) => o.textDescription);
  if (!sky) return null;
  const near = newest(tempObservations, (o) => o.temperature?.value != null);
  const fresh = near && now - Date.parse(near.timestamp) < TEMP_MAX_AGE_MS;
  const temp = fresh ? near : sky;
  return {text: sky.textDescription, time: new Date(sky.timestamp), tempF: celsiusToF(temp.temperature?.value),
    tempTime: new Date(temp.timestamp), nearTemp: Boolean(fresh)};
}
