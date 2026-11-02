import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { mapOceanEarnpayResponse, OCEAN_SOURCE_TAG, type OceanEarnpayResponse } from './mapper.ts';

const ADDRESS = 'bc1qztuue9qkmj48zhwxww6rzqm3caz7xtg7kudnv2';

// Trimmed from a real GET /v1/earnpay/<ADDRESS> response, captured live
// 2026-09-03. Field names and values are OCEAN's own, including the
// misspelled `fees_colected_satoshis` and the one payout below that is NOT
// a generation transaction (that combination is real and worth covering).
const FIXTURE: OceanEarnpayResponse = {
  result: {
    start_ts: '1785876417',
    end_ts: '1788468417',
    earnings: [
      {
        block_hash: '00000000000000000001006700f9b498b6ae84da1706032bfb97072bee9e588e',
        ts: '2026-09-03T15:24:24',
        shares_in_window: 128515457417216,
        fees_colected_satoshis: 402606,
        satoshis_net_earned: 39858017,
      },
      {
        block_hash: '00000000000000000000a6eb26611137b9c1fd20fafba8a585b0d33a46c1511e',
        ts: '2026-09-03T15:04:27',
        shares_in_window: 128625872994304,
        fees_colected_satoshis: 402410,
        satoshis_net_earned: 39838589,
      },
    ],
    payouts: [
      {
        ts: '2026-09-03T15:24:36',
        on_chain_txid: '14aa932901ea35d67ceff92254bb93014da6dec6a4b40aff05a470ff3afe60a1',
        total_satoshis_net_paid: 39858017,
        is_generation_txn: true,
      },
      {
        // Real observed case: a payout settled from a hot wallet, not the
        // block's own coinbase transaction.
        ts: '2026-08-08T03:33:34',
        on_chain_txid: '5b1f88374518d837302cff4e19cec318ce8fa3b39dcc2b46376c92a37f45c6c3',
        total_satoshis_net_paid: 4946566,
        is_generation_txn: false,
      },
    ],
  },
};

Deno.test('maps every earning row to a mining_earning event with no txid', () => {
  const rows = mapOceanEarnpayResponse(FIXTURE, ADDRESS, 'wallet-123');
  const earnings = rows.filter((r) => r.type === 'mining_earning');
  assertEquals(earnings.length, 2);
  const first = earnings[0];
  assertEquals(first.id, 'ocean:earning:00000000000000000001006700f9b498b6ae84da1706032bfb97072bee9e588e');
  assertEquals(first.adapter, 'ocean');
  assertEquals(first.direction, 'in');
  assertEquals(first.amount_sats, 39858017);
  assertEquals(first.currency, 'BTC');
  assertEquals(first.counterparty, ADDRESS);
  assertEquals(first.source_wallet_id, 'wallet-123');
  assertEquals(first.source_tag, OCEAN_SOURCE_TAG);
  assertEquals(first.timestamp, '2026-09-03T15:24:24.000Z');
  assertEquals(first.txid, undefined);
});

Deno.test('maps every payout row to a mining_payout event with txid and from_coinbase', () => {
  const rows = mapOceanEarnpayResponse(FIXTURE, ADDRESS, 'wallet-123');
  const payouts = rows.filter((r) => r.type === 'mining_payout');
  assertEquals(payouts.length, 2);

  const generationPayout = payouts.find((r) => r.txid?.startsWith('14aa9329'));
  assert(generationPayout, 'expected the generation-txn payout to be present');
  assertEquals(generationPayout.amount_sats, 39858017);
  assertEquals(generationPayout.from_coinbase, true);
  assertEquals(generationPayout.source_tag, OCEAN_SOURCE_TAG);

  const hotWalletPayout = payouts.find((r) => r.txid?.startsWith('5b1f8837'));
  assert(hotWalletPayout, 'expected the non-generation payout to be present');
  assertEquals(hotWalletPayout.from_coinbase, false);
});

Deno.test('KNOWN GAP: vout is left undefined, never guessed as 0', () => {
  // Locks in current behavior on purpose. OCEAN's earnpay response carries
  // no output index. If this ever starts failing because vout got a real
  // value, update this test as part of closing that gap deliberately --
  // do not let a stray default silently start asserting 0 here.
  const rows = mapOceanEarnpayResponse(FIXTURE, ADDRESS, 'wallet-123');
  const payouts = rows.filter((r) => r.type === 'mining_payout');
  for (const p of payouts) {
    assertEquals(p.vout, undefined);
  }
});

Deno.test('every row carries source_wallet_id, even null for a legacy caller', () => {
  const rows = mapOceanEarnpayResponse(FIXTURE, ADDRESS, null);
  assert(rows.length > 0);
  for (const r of rows) {
    assertEquals(r.source_wallet_id, null);
  }
});

Deno.test('an empty earnpay response maps to an empty array', () => {
  const empty: OceanEarnpayResponse = {
    result: { start_ts: '0', end_ts: '0', earnings: [], payouts: [] },
  };
  assertEquals(mapOceanEarnpayResponse(empty, ADDRESS, 'wallet-123'), []);
});
