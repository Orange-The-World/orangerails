/**
 * Upstream error taxonomy: the one place that decides which of OR's fixed
 * error codes a thrown provider error maps to.
 *
 * Extracted from or-sync/index.ts (DL-0421). It lived as a private function
 * inside a module that calls Deno.serve() at import time, so importing it
 * from a test bound a port and blew up; that is why the single most
 * customer-visible decision in the sync path had never had a test.
 *
 * ── Audit 2026-05-16 findings #1 + #4 ────────────────────────────────────
 * Raw provider messages must never reach the HTTP body, the edge log, or
 * encrypted_last_error. Nothing here emits, returns, or persists `raw`: it is
 * inspected in memory and dropped, exactly as before the extraction. The
 * return value is a closed enum of OR's own codes.
 */

export type UpstreamErrorCode =
  | 'UPSTREAM_AUTH_FAILED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_BAD_REQUEST'
  | 'UPSTREAM_PARSE_FAILED'
  | 'ADAPTER_CONFIG_ERROR'
  | 'UPSTREAM_OTHER';

/**
 * CCXT error class name -> OR taxonomy code.
 *
 * Why this tier exists at all (DL-0421): 98 of our exchanges are served by the
 * generic _ccxt adapter, and CCXT already classifies every exchange error into
 * a typed hierarchy. We were ignoring that and regexing the message string
 * instead. Measured against ccxt@4.4.30's own bitstamp `exceptions.exact` map,
 * 14 of its 15 entries classified wrongly, including every authentication
 * failure. Consuming the type CCXT already computed fixes all 98 exchanges at
 * once and stops us maintaining a second copy of a table CCXT maintains
 * upstream.
 *
 * Keyed on the class NAME, not the constructor -- see errorClassName() below
 * for why that distinction is load-bearing rather than stylistic.
 *
 * Deliberately absent, and this is the important part of the design:
 *
 *   BaseError, ExchangeError
 *     The generic parents. CCXT throws a bare ExchangeError when an exchange
 *     sends a `reason` string it does not recognise. Mapping those here would
 *     assert a category we have not earned, so they fall through to the regex
 *     and then to UPSTREAM_OTHER. That is the safe direction: when Bitstamp
 *     rewords an error, we degrade to "unknown" rather than silently
 *     misclassifying it as something confident and wrong.
 *
 *   InsufficientFunds, InvalidOrder, OrderNotFound, InvalidAddress,
 *   NotSupported, OperationRejected, and the rest of the trading branch
 *     Order-placement errors. OR only reads; if one of these ever surfaces on
 *     a sync path it means something we do not model happened, and
 *     UPSTREAM_OTHER plus a correlation ID is the honest answer. Note in
 *     particular that NotSupported is NOT mapped to ADAPTER_CONFIG_ERROR:
 *     that code's customer copy says "reconnect this account", which would be
 *     useless advice for a capability the exchange simply does not offer.
 */
const CCXT_ERROR_CODES: Readonly<Record<string, UpstreamErrorCode>> = Object.freeze({
  // ── ExchangeError -> AuthenticationError branch ──────────────────────────
  AuthenticationError: 'UPSTREAM_AUTH_FAILED',
  PermissionDenied: 'UPSTREAM_AUTH_FAILED',
  AccountNotEnabled: 'UPSTREAM_AUTH_FAILED',
  AccountSuspended: 'UPSTREAM_AUTH_FAILED',

  // ── OperationFailed -> NetworkError -> rate limiting ─────────────────────
  RateLimitExceeded: 'UPSTREAM_RATE_LIMITED',
  DDoSProtection: 'UPSTREAM_RATE_LIMITED',

  // ── OperationFailed: transport and availability, generally retryable ─────
  OperationFailed: 'UPSTREAM_UNAVAILABLE',
  NetworkError: 'UPSTREAM_UNAVAILABLE',
  ExchangeNotAvailable: 'UPSTREAM_UNAVAILABLE',
  OnMaintenance: 'UPSTREAM_UNAVAILABLE',
  RequestTimeout: 'UPSTREAM_UNAVAILABLE',
  // InvalidNonce sits under NetworkError in CCXT's own hierarchy and is
  // transient in practice: it means two callers used one API key
  // concurrently. Retryable, so it belongs with the transport codes.
  InvalidNonce: 'UPSTREAM_UNAVAILABLE',
  ChecksumError: 'UPSTREAM_UNAVAILABLE',

  // ── ExchangeError: the request itself was malformed ──────────────────────
  BadRequest: 'UPSTREAM_BAD_REQUEST',
  BadSymbol: 'UPSTREAM_BAD_REQUEST',

  // ── OperationFailed -> BadResponse: we could not read what came back ─────
  BadResponse: 'UPSTREAM_PARSE_FAILED',
  NullResponse: 'UPSTREAM_PARSE_FAILED',

  // ── OR's own bug: we called CCXT wrong ───────────────────────────────────
  ArgumentsRequired: 'ADAPTER_CONFIG_ERROR',
});

/**
 * Identify an error's class in a way that survives minification.
 *
 * WHY THIS IS NOT `e.constructor.name` (DL-0421):
 *
 * CCXT is loaded from a CDN bundle at runtime, and that bundle is minified.
 * Every CCXT error class ships as an anonymous class expression assigned to a
 * short binding, so the constructor carries the mangled name while the
 * human-readable name survives only because the constructor body assigns it
 * as a string literal:
 *
 *     C = class extends T { constructor(m){ super(m); this.name = "AuthenticationError" } }
 *
 *     e.constructor.name  === "C"                    <- mangled, useless
 *     e.name              === "AuthenticationError"  <- survives
 *
 * Verified against the shipped bundle (4151010 bytes, fetched from
 * https://esm.sh/ccxt@4.4.30/es2022/ccxt.mjs): all 40 CCXT error classes are
 * emitted this way, every one of them bound to a one or two character
 * identifier, and zero are emitted as `class X extends` declarations. There is
 * no CCXT error class in that bundle whose constructor name is usable. So a
 * classifier built on `constructor.name` passes locally against the unminified npm
 * package and then silently classifies everything as UPSTREAM_OTHER in
 * production, forever, which is the exact bug DL-0421 is about. It also means
 * the `class=` field this feeds into the edge log has been a one or two letter
 * token for every CCXT error, which is a large part of why nobody could
 * diagnose this from logs.
 *
 * The constructor is still consulted as a fallback, because it is strictly
 * better for errors that never set `name`: supabase-js and Postgres errors
 * leave `name` as the generic "Error" while the constructor carries the real
 * type.
 *
 * WHY THE RESULT IS CLAMPED (audit requirement on the DL-0421 PR):
 *
 * `constructor.name` is structurally guaranteed to be a JavaScript identifier.
 * `e.name` is not: it is an ordinary writable property holding an arbitrary
 * runtime string, and an upstream library is free to put a whole sentence, a
 * URL, or an echoed request body in it. Three consumers take this value and
 * none of them re-check it: the `class=` field of the edge log line, the
 * exception type sent to the error tracker, and the fingerprint input, where
 * it is concatenated ahead of the redaction that is applied to the message.
 * Switching from the constructor to `e.name` therefore swapped a bounded token
 * for an unbounded one on all three surfaces at once.
 *
 * So a name is only used when it is identifier-shaped and of sane length;
 * anything else falls back to the constructor, and then to "Error". Every
 * caller is guaranteed a token matching CLASS_NAME_SHAPE.
 */
const CLASS_NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export function errorClassName(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const name = typeof e.name === 'string' ? e.name : '';
  if (name && name !== 'Error' && CLASS_NAME_SHAPE.test(name)) return name;
  const ctor = e.constructor?.name;
  if (ctor && ctor !== 'Error' && CLASS_NAME_SHAPE.test(ctor)) return ctor;
  return 'Error';
}

/** Exposed for tests so the clamp cannot drift from what callers rely on. */
export const _CLASS_NAME_SHAPE_FOR_TEST = CLASS_NAME_SHAPE;

/**
 * Map a thrown error to OR's fixed taxonomy.
 *
 * Two tiers, in order:
 *   1. The provider library's own error type, when we recognise it. Closed
 *      list; an unrecognised class falls through rather than guessing.
 *   2. The message regexes, unchanged. These still carry every non-CCXT
 *      provider (Quiltt, Strike, Sparrow, Blink) plus OR's own config errors.
 *
 * Unmatched by both -> UPSTREAM_OTHER. There is no third tier: matching on
 * Bitstamp's `reason` prose or its APIxxxx codes was considered and dropped,
 * because CCXT already does that mapping and maintains it, and because
 * provider-issued strings are outside the boundary the auditor cleared.
 *
 * `errorClass` is optional so existing callers that only have a string keep
 * working with tier 2 alone.
 */
export function classifyUpstreamError(raw: string, errorClass?: string): UpstreamErrorCode {
  // ── Tier 1: the provider library's own type ──────────────────────────────
  if (errorClass) {
    const mapped = CCXT_ERROR_CODES[errorClass];
    if (mapped) return mapped;
  }

  // ── Tier 2: message shape (unchanged from the original implementation) ───
  const m = raw.toLowerCase();
  if (/(\b401\b|\b403\b|unauthorized|forbidden|invalid.*(api.?key|token|credential)|signature.*(invalid|mismatch))/.test(m)) {
    return 'UPSTREAM_AUTH_FAILED';
  }
  if (/(\b429\b|rate.?limit|too.?many.?requests|quota.*exceeded)/.test(m)) {
    return 'UPSTREAM_RATE_LIMITED';
  }
  // Network / connectivity errors (expanded for Deno fetch + Node-style messages)
  if (/(\b5\d\d\b|timeout|timed.?out|econn(refused|reset|aborted)|network|unreachable|service.*unavailable|error sending request|fetch failed|connection (closed|reset|refused)|dns error|tls handshake|tls error)/.test(m)) {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (/(\b400\b|\b404\b|\b422\b|bad.?request|not.?found|unprocessable)/.test(m)) {
    return 'UPSTREAM_BAD_REQUEST';
  }
  // Response body parse failures (upstream returned non-JSON when JSON expected)
  if (/(syntaxerror|unexpected (token|end of json)|json[. ]*parse|invalid json)/.test(m)) {
    return 'UPSTREAM_PARSE_FAILED';
  }
  // OR's own bug -- adapter received malformed credentials/config (NOT upstream's fault).
  // Pattern matches "[provider] credentials.field required|missing|invalid".
  if (/(\[\w+\] )?credentials\.\w+ (required|missing|invalid)|credentials must be|credentials json/.test(m)) {
    return 'ADAPTER_CONFIG_ERROR';
  }
  // OR's own config gap -- missing env var on the Supabase project. We hit
  // this 2026-06-19 when a new OR DEV ref was provisioned without QUILTT_API_KEY
  // and the symptom surfaced as UPSTREAM_OTHER, hiding the real cause from ops.
  if (/not set on this supabase project|not configured|is required|missing env/.test(m)) {
    return 'ADAPTER_CONFIG_ERROR';
  }
  return 'UPSTREAM_OTHER';
}

/** Exposed for tests so the map cannot silently drift from its assertions. */
export const _CCXT_ERROR_CODES_FOR_TEST = CCXT_ERROR_CODES;
