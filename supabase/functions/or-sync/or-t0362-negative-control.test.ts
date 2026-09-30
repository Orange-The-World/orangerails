/**
 * THROWAWAY CONTROL, NOT FOR MERGE (OR-T0362, companion to PR 1681).
 *
 * Purpose: show by execution, not by hand tracing, that the assertion block
 * added in PR 1681 passes on the current pass order and fails on the earlier
 * one. Nothing here touches index.ts.
 *
 * Both compositions below are built from the SAME helper functions and differ
 * in exactly one way: the order of the keyword-gated pass and the
 * unconditional 6+ digit pass. The helpers are pasted from
 * redactedUpstreamDetail on dev.
 */

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { redactedUpstreamDetail } from './index.ts';

const INPUT =
  'Account 4821 rejected for jane.doe@example.com; acct 907-1234567 on hold; retry after 30 seconds';

function commonPasses(raw: string): string {
  const firstLine = raw.split('\n')[0] ?? raw;
  return firstLine
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b([a-z]{1,8})_[A-Za-z0-9]{6,}\b/gi, '$1_[redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<token>');
}

function keywordPass(s: string): string {
  return s.replace(
    /\b(account|acct|card|reference|ref)\b([^0-9]{0,20})(\d(?:[\d\s-]*\d)?)/gi,
    (whole: string, keyword: string, gap: string, digits: string): string => {
      const digitCount = digits.replace(/[^0-9]/g, '').length;
      return digitCount >= 4 ? `${keyword}${gap}[redacted]` : whole;
    },
  );
}

function longDigitPass(s: string): string {
  return s.replace(/\b\d{6,}\b/g, '[redacted]');
}

// Current order on dev: keyword-gated pass first, 6+ digit pass second.
const currentOrder = (raw: string): string => longDigitPass(keywordPass(commonPasses(raw))).slice(0, 300);

// Earlier order: 6+ digit pass first, keyword-gated pass second.
const earlierOrder = (raw: string): string => keywordPass(longDigitPass(commonPasses(raw))).slice(0, 300);

// The assertion block from PR 1681, verbatim, as a function.
function combinedStringAssertions(out: string): void {
  assert(!out.includes('@'), out);
  assert(!out.includes('jane.doe'), out);
  assert(!out.includes('example.com'), out);
  assert(out.includes('<email>'), out);
  assert(!out.includes('4821'), out);
  assert(!out.includes('907'), out);
  assert(!out.includes('1234567'), out);
  assert(out.includes('[redacted]'), out);
  assert(out.includes('rejected for'), out);
  assert(out.includes('on hold'), out);
  assert(out.includes('retry after 30 seconds'), out);
  assertEquals(
    out,
    'Account [redacted] rejected for <email>; acct [redacted] on hold; retry after 30 seconds',
  );
}

Deno.test('control C: the current-order composition matches the real redactedUpstreamDetail', () => {
  for (
    const s of [
      INPUT,
      'Account 123-4567890 declined',
      'acct 4567890-123 on file',
      'upstream 402 for member 998877665544',
    ]
  ) {
    assertEquals(currentOrder(s), redactedUpstreamDetail(s), s);
  }
});

Deno.test('control A: the PR 1681 assertions PASS on the current-order composition', () => {
  combinedStringAssertions(currentOrder(INPUT));
});

Deno.test('control B (EXPECTED RED): the PR 1681 assertions run directly on the earlier-order composition', () => {
  const out = earlierOrder(INPUT);
  combinedStringAssertions(out);
});
