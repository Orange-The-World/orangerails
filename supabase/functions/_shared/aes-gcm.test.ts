/**
 * Tests for the canonical AES-GCM helpers (DEV-0271).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/aes-gcm.test.ts
 *
 * Two halves:
 *
 *   1. BEHAVIOURAL. The two properties are asserted by USING the key handle,
 *      not by reading back a usages array. The array is the claim; a rejected
 *      crypto.subtle.encrypt is the evidence.
 *
 *   2. SOURCE SCAN over the callers, so a fourth copy of these helpers fails a
 *      check instead of waiting for a reviewer to notice. This is the half that
 *      is red at the pre-fix commit, where or-discover-wallets declares its own
 *      importKey with an "encrypt" usage it never uses.
 */

import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { bytesToBase64, decryptAes, importAesKey } from './aes-gcm.ts';

const PLAINTEXT = '{"api_key":"orangerails-test-value"}';

function randomKeyB64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Build `iv || ciphertext` base64 the way the client does. */
async function encryptWith(keyB64: string, plaintext: string): Promise<string> {
  // The explicit usages argument is exercised here on purpose: this is the
  // shape or-sync will need when it moves onto this module.
  const key = await importAesKey(keyB64, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(cipher, 12);
  return bytesToBase64(combined);
}

// --- 1. behavioural ---------------------------------------------------------

Deno.test('a decrypt-only handle round trips the 12-byte IV prefix format', async () => {
  const keyB64 = randomKeyB64();
  const ciphertext = await encryptWith(keyB64, PLAINTEXT);

  const key = await importAesKey(keyB64);
  assertEquals(await decryptAes(ciphertext, key), PLAINTEXT);
});

Deno.test('the default handle cannot encrypt', async () => {
  const key = await importAesKey(randomKeyB64());
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // If this ever stops rejecting, the handle can mint ciphertext that opens
  // under the user's own key. That is the whole point of the default.
  await assertRejects(
    () => crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('x')),
    'a decrypt-only key handle must refuse to encrypt',
  );
});

Deno.test('no handle is extractable, whatever usages are asked for', async () => {
  for (const usages of [undefined, ['decrypt'], ['encrypt', 'decrypt']]) {
    const key = usages === undefined
      ? await importAesKey(randomKeyB64())
      : await importAesKey(randomKeyB64(), usages as KeyUsage[]);
    assertEquals(key.extractable, false);
    await assertRejects(
      () => crypto.subtle.exportKey('raw', key),
      'the key bytes must never be exportable',
    );
  }
});

Deno.test('a wrong key is rejected rather than returning garbage', async () => {
  // AES-GCM is authenticated. This is why a malformed decrypted plaintext means
  // the stored blob really was not JSON, not that the key was wrong.
  const ciphertext = await encryptWith(randomKeyB64(), PLAINTEXT);
  const wrongKey = await importAesKey(randomKeyB64());
  await assertRejects(() => decryptAes(ciphertext, wrongKey));
});

// --- 2. source scan over the callers ----------------------------------------

const SCANNED_CALLERS = [
  '../or-discover-wallets/index.ts',
  '../or-connection-delete/index.ts',
];

Deno.test('no caller keeps its own copy of the key import', async () => {
  for (const relative of SCANNED_CALLERS) {
    const source = await Deno.readTextFile(new URL(relative, import.meta.url));

    // Positive assertion first, so this scan cannot pass on a file that simply
    // stopped decrypting and left the test asserting nothing.
    assert(
      source.includes("_shared/aes-gcm.ts"),
      `${relative}: does not import the canonical AES helpers`,
    );

    assertEquals(
      /crypto\.subtle\.importKey/.test(source),
      false,
      `${relative}: declares its own key import. Add a caller to _shared/aes-gcm.ts, not a fourth copy.`,
    );
    assertEquals(
      /crypto\.subtle\.encrypt/.test(source),
      false,
      `${relative}: encrypts. If that is now deliberate, ask for the usage explicitly and say why here.`,
    );
    assertEquals(
      /['"]encrypt['"]/.test(source),
      false,
      `${relative}: names an encrypt key usage. Neither of these functions encrypts.`,
    );
  }
});
