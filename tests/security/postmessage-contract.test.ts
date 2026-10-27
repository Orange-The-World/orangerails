/**
 * Unit tests for the postMessage verb contract helpers (OR-T2722).
 *
 * Covers isAllowedVerb() and the structural guarantees of POST_MESSAGE_VERBS.
 * These tests prove the Layer 2 runtime guard works correctly for the happy
 * path and a range of invalid or adversarial inputs.
 *
 * The CE's acceptance item 2 on OR-T2722 requires this test file.
 */

import { describe, expect, test } from 'vitest';
import { POST_MESSAGE_VERBS, isAllowedVerb } from '@/lib/postmessage-contract';

describe('postmessage-contract', () => {
  test('isAllowedVerb returns true for the known inbound verb', () => {
    expect(isAllowedVerb('or-cred-key-ready')).toBe(true);
  });

  test('isAllowedVerb returns false for unknown and adversarial values', () => {
    // Outbound verbs this widget SENDS are not inbound verbs it ACCEPTS.
    expect(isAllowedVerb('or-need-cred-key')).toBe(false);
    expect(isAllowedVerb('or-link-success')).toBe(false);
    expect(isAllowedVerb('or-link-cancel')).toBe(false);

    // Empty and nullish
    expect(isAllowedVerb('')).toBe(false);
    expect(isAllowedVerb(undefined)).toBe(false);
    expect(isAllowedVerb(null)).toBe(false);

    // Wrong types
    expect(isAllowedVerb(42)).toBe(false);
    expect(isAllowedVerb({})).toBe(false);
    expect(isAllowedVerb([])).toBe(false);

    // Prototype-pollution probes: must not resolve via [[Prototype]] lookup.
    // Array.includes uses SameValueZero (===), which never matches these.
    expect(isAllowedVerb('constructor')).toBe(false);
    expect(isAllowedVerb('__proto__')).toBe(false);

    // A String object wrapping a valid verb is NOT the same as the string
    // primitive. Array.includes uses === so the wrapper is rejected.
    // eslint-disable-next-line no-new-wrappers
    expect(isAllowedVerb(new String('or-cred-key-ready'))).toBe(false);
  });

  test('POST_MESSAGE_VERBS contains no duplicates', () => {
    const unique = new Set<string>(POST_MESSAGE_VERBS);
    expect(unique.size).toBe(POST_MESSAGE_VERBS.length);
  });
});
