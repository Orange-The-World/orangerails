/**
 * postMessage verb contract for the /connect widget.
 *
 * Three protections in one file:
 *   1. POST_MESSAGE_VERBS is the closed, authoritative allowlist of every
 *      message type the widget may receive from external windows.
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
 * Mapped type that resolves to `never` if ANY PayloadMap entry ever gains
 * a field named 'password', 'vault_password', or 'raw_password'.
 *
 * The only purpose of this type is the `_guard` const below it. It is
 * intentionally not exported.
 */
type _NoPasswordField = {
  [V in PostMessageVerb]: 'password' extends keyof PayloadMap[V]
    ? never
    : 'vault_password' extends keyof PayloadMap[V]
      ? never
      : 'raw_password' extends keyof PayloadMap[V]
        ? never
        : true;
}[PostMessageVerb];

/**
 * Compile-time assertion. `tsc --noEmit` fails with a type error here if
 * _NoPasswordField ever resolves to `never` (i.e. a payload gained a
 * password-adjacent field). Adding `// @ts-ignore` above this line to
 * silence the error is itself a code-review finding.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _guard: _NoPasswordField = true;

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
