/**
 * Deno tests for or-discover-wallets: AES key-handle least privilege.
 *
 * Run with:
 *   deno test supabase/functions/or-discover-wallets/index.test.ts
 *
 * OR-T0723 (DEV-0223 finding 2): importAesKey() previously granted the
 * imported key both "encrypt" and "decrypt" usages although neither mode of
 * this handler ever encrypts. extractable=false stops the key bytes
 * escaping; it does not stop the handle being used, so an unused "encrypt"
 * usage is a real (if currently unreachable) privilege to carry. This test
 * pins the usages array so the next drift fails a check instead of waiting
 * for a reviewer to read the file.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { importAesKey } from './index.ts';

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

Deno.test('importAesKey grants decrypt only, not encrypt', async () => {
  const key = await importAesKey(TEST_KEY_B64);
  assertEquals(key.extractable, false);
  assertEquals([...key.usages], ['decrypt']);
});
