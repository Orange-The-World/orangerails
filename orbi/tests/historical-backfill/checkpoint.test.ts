/**
 * Checkpoint unit tests — write / read / resume / clear.
 *
 * Uses real /tmp file I/O with a unique pair name so it doesn't collide with
 * production backfill state.
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import {
  checkpointPath,
  clearCheckpoint,
  loadCheckpoint,
  newCheckpoint,
  saveCheckpoint,
} from "../../scripts/historical-backfill/lib/checkpoint";

const TEST_SOURCE = "vitest-fixture";
const TEST_PAIR = "TEST/PAIR";

afterEach(() => {
  const p = checkpointPath(TEST_SOURCE, TEST_PAIR);
  if (existsSync(p)) unlinkSync(p);
});

describe("checkpoint", () => {
  it("loadCheckpoint returns null when no file exists", () => {
    expect(loadCheckpoint(TEST_SOURCE, TEST_PAIR)).toBeNull();
  });

  it("save then load round-trips state", () => {
    const cp = newCheckpoint(TEST_SOURCE, TEST_PAIR);
    cp.lastCompletedBucketTs = "2026-05-25T12:34:00.000Z";
    cp.totalRowsWritten = 1234;
    saveCheckpoint(cp);

    const loaded = loadCheckpoint(TEST_SOURCE, TEST_PAIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastCompletedBucketTs).toBe("2026-05-25T12:34:00.000Z");
    expect(loaded!.totalRowsWritten).toBe(1234);
    expect(loaded!.source).toBe(TEST_SOURCE);
    expect(loaded!.pair).toBe(TEST_PAIR);
  });

  it("clearCheckpoint removes the file", () => {
    saveCheckpoint(newCheckpoint(TEST_SOURCE, TEST_PAIR));
    expect(existsSync(checkpointPath(TEST_SOURCE, TEST_PAIR))).toBe(true);
    clearCheckpoint(TEST_SOURCE, TEST_PAIR);
    expect(existsSync(checkpointPath(TEST_SOURCE, TEST_PAIR))).toBe(false);
  });

  it("checkpoint path normalizes separators in pair name", () => {
    const a = checkpointPath("bitstamp", "BTC/USD");
    const b = checkpointPath("bitstamp", "BTC-USD");
    expect(a).toBe(b);
    expect(a).toContain("BTCUSD");
  });
});
