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
secret never leaves OR after that one-time hand-off , consumers
store their own copy and verify against incoming `X-OR-Signature`
headers.

Both columns are nullable. If `webhook_url` is NULL when a sync
finishes, OR skips the webhook_delivery insert entirely (zero queue
load for platforms that haven't opted in).

## Event types

| Event            | Emitted by   | Payload fields                                                |
|------------------|--------------|---------------------------------------------------------------|
| `sync.completed` | `or-sync`    | `event`, `subaccount_id`, `connection_id`, `synced_count`, `ts` |

One row is enqueued per connection that completed successfully , so a
multi-connection sync produces multiple webhook events, one per
connection. Failed connections do not emit. Empty syncs
(`synced_count: 0`) still emit; consumers that want only non-empty
events can filter on the field.

Example payload:

```json
{
  "event": "sync.completed",
  "subaccount_id": "11111111-1111-1111-1111-111111111111",
  "connection_id": "22222222-2222-2222-2222-222222222222",
  "synced_count": 17,
  "ts": "2026-05-22T12:00:00.000Z"
}
```

## Signature scheme

OR ships **two signature wire formats in parallel** during a transition
window. Consumers should prefer **v2** (more secure, easier to dedupe)
and may keep v1 verification as a fallback during the rollout.

The **`@orangerails/webhooks` npm package** wraps both , most consumers
should import it instead of hand-rolling verification.

### Wire-format v2 (preferred , added 2026-05-23)

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
`abs(now - ts) > 300` (5-minute tolerance , same default as Stripe).
Putting the timestamp inside the signed material defeats naive replay
of a captured request.

`X-OR-Event-Id` is a UUID stable across retries of the same delivery.
Consumers MUST treat a second event with the same `X-OR-Event-Id` as a
duplicate (idempotent processing).

### Wire-format v1 (legacy , retained for back-compat)

```
X-OR-Signature: <hex>
Content-Type:   application/json
```

where `<hex>` is `HMAC-SHA-256(webhook_secret_utf8, raw_body_utf8)`.
No timestamp, no event id. Will be removed once all known consumers
have migrated to v2 (target: end Q3 2026).

### Verification rules (both versions)

- Recompute the HMAC over the raw request body (NOT a re-serialized
  JSON , byte-for-byte the bytes that arrived) with the stored secret.
- Compare in constant time.
- Rejecting unsigned or invalid-signature requests is the consumer's
  responsibility. OR does not retry differently based on signature
  validation outcome , a non-2xx response from your endpoint is a
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
