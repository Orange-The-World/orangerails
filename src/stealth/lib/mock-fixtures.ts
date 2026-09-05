/**
 * Mock fixture fetchers for `runSync`.
 *
 * Used by `routes/sync.tsx` when called with `?mock=1` so the route is
 * testable today, before the Milestone 4 filter producer + block source
 * services come up on operator infrastructure. The fixture matcher always returns
 * false, which means a mock sync ends with zero transactions but still
 * exercises every PROGRESS stage end-to-end.
 *
 * Real production fetchers live inline in `routes/sync.tsx`.
 */

import { CONFIRMATION_DEPTH } from './sync';
import type {
  BlockRecord,
  FilterRecord,
} from './sync';
import type { Bip158Matcher } from './wasm/index';

/**
 * The mock chain tip.
 *
 * runSync stops scanning CONFIRMATION_DEPTH blocks below the tip, so a raw
 * 800_010 here would leave mock mode covering only 800_000 to 800_004 while
 * mockFetchFilter still advertised a fixture range up to 800_010. Sitting the
 * tip CONFIRMATION_DEPTH above the top of the fixture range keeps the whole
 * range scannable, which is what mock mode did before the buffer existed.
 *
 * Heights above 800_010 return a null filter, so the contiguous-cursor walk
 * still stops at 800_010 and the cursor still lands there.
 */
export const MOCK_FIXTURE_TOP_HEIGHT = 800_010;

export const mockFetchTip = async (): Promise<number> =>
  MOCK_FIXTURE_TOP_HEIGHT + CONFIRMATION_DEPTH;

export const mockFetchFilter = async (
  height: number,
): Promise<FilterRecord | null> => {
  // Empty filter for every height in the fixture range.
  if (height < 800_000 || height > MOCK_FIXTURE_TOP_HEIGHT) return null;
  return {
    height,
    blockHashHex:
      '0000000000000000000000000000000000000000000000000000000000000000',
    filter: new Uint8Array([0]),
  };
};

export const mockFetchBlock = async (
  blockHashHex: string,
): Promise<BlockRecord> => {
  // The mock matcher never matches, so this should not be called. We
  // return an empty placeholder so a code path that did call it would not
  // crash mid-run.
  return {
    height: 0,
    blockHashHex,
    raw: new Uint8Array(80 + 1), // 80-byte zero header + varint(0) tx count
  };
};

/** Matcher that never matches; lets every PROGRESS stage fire without
 *  pulling any block data. */
export const mockNeverMatcher: Bip158Matcher = {
  matchAny: () => false,
};
