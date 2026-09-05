/**
 * Error sanitisation boundary for edge functions, shared.
 *
 * WHY THIS MODULE EXISTS
 *
 * Upstream provider error messages, and JSON parse failures on decrypted
 * credential plaintext, can carry secret material. It must never reach:
 *   - the HTTP response body (caller side),
 *   - the edge function console (operator side, persisted about 7 days),
 *   - any persisted error column.
 *
 * or-sync has enforced that since audit 2026-05-16 (findings #1 and #4), but
 * its implementation is private to or-sync/index.ts, and that module calls
 * Deno.serve() at import time, so no other function and no test can import it.
 * Every other function that decrypts a credential therefore had no boundary at
 * all. This module is that boundary, with no import time side effects.
 *
 * WHAT IS SAFE TO EMIT, AND WHY EACH FIELD IS SAFE
 *
 *   code   a value from UpstreamErrorCode, a closed enum in upstream-errors.ts.
 *   class  errorClassName(), which is clamped to CLASS_NAME_SHAPE (an
 *          identifier of at most 64 chars) precisely so an upstream library
 *          cannot smuggle a sentence or a request body through `err.name`.
 *   fp     SHA-256 over a redacted first line, truncated to 8 bytes. A hash,
 *          not text. Stable for the same root cause so an operator can grep.
 *   cid    8 random bytes, minted per log line, for support cross reference.
 *   src    OPTIONAL. `err.upstreamCode` or `err.code` ONLY when it matches
 *          CODE_SHAPE. This is what keeps a Postgres SQLSTATE such as 23505
 *          useful to an operator after the message itself is dropped. It is a
 *          code shaped token, never free text: no spaces, at most 32 chars.
 *
 * WHAT IS NEVER EMITTED: the message. Not truncated, not redacted, not on the
 * UPSTREAM_OTHER path. Redaction by pattern is heuristic, and the plaintext
 * this boundary protects is arbitrary user credential material with no shape a
 * pattern can rely on, so there is nothing to redact it with.
 *
 * SCOPE NOTE: or-sync still carries its own equivalent private copy. Merging
 * the two is a separate change: or-sync is the live sync path, its boundary
 * already holds, and this change is scoped to the two functions that had none.
 */

import { classifyUpstreamError, errorClassName } from './upstream-errors.ts';
import type { UpstreamErrorCode } from './upstream-errors.ts';

/**
 * Characters a caller supplied label may contribute to a log line. Callers
 * pass literals plus, at most, one of our own uuids, so this is a belt and
 * braces clamp: it exists so that a future caller interpolating something
 * user controlled into a label cannot reopen the hole this module closes.
 */
const LABEL_ALLOWED = /[^A-Za-z0-9 _.:=/-]/g;
const LABEL_MAX = 80;

/** Shape a provider or Postgres code must have before it is echoed verbatim. */
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * Opaque short id for cross referencing a client side failure with an edge
 * log line. Not security sensitive: collision resistance only has to be good
 * enough to grep with.
 */
export function randomCorrelationId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 of a redacted first line, truncated to 8 bytes.
 *
 * The redaction here is NOT a safety control, because the output is a hash and
 * the input never leaves this function. It exists so the fingerprint is STABLE:
 * the same root cause returns the same value even when the upstream body
 * carries a fresh uuid or token each time.
 */
export async function errorFingerprint(raw: string, errorClass: string): Promise<string> {
  const firstLine = raw.split('\n')[0] ?? raw;
  const redacted = firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<token>')
    .replace(/\b\d{10,}\b/g, '<num>');
  const bytes = new TextEncoder().encode(`${errorClass}|${redacted}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(
    new Uint8Array(digest).slice(0, 8),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * The raw message, for classification and hashing only. Every caller of this
 * function inside this module consumes the value and drops it; it is never a
 * component of anything returned.
 */
function rawMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/** `upstreamCode` or `code`, but only when it is a code shaped token. */
function safeCodeOf(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  for (const key of ['upstreamCode', 'code']) {
    const value = record[key];
    if (typeof value === 'string' && CODE_SHAPE.test(value)) return value;
  }
  return undefined;
}

export interface SafeErrorDescriptor {
  code: UpstreamErrorCode;
  errorClass: string;
  fingerprint: string;
  correlationId: string;
  sourceCode?: string;
}

/** Everything about an error that is safe to emit, and nothing else. */
export async function describeErrorSafely(err: unknown): Promise<SafeErrorDescriptor> {
  const raw = rawMessageOf(err);
  const errorClass = errorClassName(err);
  const descriptor: SafeErrorDescriptor = {
    code: classifyUpstreamError(raw, errorClass),
    errorClass,
    fingerprint: await errorFingerprint(raw, errorClass),
    correlationId: randomCorrelationId(),
  };
  const sourceCode = safeCodeOf(err);
  if (sourceCode) descriptor.sourceCode = sourceCode;
  return descriptor;
}

function label(value: string): string {
  return value.replace(LABEL_ALLOWED, '').slice(0, LABEL_MAX);
}

/**
 * The one line a function should hand to console.error or console.warn.
 *
 * Usage, and the shape a source scan test asserts on the callers:
 *   console.error(await safeErrorLine('or-sync', 'credential-decrypt', err));
 *
 * fn and phase are caller supplied labels and are clamped by label() above.
 * Never pass user input as a label: pass a literal, optionally with one of our
 * own identifiers appended.
 */
export async function safeErrorLine(fn: string, phase: string, err: unknown): Promise<string> {
  const d = await describeErrorSafely(err);
  const parts = [
    `[${label(fn)}]`,
    label(phase),
    `code=${d.code}`,
    `class=${d.errorClass}`,
    `fp=${d.fingerprint}`,
    `cid=${d.correlationId}`,
  ];
  if (d.sourceCode) parts.push(`src=${d.sourceCode}`);
  return parts.join(' ');
}

/** Exposed for tests so the clamps cannot drift from what callers rely on. */
export const _LABEL_ALLOWED_FOR_TEST = LABEL_ALLOWED;
export const _CODE_SHAPE_FOR_TEST = CODE_SHAPE;
