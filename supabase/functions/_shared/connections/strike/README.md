# Strike

## What this integrates
Strike accounts (Lightning + fiat off-ramp). Webhook-driven: we register a
subscription on first sync, then drain `strike_webhook_events` for new
activity. Polling fallback kicks in if webhooks haven't been delivered.

## Required configuration
| Where | Name | Notes |
|---|---|---|
| `encrypted_credentials` on the `connections` row | `api_key` | Strike API key with `partner.account.profile.read`, `partner.invoice.read`, `partner.webhooks.manage` |
| `connections.strike_subscription_id` | populated lazily | Set on first sync; if absent, adapter registers a new subscription |
| `connections.strike_webhook_secret` | populated lazily | HMAC verification secret returned by Strike when subscription is created |

No Supabase env vars (the webhook URL is derived from `SUPABASE_URL`).

## DB tables
- `strike_webhook_events` — inbox of webhook payloads
- `strike_state_pagination` — per-state cursor for the polling fallback

## First plausible failure mode
- Missing webhook scope → 403 on subscription registration, persisted as
  `STRIKE_SCOPE_MISSING_*` on the connection.
- Invalid API key → 401, classified as `UPSTREAM_AUTH_FAILED`.

## Related edge functions
- `or-sync/` — adapter dispatch
- `or-strike-webhook/` — webhook receiver
- `or-connection-delete/` — calls `strikeDeleteSubscription` to unregister

## Files in this folder
- `adapter.ts` — provider implementation (was `_shared/providers/strike.ts`)
- `queue.ts` — webhook-event drain logic (was `_shared/providers/strike-queue.ts`)
