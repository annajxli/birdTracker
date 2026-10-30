// Today's forecast from the National Weather Service (api.weather.gov), whose Seattle forecasters
// adjust the models by hand, so it doesn't show model artifacts such as snow at 44 °F. The grid
// cell is fixed for the station: /points/47.61,-122.33 gives SEW 125,68.
export const NWS_GRID = "https://api.weather.gov/gridpoints/SEW/125,68";
// Observations from the nearest airport weather station, Boeing Field, a few miles from the yard.
export const NWS_STATION = "https://api.weather.gov/stations/KBFI";

// NWS short forecasts ("Light Rain Likely", "Partly Sunny") as the WMO weather codes the
// dashboard's icons use. "Slight Chance" and "Chance" of precipitation count as cloudy: the
// forecasters expect it less likely than not.
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
 * A Pacific day from NWS's hourly forecast, gridpoint data, and station observations: hourly
 * temperatures (°F, from the current hour on), the day's worst weather code, whether observed so
 * far or still forecast, and its precipitation (inches, the day's share of each forecast period).
 * Null when the forecast doesn't cover the day.
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

/** The newest observation with a description: {text, tempF (or null), time}. Null if none. */
export function nwsNow(observations) {
  const newest = [...observations].map((f) => f.properties).filter((o) => o.textDescription)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  if (!newest) return null;
  const c = newest.temperature?.value;
  return {text: newest.textDescription, tempF: c == null ? null : c * 9 / 5 + 32, time: new Date(newest.timestamp)};
}
