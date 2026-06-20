# Quiltt (banking aggregator)

## What this integrates
Bank-account aggregation through Quiltt's session-based widget + GraphQL
API. Quiltt connections are unique among OR providers: they are **client-side
manifest** (the customer sees Quiltt's own bank picker in an iframe) rather
than a server-side adapter in dispatch. No `quiltt` entry in `_registry.ts`.

The flow:
1. V2 / OWM / OWB calls `or-quiltt-session` to mint a customer-scoped Quiltt
   session token
2. The customer completes the Quiltt SDK popup (bank login)
3. Quiltt fires a webhook to `or-quiltt-webhook` with the new `connection.id`
4. `or-quiltt-link-complete` creates the OR `connections` row keyed on
   `(subaccount_id, quiltt_connection_id)` — the per-link unique index that
   landed in PR #219 lets a customer add multiple banks without collision
5. `or-quiltt-sync` (and `or-sync` in sink mode) drain
   `quiltt_webhook_inbox` events + fall back to a profile-wide direct
   GraphQL query when the inbox is empty

## Required configuration
| Where | Name | Notes |
|---|---|---|
| Supabase env | `QUILTT_API_KEY` | Quiltt secret API key (different per env: prod vs sandbox) |
| Supabase env | `QUILTT_CONNECTOR_ID_LINK` | Quiltt connector ID for initial bank link |
| Supabase env | `QUILTT_CONNECTOR_ID_RECONNECT` | Quiltt connector ID for reconnect flow |
| Supabase env | `QUILTT_WEBHOOK_SECRET` | HMAC verification secret for the webhook receiver |
| `platforms.quiltt_*` | per-platform overrides | Optional — each app (V2/OWM/OWB) can override the env defaults |
| `quiltt_profile_map` table | one row per subaccount | Maps OR subaccount → Quiltt profile id |
| `quiltt_webhook_inbox` table | queue | Incoming Quiltt webhooks land here pending processing |

## First plausible failure mode (today)
- Missing `QUILTT_API_KEY` on the Supabase project → adapter throws
  `QUILTT_API_KEY not set on this Supabase project` → now classified as
  `ADAPTER_CONFIG_ERROR` (post PR #244).
- Quiltt geo-blocks Canada → `or-quiltt-sync` sets `x-region: us-east-1` to
  route through Supabase's US edge; `or-sync` does NOT set this header yet
  (known gap; PRs welcome).

## Files in this folder
- `config.ts` — env + per-platform config resolution (was `_shared/quiltt-config.ts`)

## Related edge functions
- `or-quiltt-session/` — mint Quiltt session token
- `or-quiltt-session-via-widget/` — widget-scoped session mint
- `or-quiltt-link-complete/` — create OR connection from Quiltt connection_id
- `or-quiltt-accounts/` — list per-bank accounts after link
- `or-quiltt-sync/` — webhook-event drain
- `or-quiltt-webhook/` — webhook receiver
- `or-quiltt-disconnect/` — revoke + delete
- `or-sync/` — also drains Quiltt inbox in sink mode
