/** Clamp only the text; the recording's start/end geometry stays unchanged. */
export function liveLabelLeft(start, width, viewLeft, viewRight, leading = 0) {
  return Math.max(viewLeft + leading, Math.min(start, viewRight - width));
}
