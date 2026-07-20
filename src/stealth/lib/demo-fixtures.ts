/**
 * Fixture data for the public interactive demo at orangerails.app.
 *
 * This is intentionally separate from `src/stealth/lib/mock-fixtures.ts`,
 * which is a minimal test stub for exercising `runSync`'s progress stages
 * in unit/integration tests (11 blocks, matcher never matches, zero
 * transactions). This module exists to show a visitor a believable,
 * canned "what syncing your wallet looks like" experience without
 * needing to construct byte-valid synthetic Bitcoin blocks.
 *
 * No real network calls happen anywhere in the demo. Nothing here talks
 * to blocks.orangerails.com, stealth.orangerails.com, or any Supabase
 * function. The `demo.tsx` route drives the real, unmodified
 * `ProgressModal` component (the same one real users see) with a
 * synthetic sequence of stage/percent updates instead of a live sync.
 */

export const DEMO_XPUB =
  "xpub6CUGRUonZSQ4TjqhpAV3zVQXdSTUXcxSAe7RJPWWnnUJ7HrX3jZs9WD3EZbo7fQVQqxN2b7iwLnAvhCEQqvKUuFdA6kJqNqbqzYYmSCzKcE";

export interface DemoTransaction {
  txid: string;
  occurredAt: string; // ISO date, plaintext in the real system too (see docs/Stealth-Sync.md)
  direction: "in" | "out";
  amountSats: number;
  address: string;
  memo: string;
}

/** Six canned transactions, dated across the last few months, sized and
 *  worded to look like a real household wallet's activity rather than a
 *  test fixture (round numbers, obviously-fake addresses). */
export const DEMO_TRANSACTIONS: DemoTransaction[] = [
  {
    txid: "d3a1f9c2b7e4561203847abc9def0123456789abcdef0123456789abcdef01",
    occurredAt: "2026-06-18",
    direction: "in",
    amountSats: 15_000_000,
    address: "bc1qdemo0000000000000000000000000000000001",
    memo: "Received",
  },
  {
    txid: "9f8e7d6c5b4a3928170695847362514029384756abcdef0123456789abcdef",
    occurredAt: "2026-06-02",
    direction: "out",
    amountSats: 2_500_000,
    address: "bc1qdemo0000000000000000000000000000000002",
    memo: "Sent",
  },
  {
    txid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
    occurredAt: "2026-05-21",
    direction: "in",
    amountSats: 8_000_000,
    address: "bc1qdemo0000000000000000000000000000000003",
    memo: "Received",
  },
  {
    txid: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    occurredAt: "2026-05-04",
    direction: "out",
    amountSats: 1_200_000,
    address: "bc1qdemo0000000000000000000000000000000004",
    memo: "Sent",
  },
  {
    txid: "456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
    occurredAt: "2026-04-19",
    direction: "in",
    amountSats: 20_000_000,
    address: "bc1qdemo0000000000000000000000000000000005",
    memo: "Received",
  },
  {
    txid: "789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234",
    occurredAt: "2026-04-02",
    direction: "out",
    amountSats: 500_000,
    address: "bc1qdemo0000000000000000000000000000000006",
    memo: "Sent",
  },
];

export function formatSats(sats: number): string {
  return `${(sats / 100_000_000).toFixed(4)} BTC`;
}
