import {
  MissingSignatureError,
  SignatureVerificationError,
  TimestampToleranceExceededError,
} from "./errors";
import { computeHmacSha256Hex, timingSafeEqualHex } from "./verify";
import type { Event } from "./types";

/**
 * Header bag accepted by `constructEvent`. Keys are lower-cased on read
 * so callers can pass whatever casing their framework provides. Values
 * may be `string | string[] | null | undefined` to match Node / Fetch /
 * Express / Next.js shapes interchangeably.
 */
export type WebhookHeaders = Record<
  string,
  string | string[] | null | undefined
>;

export interface ConstructEventOptions {
  /**
   * Exact bytes of the request body as received, as a UTF-8 string.
   * MUST NOT be `JSON.parse`d and re-stringified — any whitespace or
   * key-ordering change will invalidate the signature.
   */
  rawBody: string;
  headers: WebhookHeaders;
  /** Webhook signing secret. Treat as UTF-8 bytes. */
  secret: string;
  /**
   * Maximum allowed difference (seconds) between the v2 signature's
   * timestamp and `now()`. Defaults to 300s (5 min). Only applies when
   * the v2 signature is used.
   */
  tolerance?: number;
  /**
   * Override of "now" in seconds since epoch. For testing clock skew.
   */
  now?: () => number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verify the signature on an Orange Rails webhook delivery and return a
 * typed `Event`. Throws `SignatureVerificationError` (or a subclass) on
 * any verification failure — never returns a partially-validated event.
 *
 * Prefers `X-OR-Signature-V2` (Stripe-style `t=<ts>,v1=<hex>`) when
 * present, since v2 prevents replay. Falls back to legacy
 * `X-OR-Signature` (raw hex HMAC over body only) for backwards compat
 * during OR's transition window.
 */
export async function constructEvent(
  options: ConstructEventOptions,
): Promise<Event> {
  const { rawBody, headers, secret } = options;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  if (typeof rawBody !== "string") {
    throw new SignatureVerificationError(
      "rawBody must be a string of the exact bytes received.",
    );
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new SignatureVerificationError("secret must be a non-empty string.");
  }

  const sigV2 = readHeader(headers, "x-or-signature-v2");
  const sigV1 = readHeader(headers, "x-or-signature");
  const eventId = readHeader(headers, "x-or-event-id");

  if (!sigV2 && !sigV1) {
    throw new MissingSignatureError(
      "No signature header present (X-OR-Signature-V2 or X-OR-Signature).",
    );
  }
  if (!eventId) {
    throw new MissingSignatureError("Missing X-OR-Event-Id header.");
  }

  if (sigV2) {
    await verifyV2({ rawBody, secret, sigHeader: sigV2, tolerance, now });
  } else {
    // sigV1 is non-null here because of the !sigV2 && !sigV1 check above.
    await verifyV1({ rawBody, secret, sigHeader: sigV1 as string });
  }

  return parseEvent(rawBody, eventId);
}

async function verifyV1(args: {
  rawBody: string;
  secret: string;
  sigHeader: string;
}): Promise<void> {
  const expected = await computeHmacSha256Hex(args.secret, args.rawBody);
  if (!timingSafeEqualHex(expected, args.sigHeader.trim())) {
    throw new SignatureVerificationError(
      "X-OR-Signature did not match expected HMAC.",
    );
  }
}

async function verifyV2(args: {
  rawBody: string;
  secret: string;
  sigHeader: string;
  tolerance: number;
  now: () => number;
}): Promise<void> {
  const parsed = parseV2Header(args.sigHeader);
  if (!parsed) {
    throw new SignatureVerificationError(
      "X-OR-Signature-V2 is malformed; expected 't=<unix>,v1=<hex>'.",
    );
  }

  const { timestamp, signatures } = parsed;
  if (signatures.length === 0) {
    throw new SignatureVerificationError(
      "X-OR-Signature-V2 contained no v1 signatures.",
    );
  }

  const signedPayload = `${timestamp}.${args.rawBody}`;
  const expected = await computeHmacSha256Hex(args.secret, signedPayload);

  const matched = signatures.some((s) => timingSafeEqualHex(expected, s));
  if (!matched) {
    throw new SignatureVerificationError(
      "X-OR-Signature-V2 did not match expected HMAC.",
    );
  }

  // Only enforce tolerance AFTER signature is valid — the timestamp is
  // signed, so we know it wasn't tampered with at this point.
  const skew = Math.abs(args.now() - timestamp);
  if (skew > args.tolerance) {
    throw new TimestampToleranceExceededError(
      `Timestamp outside tolerance window (skew=${skew}s, tolerance=${args.tolerance}s).`,
    );
  }
}

interface ParsedV2Header {
  timestamp: number;
  signatures: string[];
}

function parseV2Header(header: string): ParsedV2Header | null {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      timestamp = n;
    } else if (k === "v1") {
      signatures.push(v);
    }
    // Unknown keys (e.g. future v2) are ignored, matching Stripe.
  }

  if (timestamp === null) return null;
  return { timestamp, signatures };
}

function readHeader(headers: WebhookHeaders, name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      if (v == null) return null;
      if (Array.isArray(v)) return v[0] ?? null;
      return v;
    }
  }
  return null;
}

function parseEvent(rawBody: string, eventId: string): Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new SignatureVerificationError(
      "Webhook body is not valid JSON; cannot construct Event.",
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new SignatureVerificationError(
      "Webhook body is not a JSON object.",
    );
  }

  const body = parsed as Record<string, unknown>;
  const type = body["type"];
  const data = body["data"];

  if (type !== "sync.completed") {
    throw new SignatureVerificationError(
      `Unsupported webhook event type: ${String(type)}.`,
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new SignatureVerificationError(
      "Webhook body is missing 'data' object.",
    );
  }

  // Surface the X-OR-Event-Id as event.id rather than trusting any id
  // field embedded in the JSON body — the header is what dedupe keys on.
  return {
    id: eventId,
    type: "sync.completed",
    data: data as Event["data"],
  };
}
