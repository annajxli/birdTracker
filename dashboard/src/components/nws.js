// Today's forecast from the National Weather Service (api.weather.gov), whose Seattle forecasters
// adjust the models by hand, so it doesn't show model artifacts such as snow at 44 °F. The grid
// cell is fixed for the station: /points/47.61,-122.33 gives SEW 125,68.
export const NWS_GRID = "https://api.weather.gov/gridpoints/SEW/125,68";

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
 * The rest of a Pacific day from NWS's hourly forecast and gridpoint data: hourly temperatures
 * (°F, from the current hour on), the day's worst weather code, and its precipitation (inches,
 * the day's share of each forecast period). Null when the forecast doesn't cover the day.
 */
export function nwsDay(day, hourlyPeriods, quantitativePrecipitation) {
  const hourly = Array(24).fill(null);
  let code = null;
  for (const p of hourlyPeriods) {
    if (pacificDate(p.startTime) !== day) continue;
    hourly[pacificHour(p.startTime)] = p.temperatureUnit === "C" ? p.temperature * 9 / 5 + 32 : p.temperature;
    const c = nwsCode(p.shortForecast);
    if (code === null || severity(c) > severity(code)) code = c;
  }
  if (code === null) return null;
  // Periods are "START/PTnH": spread each period's amount evenly over its hours.
  let mm = 0;
  for (const {validTime, value} of quantitativePrecipitation?.values ?? []) {
    const [start, duration] = validTime.split("/");
    const hours = +(/PT?(?:(\d+)D)?T?(?:(\d+)H)?/.exec(duration) ?? []).slice(1).reduce((h, v, i) => h + (v ? +v * (i ? 1 : 24) : 0), 0);
    for (let h = 0; h < hours; h++) if (pacificDate(Date.parse(start) + h * 36e5) === day) mm += value / hours;
  }
  return {hourly, code, precip: Math.round(mm / 25.4 * 100) / 100};
}
