import {PERIODS} from "./period.js";

/** Restore a shareable calendar selection, bounded by the available dataset. */
export function readPeriodSelection(search, first, last) {
  const params = new URLSearchParams(search);
  const requestedScale = params.get("span");
  const scale = Object.hasOwn(PERIODS, requestedScale) ? requestedScale : "D";
  const requestedDate = params.get("date");
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate ?? "") ? new Date(`${requestedDate}T00:00:00Z`) : null;
  const valid = parsed && Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === requestedDate;
  const date = valid ? (requestedDate < first ? first : requestedDate > last ? last : requestedDate) : last;
  return {scale, date};
}

export function writePeriodSelection(search, {scale, date}) {
  const params = new URLSearchParams(search);
  params.set("span", scale);
  params.set("date", date);
  return params.toString();
}
