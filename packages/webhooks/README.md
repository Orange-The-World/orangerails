# @orangerails/webhooks

Typed signature verification SDK for Orange Rails webhook deliveries.

One SDK consumed by V3 BitBooks Vault, V2 BitBooks, and Orange Way so all three receivers verify identically. Kills the "three reactive receivers" debt by giving every consumer the same code path. See the architecture rationale: <https://wiki.abascal.ca/doc/webhook-architecture-deep-dive-industry-comparison-2026-05-23-KnuaoGW4dI>.

## Install

This package is private (`private: true`) during the initial transition window. After the wire format stabilizes, it will be published to npm or GitHub Packages — that decision is tracked as a follow-up.

For now, consumers inside the MorningRevolution monorepo workspace can pull it via a workspace dependency or a git URL.

## Usage

```ts
import { constructEvent } from "@orangerails/webhooks";

const rawBody = await req.text(); // exact bytes — do not JSON.parse first

try {
  const event = await constructEvent({
    rawBody,
    headers: {
      "x-or-signature": req.headers.get("x-or-signature"),
      "x-or-signature-v2": req.headers.get("x-or-signature-v2"),
      "x-or-event-id": req.headers.get("x-or-event-id"),
    },
    secret: process.env.OR_WEBHOOK_SECRET!,
    tolerance: 300, // optional, default 300s (5 min) for v2
  });

  // event.id   — UUID from X-OR-Event-Id, use for consumer side dedupe
  // event.type — typed union ('sync.completed' | future event types)
  // event.data — typed payload matching event.type
  if (event.type === "sync.completed") {
    await enqueueSync(event.data.subaccount_id, event.data.connection_id);
  }
} catch (err) {
  // SignatureVerificationError (or subclass) — payload should not be trusted
  return new Response("invalid signature", { status: 401 });
}
```

## Wire format

The SDK accepts two signature headers during Orange Rails' transition window.

**`X-OR-Signature-V2`** (preferred, Stripe-style):

```
t=<unix_seconds>,v1=<hex_hmac>
```

where `hex_hmac = HMAC_SHA256(secret_utf8, "<ts>.<raw_body>")`. The timestamp is included in the signed payload, which prevents replay attacks. A 5-minute tolerance window is enforced by default and is configurable.

**`X-OR-Signature`** (legacy v1):

```
<hex_hmac>
```

where `hex_hmac = HMAC_SHA256(secret_utf8, raw_body)`. Body only, no timestamp — vulnerable to replay until the v2 transition is complete. Kept for backwards compat.

**`X-OR-Event-Id`** (always required): UUID per delivery. Surfaced as `event.id`. Use this for consumer side dedupe (e.g. unique index on a `received_event_id` column).

If both signature headers are present, v2 is verified and v1 is ignored.

## Public API

```ts
import {
  constructEvent,
  type ConstructEventOptions,
  type WebhookHeaders,
  SignatureVerificationError,
  TimestampToleranceExceededError,
  MissingSignatureError,
  type Event,
  type SyncCompletedEvent,
  type EventType,
  computeHmacSha256Hex,
  timingSafeEqualHex,
} from "@orangerails/webhooks";
```

### Errors

All verification failures throw `SignatureVerificationError` or a subclass. Catch the base class to reject the payload generically; narrow if you need to distinguish "stale" from "wrong":

- `SignatureVerificationError` — base class, also raised on tampered body / wrong secret / bad JSON / unsupported event type
- `TimestampToleranceExceededError` — v2 timestamp outside the tolerance window. Signature was valid but the delivery is too old (replay or clock skew)
- `MissingSignatureError` — neither `X-OR-Signature-V2` nor `X-OR-Signature` present, or `X-OR-Event-Id` missing

### `Event` types

`Event` is a discriminated union on `type`. Adding new event types (`sync.failed`, `connection.created`, etc.) is a backwards compatible addition.

```ts
interface SyncCompletedEvent {
  id: string;
  type: "sync.completed";
  data: {
    subaccount_id: string;
    connection_id: string;
    synced_count: number;
    ts: string; // ISO 8601
  };
}
```

## Runtime support

Uses Web Crypto (`globalThis.crypto.subtle`) exclusively — no Node specific imports. Runs in:

- Node 18+
- Deno (V3 / OW edge functions)
- Bun
- Cloudflare Workers
- Modern browsers (where it might make sense for testing fixtures)

## Development

```sh
cd packages/webhooks
npm install
npm run build      # tsup -> dist/ (ESM + CJS + .d.ts)
npm test           # vitest
npm pack --dry-run # preview what would publish
```

Tests include the RFC 4231 Test Case 1 HMAC-SHA-256 vector to guarantee bit identical output with Orange Rails' dispatch implementation.
