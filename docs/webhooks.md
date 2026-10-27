# OrangeRails Webhooks

OR is a Plaid-style platform: registered apps (V2, V3, OW, Personal,
future) can subscribe to events that fire when something happens
inside OR. Today every consumer polls `or-sync` because OR had no
event push. This document describes the event-push side: how to
register a webhook URL, the events emitted, the signature scheme,
and the retry policy.

## Registering a webhook URL

Two columns on `public.platforms` drive webhook delivery:

| Column           | Type | Purpose                                                              |
|------------------|------|----------------------------------------------------------------------|
| `webhook_url`    | TEXT | HTTPS endpoint OR POSTs events to. NULL disables webhooks.           |
| `webhook_secret` | TEXT | 32-byte random hex string (64 chars) used to sign every POST.        |

Set both via the platform-admin UI (or directly via SQL during
onboarding). Generate the secret with `openssl rand -hex 32`. The
secret never leaves OR after that one-time hand-off — consumers
store their own copy and verify against incoming `X-OR-Signature`
headers.

Both columns are nullable. If `webhook_url` is NULL when a sync
finishes, OR skips the webhook_delivery insert entirely (zero queue
load for platforms that haven't opted in).

## Event types

| Event            | Emitted by   | Payload fields                                                |
|------------------|--------------|---------------------------------------------------------------|
| `sync.completed` | `or-sync`    | `event`, `subaccount_id`, `connection_id`, `synced_count`, `ts` |
| `connection.errored` | `or-quiltt-sync` | `subaccount_id`, `connection_id`, `reason_code`, `repairable` |

One row is enqueued per connection that completed successfully — so a
multi-connection sync produces multiple webhook events, one per
connection. A connection that fails does not emit `sync.completed`. If the provider reports an explicit error for it, `connection.errored` may be sent instead (below). Empty syncs
(`synced_count: 0`) still emit; consumers that want only non-empty
events can filter on the field.

Example payload (dual-shape — both flat and nested fields are emitted during the SDK transition window so legacy hand-rolled receivers and `@orangerails/webhooks` consumers both work):

```json
{
  "event": "sync.completed",
  "subaccount_id": "11111111-1111-1111-1111-111111111111",
  "connection_id": "22222222-2222-2222-2222-222222222222",
  "synced_count": 17,
  "ts": "2026-05-22T12:00:00.000Z",
  "type": "sync.completed",
  "data": {
    "subaccount_id": "11111111-1111-1111-1111-111111111111",
    "connection_id": "22222222-2222-2222-2222-222222222222",
    "synced_count": 17,
    "ts": "2026-05-22T12:00:00.000Z"
  }
}
```

After all consumers migrate to `@orangerails/webhooks` (target end Q3 2026), the top-level `event` and flat fields will be removed and only `{ type, data }` will remain — matching Stripe / Linear / Shopify convention.

### `connection.errored`

Sent when a connection reports an explicit error from its provider and cannot sync until the problem is resolved. It lets an integrator tell the end user, for example with a reconnect prompt, instead of showing stale numbers with no explanation. It applies to connections that sync through Quiltt. Other providers will use the same shape.

The payload is `{ type, data }` only. This event has no legacy flat fields.

```json
{
  "type": "connection.errored",
  "data": {
    "subaccount_id": "11111111-1111-1111-1111-111111111111",
    "connection_id": "22222222-2222-2222-2222-222222222222",
    "reason_code": "USER_ACTION_REQUIRED",
    "repairable": true
  }
}
```

`data` is exactly these four fields. It never carries a raw provider message, free text, an amount or an institution name.

| `reason_code`          | `repairable` | Meaning                                                                          |
|------------------------|--------------|----------------------------------------------------------------------------------|
| `USER_ACTION_REQUIRED` | `true`       | The end user must complete the provider's reconnect flow before syncing resumes. |
| `INSTITUTION_ERROR`    | `false`      | The provider reports an error with the connected institution.                    |
| `PROVIDER_ERROR`       | `false`      | The provider reports an error with the connection.                               |
| `SERVICE_ERROR`        | `false`      | An unexpected error occurred while syncing the connection.                       |
| `UNKNOWN`              | `false`      | The provider reported an error of a kind this list does not cover.               |

The list is closed. A new code is a change to this contract. Treat a code you do not recognise as `UNKNOWN`.

`repairable: true` means reconnecting is the documented fix. `repairable: false` means reconnecting is not the documented fix. It does not promise that the connection recovers on its own, so do not show a reconnect prompt on a `false` event alone.

When it is sent:

- Only for an explicit error signal from the provider. A connection that is merely quiet or stale does not produce this event.
- At most one per connection in any rolling 24 hours. A connection that stays in error can produce a repeat about once a day, never more often.
- Not sent when the error cannot be tied to a connection that OR knows about.
- A later `sync.completed` for the same `connection_id` means the connection is syncing again. There is no separate recovery event.
- Handle it as a statement of state keyed by `connection_id`: the connection is in error. A repeat for the same `connection_id` must be harmless. A second delivery with the same `X-OR-Event-Id` is a retry of one event and is dropped, as for every event.

## Signature scheme

OR ships **two signature wire formats in parallel** during a transition
window. Consumers should prefer **v2** (more secure, easier to dedupe)
and may keep v1 verification as a fallback during the rollout.

The **`@orangerails/webhooks` npm package** wraps both — most consumers
should import it instead of hand-rolling verification.

### Wire-format v2 (preferred — added 2026-05-23)

Every webhook POST carries three headers in v2:

```
X-OR-Signature-V2: t=<unix_ts>,v1=<hex>
X-OR-Event-Id:     <uuid>
Content-Type:      application/json
```

where `<hex>` is the lowercase hex encoding of
`HMAC-SHA-256(webhook_secret_utf8, "<unix_ts>.<raw_body_utf8>")`.

The timestamp `<unix_ts>` is the dispatcher's UTC unix time (seconds)
at the moment the request was signed. Consumers SHOULD reject if
`abs(now - ts) > 300` (5-minute tolerance — same default as Stripe).
Putting the timestamp inside the signed material defeats naive replay
of a captured request.

`X-OR-Event-Id` is a UUID stable across retries of the same delivery.
Consumers MUST treat a second event with the same `X-OR-Event-Id` as a
duplicate (idempotent processing).

### Wire-format v1 (legacy — retained for back-compat)

```
X-OR-Signature: <hex>
Content-Type:   application/json
```

where `<hex>` is `HMAC-SHA-256(webhook_secret_utf8, raw_body_utf8)`.
No timestamp, no event id. Will be removed once all known consumers
have migrated to v2 (target: end Q3 2026).

### Verification rules (both versions)

- Recompute the HMAC over the raw request body (NOT a re-serialized
  JSON — byte-for-byte the bytes that arrived) with the stored secret.
- Compare in constant time.
- Rejecting unsigned or invalid-signature requests is the consumer's
  responsibility. OR does not retry differently based on signature
  validation outcome — a non-2xx response from your endpoint is a
  non-2xx response regardless of reason.

## Retry policy

`or-webhook-dispatch` drains the `webhook_delivery` queue on its own
schedule (cron-eligible; recommended every 30-60s).

- **Backoff**: per row, wait `min(60s * 2^attempts, 1h)` between
  retries. So a row that just failed its first attempt is retried
  ~60s later, then ~2m, ~4m, ~8m, ~16m... capped at 1h.
- **Cap**: 5 attempts total. After the 5th failure the row is left in
  the table (`succeeded_at` NULL, `attempts = 5`) for ops triage and
  is excluded from future scans by the
  `idx_webhook_delivery_pending` partial index.
- **Success**: any HTTP 2xx response. `succeeded_at` is set to the
  delivery time; `last_error` is cleared.
- **Disabled platform**: if `webhook_url` / `webhook_secret` is NULL
  at dispatch time (e.g. platform deregistered webhooks between
  enqueue and dispatch), the row is marked
  `succeeded_at = now(), last_error = 'platform_webhook_disabled'` so
  it leaves the queue without consuming retry budget.

Consumers should respond with 2xx as soon as the event is durably
queued on their side (do not block on downstream work). Anything
slower than ~10s risks platform-side timeouts and a wasted retry.

### Non-2xx responses and event types you do not handle

This applies to every event type, including `connection.errored`.

- A non-2xx response, a timeout or a connection failure is retried as described above: at most 5 attempts per event, then the row is left in the queue and is not sent again.
- OR does not know which event types an endpoint handles. An event type your endpoint rejects counts as any other non-2xx and uses the same retry budget.
- Verify the signature, then answer 2xx for event types you do not handle. Do not return an error just because a type is new to you.
- For `connection.errored` the volume is bounded. A receiver that rejects every one of them sees at most 5 requests per event, and at most one event per connection in any rolling 24 hours.
