import { describe, expect, it, vi } from 'vitest';

import { BreezConfirmsClient, type BreezRawPayment } from './breez';

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Cursor used by every test below. Unix seconds, plus its ISO form. */
const CURSOR_SEC = 1_770_000_000;
const CURSOR_ISO = new Date(CURSOR_SEC * 1000).toISOString();

/** A settled Breez receive. Overrides win, so each test states only what matters. */
function receive(over: Partial<BreezRawPayment> = {}): BreezRawPayment {
  return {
    paymentHash: 'hash_default',
    paymentType: 'received',
    status: 'complete',
    amountMsat: 1000,
    createdAt: CURSOR_SEC - 2 * HOUR,
    paymentTime: CURSOR_SEC + HOUR,
    ...over,
  };
}

/** Source that returns one page and then exhausts (short batch stops the loop). */
function sourceOf(page: BreezRawPayment[]) {
  return { listPayments: vi.fn().mockResolvedValue(page) };
}

describe('BreezConfirmsClient.fetchSettled - re-scan window boundary contract', () => {
  it('emits a swap that settled AFTER the cursor', async () => {
    const source = sourceOf([
      receive({ paymentHash: 'late_settle', paymentTime: CURSOR_SEC + 6 * HOUR }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out.map((i) => i.payment_hash)).toEqual(['late_settle']);
  });

  it('emits a BACKDATED swap that settled before the cursor but inside the window', async () => {
    // The load-bearing case. This record is older than the cursor, so a strict
    // settled_at > cursor emit filter would silently drop it. Breez backdates
    // the settle time when a swap record finalises, so the row can appear for
    // the first time on this sync with a timestamp behind the cursor. It is
    // inside the 24h window, so it must be emitted and left to the ingest
    // upsert to dedupe.
    const source = sourceOf([
      receive({ paymentHash: 'backdated_swap', paymentTime: CURSOR_SEC - 6 * HOUR }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out.map((i) => i.payment_hash)).toEqual(['backdated_swap']);
  });

  it('sets the fetch lower bound to (cursor - 24h), not the cursor', async () => {
    const source = sourceOf([]);
    const client = new BreezConfirmsClient({ source });

    await client.fetchSettled({ after: CURSOR_ISO });

    expect(source.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ fromTimestamp: CURSOR_SEC - DAY }),
    );
  });

  it('honours a rescanWindowSec override on the lower bound', async () => {
    const source = sourceOf([]);
    const client = new BreezConfirmsClient({ source, rescanWindowSec: 2 * DAY });

    await client.fetchSettled({ after: CURSOR_ISO });

    expect(source.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ fromTimestamp: CURSOR_SEC - 2 * DAY }),
    );
  });

  it('passes no lower bound at all on a first sync (no cursor)', async () => {
    const source = sourceOf([]);
    const client = new BreezConfirmsClient({ source });

    await client.fetchSettled();

    expect(source.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ fromTimestamp: undefined }),
    );
  });

  it('never drives the lower bound below the epoch', async () => {
    const source = sourceOf([]);
    const client = new BreezConfirmsClient({ source });

    await client.fetchSettled({ after: new Date(HOUR * 1000).toISOString() });

    expect(source.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ fromTimestamp: 0 }),
    );
  });
});

describe('BreezConfirmsClient.fetchSettled - what crosses the boundary', () => {
  it('drops sent payments and keeps receives', async () => {
    const source = sourceOf([
      receive({ paymentHash: 'money_out', paymentType: 'sent' }),
      receive({ paymentHash: 'money_in' }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out.map((i) => i.payment_hash)).toEqual(['money_in']);
  });

  it('drops pending and failed receives', async () => {
    const source = sourceOf([
      receive({ paymentHash: 'pending', status: 'pending', paymentTime: 0 }),
      receive({ paymentHash: 'failed', status: 'failed', paymentTime: 0 }),
      receive({ paymentHash: 'complete' }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out.map((i) => i.payment_hash)).toEqual(['complete']);
  });

  it('falls back to id when a swap record carries no payment hash', async () => {
    // payment_hash is the ingest dedupe key. An empty key would collide every
    // hashless swap record onto one row, so the fallback is load-bearing.
    const source = sourceOf([
      receive({ paymentHash: null, id: 'swap_tx_id' }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out[0].payment_hash).toBe('swap_tx_id');
  });

  it('reads the native millisatoshi amount without converting', async () => {
    // 2500 is not a whole-sat multiple, so a stray *1000 would show up here.
    const source = sourceOf([receive({ amountMsat: '2500' })]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out[0].amount_msat).toBe(2500);
  });

  it('cursors on settle time, not creation time', async () => {
    const settleSec = CURSOR_SEC + 3 * HOUR;
    const source = sourceOf([
      receive({ createdAt: CURSOR_SEC - 20 * HOUR, paymentTime: settleSec }),
    ]);
    const client = new BreezConfirmsClient({ source });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out[0].state).toEqual({
      settled: true,
      settled_at: new Date(settleSec * 1000).toISOString(),
    });
  });
});

describe('BreezConfirmsClient.fetchSettled - pagination', () => {
  it('paginates to exhaustion on a short raw page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => receive({ paymentHash: `p${i}` }));
    const tail = Array.from({ length: 7 }, (_, i) => receive({ paymentHash: `t${i}` }));
    const listPayments = vi
      .fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(tail);
    const client = new BreezConfirmsClient({ source: { listPayments } });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out).toHaveLength(107);
    expect(listPayments).toHaveBeenCalledTimes(2);
    expect(listPayments).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100 }));
  });

  it('stops on a short RAW page even when every row is filtered out', async () => {
    // A page of 7 sent payments yields zero settled receives. Exhaustion is
    // judged on the raw batch, so the loop must stop rather than read a zero
    // settled-count as "keep going" or as "truncate here".
    const listPayments = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => receive({ paymentHash: `s${i}`, paymentType: 'sent' })),
      );
    const client = new BreezConfirmsClient({ source: { listPayments } });

    const out = await client.fetchSettled({ after: CURSOR_ISO });

    expect(out).toEqual([]);
    expect(listPayments).toHaveBeenCalledTimes(1);
  });

  it('throws when the backend keeps returning full pages past the cap', async () => {
    // A backend that ignores the offset cursor would spin forever otherwise.
    const listPayments = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 100 }, (_, i) => receive({ paymentHash: `p${i}` })));
    const client = new BreezConfirmsClient({ source: { listPayments } });

    await expect(client.fetchSettled({ after: CURSOR_ISO, maxPages: 2 })).rejects.toThrow(
      /pagination safety cap reached after 2 page/,
    );
  });
});
