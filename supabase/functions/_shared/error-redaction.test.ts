/**
 * Tests for the shared edge-function error sanitisation boundary (DEV-0270).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/error-redaction.test.ts
 *
 * Two halves:
 *
 *   1. BEHAVIOURAL. Reproduce the real leak path (AES-GCM ciphertext of
 *      non-JSON plaintext, decrypted, then JSON.parse) and assert the log line
 *      carries none of the plaintext. Each of these asserts the PRECONDITION
 *      first: that the raw error really does contain the secret. A leak test
 *      that cannot see the leak proves nothing, so if V8 ever stops embedding
 *      the input fragment this suite says so loudly instead of going quietly
 *      green.
 *
 *   2. SOURCE SCAN over the two callers. Every console call in them must go
 *      through safeErrorLine. This is the half that fails at the pre-fix
 *      commit: both files log raw errors there, so the same test text is red
 *      before the change and green after.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { describeErrorSafely, errorFingerprint, safeErrorLine } from './error-redaction.ts';

// A plaintext that is NOT valid JSON and that looks like a real secret.
const CREDENTIAL_PLAINTEXT = 'sk_live_orangerails_not_json_at_all';
// The prefix V8 is expected to echo back inside its SyntaxError message.
const SECRET_PREFIX = 'sk_live_';

// --- helpers: a real AES-GCM round trip, same 12-byte IV prefix convention ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptForTest(plaintext: string): Promise<{ ciphertextB64: string; key: CryptoKey }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(cipher, 12);
  return { ciphertextB64: bytesToBase64(combined), key };
}

async function decryptForTest(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, 12) },
    key,
    data.slice(12),
  );
  return new TextDecoder().decode(plain);
}

/** The error the production path actually throws, obtained the production way. */
async function realParseErrorOverDecryptedPlaintext(): Promise<unknown> {
  const { ciphertextB64, key } = await encryptForTest(CREDENTIAL_PLAINTEXT);
  const credsJson = await decryptForTest(ciphertextB64, key);
  assertEquals(credsJson, CREDENTIAL_PLAINTEXT, 'round trip must return the plaintext');
  try {
    JSON.parse(credsJson);
  } catch (err) {
    return err;
  }
  throw new Error('JSON.parse unexpectedly succeeded, this test is no longer testing anything');
}

// --- 1. behavioural ---------------------------------------------------------

Deno.test('a JSON.parse failure over decrypted credentials leaks no plaintext into the log line', async () => {
  const err = await realParseErrorOverDecryptedPlaintext();

  // PRECONDITION: prove the leak exists before proving it is closed.
  const rawMessage = err instanceof Error ? err.message : String(err);
  assertStringIncludes(
    rawMessage,
    SECRET_PREFIX,
    'V8 no longer embeds the input fragment in its SyntaxError, so this test can no longer see the leak it exists to catch. Do not weaken the assertion: find the new shape.',
  );

  const line = await safeErrorLine('or-connection-delete', 'strike-cleanup', err);

  assertEquals(line.includes(SECRET_PREFIX), false, `plaintext prefix reached the log line: ${line}`);
  assertEquals(line.includes(CREDENTIAL_PLAINTEXT), false, `plaintext reached the log line: ${line}`);
  assertEquals(line.includes('not_json'), false, `plaintext fragment reached the log line: ${line}`);
  // And it is still useful to an operator.
  assertStringIncludes(line, '[or-connection-delete]');
  assertStringIncludes(line, 'code=');
  assertStringIncludes(line, 'fp=');
  assertStringIncludes(line, 'cid=');
});

Deno.test('the [slug] wrapper from providers/types.ts leaks no plaintext either', async () => {
  const inner = await realParseErrorOverDecryptedPlaintext();
  const innerMessage = inner instanceof Error ? inner.message : String(inner);
  // This is the exact wrapper _shared/providers/types.ts applies.
  const wrapped = new Error(`[strike] credentials JSON parse failed: ${innerMessage}`);

  assertStringIncludes(wrapped.message, SECRET_PREFIX, 'precondition: the wrapper carries the fragment');

  const line = await safeErrorLine('or-discover-wallets', 'fatal', wrapped);
  assertEquals(line.includes(SECRET_PREFIX), false, `plaintext prefix reached the log line: ${line}`);
  // A code is still emitted. Which one is not pinned here: the classifier
  // reads V8's wording, and "unexpected token" reaches the parse-failure rule
  // before the credentials rule. Both answers are right for a malformed stored
  // blob, and the classifier has its own tests in upstream-errors.test.ts.
  assertStringIncludes(line, 'code=');
});

Deno.test('upstream error text carrying a bearer token never reaches the log line', async () => {
  const err = new Error(
    'Strike API 401 Unauthorized: {"request":{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl"}}',
  );
  const line = await safeErrorLine('or-connection-delete', 'strike-cleanup', err);

  assertEquals(line.includes('Bearer'), false, line);
  assertEquals(line.includes('eyJhbGciOiJIUzI1NiJ9'), false, line);
  assertEquals(line.includes('Authorization'), false, line);
  assertStringIncludes(line, 'code=UPSTREAM_AUTH_FAILED');
});

Deno.test('the fingerprint is stable across noise and different across root causes', async () => {
  const a = await errorFingerprint(
    'upstream failed for 11111111-2222-3333-4444-555555555555',
    'Error',
  );
  const b = await errorFingerprint(
    'upstream failed for 99999999-8888-7777-6666-555555555555',
    'Error',
  );
  const c = await errorFingerprint('something else entirely', 'Error');

  assertEquals(a, b, 'same root cause, different uuid: the fingerprint must not move');
  assert(a !== c, 'different root causes must not share a fingerprint');
  assertEquals(/^[0-9a-f]{16}$/.test(a), true, `fingerprint must be 8 hex bytes, got ${a}`);
});

Deno.test('a code-shaped source code is echoed, free text is not', async () => {
  const pgError = { message: 'duplicate key value violates unique constraint', code: '23505' };
  const withCode = await describeErrorSafely(pgError);
  assertEquals(withCode.sourceCode, '23505');

  const chatty = { message: 'nope', code: 'the api key sk_live_orangerails_not_json_at_all failed' };
  const withoutCode = await describeErrorSafely(chatty);
  assertEquals(withoutCode.sourceCode, undefined);
  const line = await safeErrorLine('or-discover-wallets', 'connection-lookup', chatty);
  assertEquals(line.includes(SECRET_PREFIX), false, line);
});

Deno.test('a label cannot break the log line structure or run away in length', async () => {
  const err = new Error('boom');
  const line = await safeErrorLine('or-discover-wallets', 'phase\nfp=deadbeef "quoted"', err);

  assertEquals(line.includes('\n'), false, 'a newline in a label would forge a second log line');
  assertEquals(line.includes('"'), false, line);

  const long = await safeErrorLine('or-discover-wallets', 'x'.repeat(500), err);
  assertEquals(long.includes('x'.repeat(81)), false, 'label must be clamped to 80 chars');
});

// --- 2. source scan over the callers ----------------------------------------

/**
 * The rule this enforces, deliberately with no exceptions: in these files every
 * console call is exactly console.<method>(await safeErrorLine(...)).
 *
 * An exception ("`.message` is fine on the Postgres paths") is not statically
 * checkable, and an unenforceable rule is how the boundary drifted out of these
 * two functions in the first place. The diagnostic value that `.message`
 * carried survives as the `src=` field, which echoes a code-shaped SQLSTATE.
 */
const REQUIRED_CALL_PREFIX = 'await safeErrorLine(';
const SCANNED_CALLERS = [
  '../or-discover-wallets/index.ts',
  '../or-connection-delete/index.ts',
];

Deno.test('neither caller passes a raw error into console', async () => {
  for (const relative of SCANNED_CALLERS) {
    const source = await Deno.readTextFile(new URL(relative, import.meta.url));
    const calls = [...source.matchAll(/console\.(error|warn|log|info|debug)\(/g)];

    // The scan must be able to find something, or it is a silent pass.
    assert(
      calls.length > 0,
      `${relative}: no console calls found. Either the file moved or the pattern is wrong; this scan is checking nothing.`,
    );

    for (const match of calls) {
      const start = (match.index ?? 0) + match[0].length;
      const following = source.slice(start, start + REQUIRED_CALL_PREFIX.length);
      assertEquals(
        following,
        REQUIRED_CALL_PREFIX,
        `${relative}: console.${match[1]} does not go through safeErrorLine:\n  ${source.slice(match.index ?? 0, (match.index ?? 0) + 140)}`,
      );
    }
  }
});
