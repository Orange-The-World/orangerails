# Surge (Partner API v1.1)

## What this integrates
Surge Partner API — EVM-borrower account state. Customer's `bearer_token` is
a base64url envelope (signed JWT-shape with `borrower` + `partner` +
`chainId` fields). Adapter decodes the envelope, validates the borrower is
an EVM address, then queries Surge's partner API for events.

## Required configuration
| Where | Name | Notes |
|---|---|---|
| `encrypted_credentials` on the `connections` row | `bearer_token` | The base64url-encoded envelope from Surge. Encrypted under the customer's MEK |
| Supabase env (optional) | `SURGE_API_BASE` | Override the API base. Default: `https://test.partner.api.surge.dev/api/v1` |

No per-platform config in `platforms`.

## First plausible failure mode
- Envelope missing required fields → `[surge] bearer_token envelope missing field: <X>` → `ADAPTER_CONFIG_ERROR`.
- Expired or revoked token → Surge returns `{success: false, error.code: invalid_token}` → adapter throws `[surge:invalid_token] ...` → currently falls through to `UPSTREAM_OTHER` (the classifier doesn't pattern-match Surge's error code format).

## Related edge functions
- `or-sync/` — the only call site
