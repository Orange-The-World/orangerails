/**
 * Checkpoint — resumable state for a historical-backfill run.
 *
 * One JSON file per (source, pair) pair. Written after each successful batch
 * of rows so an interrupted run can resume from the last completed minute
 * instead of starting from scratch.
 *
 * File location: /tmp/orbi-backfill-{source}-{pairCode}.checkpoint.json
 *
 * Idempotency: the orchestrator UPSERTs every row, so re-running over an
 * already-imported window is a no-op (same rows, same values). The
 * checkpoint just lets us skip parser/network work we know is done.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

export interface Checkpoint {
  source: string;
  pair: string;
  /** ISO-8601 of the last bucket that was written successfully. */
  lastCompletedBucketTs: string | null;
  totalRowsWritten: number;
  /** When the run started (most recent invocation). */
  startedAt: string;
  /** When the checkpoint was last updated. */
  updatedAt: string;
}

export function checkpointPath(source: string, pair: string): string {
  const pairCode = pair.replace("/", "").replace("-", "");
  return `/tmp/orbi-backfill-${source}-${pairCode}.checkpoint.json`;
}

export function loadCheckpoint(source: string, pair: string): Checkpoint | null {
  const path = checkpointPath(source, pair);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

export function saveCheckpoint(cp: Checkpoint): void {
  const path = checkpointPath(cp.source, cp.pair);
  cp.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(cp, null, 2));
}

export function clearCheckpoint(source: string, pair: string): void {
  const path = checkpointPath(source, pair);
  if (existsSync(path)) unlinkSync(path);
}

export function newCheckpoint(source: string, pair: string): Checkpoint {
  const now = new Date().toISOString();
  return {
    source,
    pair,
    lastCompletedBucketTs: null,
    totalRowsWritten: 0,
    startedAt: now,
    updatedAt: now,
  };
}
