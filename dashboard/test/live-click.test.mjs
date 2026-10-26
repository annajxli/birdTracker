import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

import {detectionPlaybackStart} from "../src/components/detection-policy.js";

const source = readFileSync(new URL("../src/live.md", import.meta.url), "utf8");

test("bird and sound label clicks seek once to the left edge, regardless of pointer position", () => {
  const handlers = [...source.matchAll(/a\.onclick = (\(event\) => \{[\s\S]*?\n    \});/g)];
  assert.equal(handlers.length, 2);
  for (const [, handler] of handlers) {
    const calls = [];
    const r = {start: 120000};
    const seek = (...args) => calls.push(args);
    const onClick = new Function("r", "seek", "PLAYHEAD_AT", "detectionPlaybackStart", `return (${handler});`)(r, seek, 2 / 3, detectionPlaybackStart);
    // Reproduce propagation to the track: the pointer is well to the right of the run start.
    let stopped = false;
    onClick({clientX: 900, stopPropagation() { stopped = true; }});
    if (!stopped) seek(180000, .9);
    assert.deepEqual(calls, [[r.start - 2000, 2 / 3]]);
  }
});
