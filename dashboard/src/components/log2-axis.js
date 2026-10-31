// A count axis in powers of two. A log axis has no zero, so it starts at 2⁻¹ (LOG2_FLOOR), where
// bars start, which leaves a count of 1 a visible length.
export const LOG2_FLOOR = 0.5;

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const power2 = (power) => `2${[...String(power)].map((digit) => SUPERSCRIPT[digit]).join("")}`;

export function log2Axis(max, maxTicks = 5) {
  const top = Math.max(1, Math.ceil(Math.log2(Math.max(1, max || 1))));
  const step = Math.ceil((top + 1) / maxTicks);
  const ticks = [];
  for (let power = 0; power <= top; power += step) ticks.push(2 ** power);
  return {type: "log", base: 2, domain: [LOG2_FLOOR, 2 ** top], ticks, tickFormat: (v) => power2(Math.round(Math.log2(v)))};
}
