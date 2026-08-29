import { equal } from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_READ_ALONG_ENTRY_NUDGE_PX,
  readAlongEntryScrollNudge,
  readAlongScrollAdjustment,
} from "./read-along-scroll";

test("read-along entry gestures are directional and bounded", () => {
  equal(readAlongEntryScrollNudge(-100), 35);
  equal(readAlongEntryScrollNudge(100), -35);
  equal(readAlongEntryScrollNudge(-10_000), MAX_READ_ALONG_ENTRY_NUDGE_PX);
  equal(readAlongEntryScrollNudge(10_000), -MAX_READ_ALONG_ENTRY_NUDGE_PX);
});

test("read-along scroll stays still inside the reading band", () => {
  equal(readAlongScrollAdjustment(100, 500, 300, 24), 0);
  equal(readAlongScrollAdjustment(100, 0, 300, 24), 0);
});

test("read-along scroll recenters only after the highlight leaves the band", () => {
  equal(readAlongScrollAdjustment(100, 500, 90, 20), -225);
  equal(readAlongScrollAdjustment(100, 500, 590, 20), 275);
});
