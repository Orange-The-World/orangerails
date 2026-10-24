/**
 * postMessage verb contract for the /connect widget.
 *
 * Three protections in one file for the opener credential-key handoff:
 *   1. POST_MESSAGE_VERBS is the closed, authoritative allowlist of every
 *      message type the widget may receive via window.opener.postMessage
 *      during the credential-key exchange. Other inbound channels (e.g. the
 *      inline Stealth Sync iframe) are governed by separate listeners.
 *   2. PayloadMap types every verb's payload -- no entry may carry a
 *      password-adjacent field. The compile-time _NoPasswordField guard
 *      enforces this on every `tsc --noEmit` run in CI.
 *   3. The runtime helper isAllowedVerb() is the single place the receiver
 *      calls before touching event.data.
 *
 * Adding a new verb:
 *   1. Append the type string to POST_MESSAGE_VERBS below.
 *   2. Add its payload shape to PayloadMap -- the _NoPasswordField guard
 *      refuses any payload that carries 'password', 'vault_password', or
 *      'raw_password'.
 *   3. Add a test-payload entry to VERB_TEST_LINES in
 *      tests/security/vault-password-leak.test.ts. The
 *      Record<PostMessageVerb, string> annotation there causes a compile
 *      error if any verb lacks a corresponding test case.
 *
 * Part of OR-T2722.
 */

// -------------------------------------------------------------------------
// Layer 1a: Closed verb allowlist
// -------------------------------------------------------------------------

/** Every message type the /connect widget accepts from external windows. */
export const POST_MESSAGE_VERBS = [
  /** Deferred credential-key response: the parent app's reply to
   *  'or-need-cred-key', carrying a base64 AES-256-GCM key. */
  'or-cred-key-ready',
] as const;

export type PostMessageVerb = (typeof POST_MESSAGE_VERBS)[number];

// -------------------------------------------------------------------------
// Layer 1b: Typed payload map -- no verb may carry a vault password
// -------------------------------------------------------------------------

/**
 * Payload shape for each allowed verb.
 *
 * Rules enforced by the _NoPasswordField guard below:
 *   - No entry may contain a field named 'password', 'vault_password', or
 *     'raw_password'. Adding such a field to any payload causes a compile
 *     error in exactly that PR, before any test runs.
 */
type PayloadMap = {
  'or-cred-key-ready': {
    /** Discriminant field matching the verb. */
    type: 'or-cred-key-ready';
    /**
     * Purpose tag, echoed from the original 'or-need-cred-key' request.
     * Older parent apps that do not echo it back send undefined; a reply
     * whose purpose does not match the outbound request is ignored by the
     * receiver.
     */
    purpose?: string;
    /**
     * Base64-encoded raw 32-byte AES-256-GCM credentials key (ORK).
     * This is a DERIVED KEY, never the user's plaintext vault password.
     * The key is imported as a non-extractable CryptoKey and used
     * solely to encrypt provider credentials before they leave the widget.
     */
    credKey: string;
    /**
     * Optional second base64 key for wallet metadata (label, currency).
     * When absent the receiver reuses credKey. Same key material
     * constraints as credKey: derived, non-extractable, no plaintext
     * vault password on this channel.
     */
    txnKey?: string;
  };
};

// -------------------------------------------------------------------------
// Layer 1c: Compile-time guard -- if any payload gains a password field,
//           this type resolves to `never` and the assignment below fails.
// -------------------------------------------------------------------------

/**
 * Sensitive key substrings matched case-insensitively via Lowercase<K>.
 * A payload key whose lowercase form contains any of these as a substring
 * is treated as password-adjacent and triggers the guard.
 */
type _SensitiveKeySubstring = 'password' | 'passwd' | 'passphrase' | 'mek' | 'recovery';

/**
 * Union of keys in T whose Lowercase form contains any _SensitiveKeySubstring.
 * Resolves to `never` when no such key exists.
 */
type _SensitiveKeysOf<T> = {
  [K in keyof T]-?: K extends string
    ? Lowercase<K> extends `${string}${_SensitiveKeySubstring}${string}`
      ? K
      : never
    : never;
}[keyof T];

/**
 * Union of POST_MESSAGE_VERBS whose PayloadMap entry carries at least one
 * password-adjacent key (matched case-insensitively by substring). Resolves
 * to `never` when every verb is clean.
 *
 * Note: this guard runs only when `tsc --noEmit` is invoked. CI does not run
 * `tsc --noEmit` on src/ today (RISK-0007, PR #969), so this is a local
 * developer check, not an automated gate.
 */
type _OffendingVerbs = {
  [V in PostMessageVerb]: [_SensitiveKeysOf<PayloadMap[V]>] extends [never] ? never : V;
}[PostMessageVerb];

/**
 * Compile-time assertion. `tsc --noEmit` fails with a type error here if any
 * PayloadMap entry carries a key whose Lowercase form contains 'password',
 * 'passwd', 'passphrase', 'mek', or 'recovery' as a substring. Adding
 * `// @ts-ignore` above this line to silence the error is a code-review finding.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _guard: [_OffendingVerbs] extends [never]
  ? true
  : { error: 'A PayloadMap entry carries a password-adjacent key'; verbs: _OffendingVerbs } = true;

// -------------------------------------------------------------------------
// Layer 1d: Runtime guard helper
// -------------------------------------------------------------------------

/**
 * Returns true only when `type` is a known verb in POST_MESSAGE_VERBS.
 *
 * Call this before accessing any other property of event.data. Unknown
 * verbs are dropped silently -- no payload is parsed or logged.
 *
 * @example
 *   const onMessage = (event: MessageEvent) => {
 *     const data = event.data as { type?: unknown };
 *     if (!isAllowedVerb(data?.type)) return;
 *     // now data.type is narrowed to PostMessageVerb
 *   };
 */
export function isAllowedVerb(type: unknown): type is PostMessageVerb {
  return (POST_MESSAGE_VERBS as readonly unknown[]).includes(type);
}
