/**
 * Orange Rails, LDK connector — persistence classification tests.
 *
 * Covers the pure decision logic Auditor criterion (e) hinges on: the atomic
 * upsert's outcome classification and the stale-restore refusal. The crypto/DB
 * wiring is scaffolded; this logic is real and testable now.
 */

import { describe, expect, it } from 'vitest';

import { classifyUpsert, assertNotStale } from './persist';

describe('classifyUpsert', () => {
  it('ACCEPTED when a row is returned (new latest)', () => {
    expect(classifyUpsert(42, { returnedUpdateId: 42 })).toEqual({
      kind: 'ACCEPTED',
      updateId: 42,
    });
  });

  it('IDEMPOTENT_OK when no row and stored == requested (persist-before-ack retry)', () => {
    expect(classifyUpsert(42, { storedUpdateId: 42 })).toEqual({
      kind: 'IDEMPOTENT_OK',
      updateId: 42,
    });
  });

  it('REJECTED_STALE when no row and stored > requested (restore race)', () => {
    expect(classifyUpsert(41, { storedUpdateId: 42 })).toEqual({
      kind: 'REJECTED_STALE',
      storedUpdateId: 42,
    });
  });

  it('throws when RETURNING is empty and no read-back was supplied', () => {
    expect(() => classifyUpsert(42, {})).toThrow(/storedUpdateId/);
  });
});

describe('assertNotStale', () => {
  it('passes when loaded monitor is at or ahead of the watermark', () => {
    expect(() => assertNotStale(42, 42)).not.toThrow();
    expect(() => assertNotStale(43, 42)).not.toThrow();
  });

  it('refuses to operate on a stale monitor (funds-loss guard)', () => {
    expect(() => assertNotStale(41, 42)).toThrow(/Stale ChannelMonitor/);
  });
});
