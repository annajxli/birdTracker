/** Clamp only the text; the recording's start/end geometry stays unchanged. */
export function liveLabelLeft(start, width, viewLeft, viewRight) {
  return Math.max(viewLeft, Math.min(start, viewRight - width));
}
