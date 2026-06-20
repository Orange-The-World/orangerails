# BTCPay Server (self-hosted)

## What this integrates
Self-hosted BTCPay Server instances. Customers paste a server URL + an API
key with `btcpay.store.canviewinvoices` + `btcpay.store.canviewstoresettings`.
We pull store-scoped invoices and map each store to a wallet.

## Required configuration
| Where | Name | Notes |
|---|---|---|
| `encrypted_credentials` on the `connections` row | `btcpay_url` + `api_key` | JSON envelope, AES-GCM encrypted |

No Supabase env vars. No per-platform config.

## First plausible failure mode
Wrong server URL or missing API key scopes → 401/404 → classifies as
`UPSTREAM_AUTH_FAILED` or `UPSTREAM_BAD_REQUEST` depending on which scope failed.

## Related edge functions
- `or-sync/` — the only call site
