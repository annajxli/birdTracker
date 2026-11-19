/**
 * Left edges for labels {center, width} (ordered by center): centered where there's room,
 * overlapping ones moved apart as a group as little as possible, all inside [0, span].
 */
export function spreadLabels(labels, span, gap = 4) {
  const clusters = [];
  for (const [i, {center, width}] of labels.entries()) {
    let c = {first: i, size: width, sum: center - width / 2, count: 1};
    c.left = clampLeft(c, span);
        // Merge with the previous cluster while they'd touch; the group centers on its wanted edges' mean.
    while (clusters.length && clusters.at(-1).left + clusters.at(-1).size + gap > c.left) {
      const p = clusters.pop();
      const offset = p.size + gap;
      c = {first: p.first, size: offset + c.size, sum: p.sum + c.sum - offset * c.count, count: p.count + c.count};
      c.left = clampLeft(c, span);
    }
    clusters.push(c);
  }
  const lefts = [];
  for (const c of clusters) {
    let x = c.left;
    for (let i = c.first; i < c.first + c.count; i++) {
      lefts.push(x);
      x += labels[i].width + gap;
    }
  }
  return lefts;
}

function clampLeft(c, span) {
  return Math.max(0, Math.min(span - c.size, c.sum / c.count));
}
