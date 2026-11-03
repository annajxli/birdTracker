const LEVEL = {good: 0, warning: 1, critical: 2};

/**
 * How far a reading has moved toward trouble, from 0 (Good) through 1 (where Okay starts) to 2
 * (where Bad starts), for coloring a history bar on a continuous ramp. Zones are [from, to,
 * level], ascending and contiguous. In a Good zone, the reading starts to warm one neighboring
 * zone's width before that zone begins, or a quarter of the Good zone's width if that's
 * smaller; across an Okay zone, it moves evenly from 1 to 2 toward
 * its Bad side.
 */
export function stripSeverity(value, zones) {
  const lo = zones[0][0], hi = zones.at(-1)[1], v = Math.max(lo, Math.min(hi, value));
  let i = zones.findIndex((z) => v < z[1]);
  if (i < 0) i = zones.length - 1;
  const [from, to, level] = zones[i], left = zones[i - 1], right = zones[i + 1];
  if (level === "critical") return 2;
  if (level === "warning") {
    if (right?.[2] === "critical") return 1 + (v - from) / (to - from);
    if (left?.[2] === "critical") return 1 + (to - v) / (to - from);
    return 1;
  }
  // Good: warm toward each neighbor that isn't Good, over that neighbor's width or the last
  // quarter of this zone, whichever is smaller.
  const span = (next) => Math.min(next[1] - next[0], (to - from) / 4);
  const warmth = (next, distance) => (next && next[2] !== "good" ? LEVEL[next[2]] * Math.max(0, 1 - distance / span(next)) : 0);
  return Math.max(warmth(left, v - from), warmth(right, to - v));
}

/**
 * A color between hex colors a and b, a fraction t of the way, blended in OKLab (Björn Ottosson,
 * "A perceptual color space for image processing", 2020), so the steps look even.
 */
export function mixOklab(a, b, t) {
  const [l1, m1, s1] = toOklab(a), [l2, m2, s2] = toOklab(b);
  return fromOklab(l1 + (l2 - l1) * t, m1 + (m2 - m1) * t, s1 + (s2 - s1) * t);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function fromOklab(L, A, B) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  return `#${rgb.map((c) => Math.round(255 * Math.max(0, Math.min(1, toGamma(c)))).toString(16).padStart(2, "0")).join("")}`;
}
