# xpub (Bitcoin BIP44/49/84 watch-only)

## What this integrates
Read-only Bitcoin wallets via xpub / ypub / zpub. We derive addresses
(gap-limit search), query mempool.space for transactions, normalize them
into the sink. Zero credentials shared with us — the xpub is the only secret.

## Required configuration
| Where | Name | Notes |
|---|---|---|
| `encrypted_credentials` on the `connections` row | `xpub` | The extended public key (xpub/ypub/zpub). Encrypted under the customer's MEK |

No Supabase env vars. No per-platform config.

## First plausible failure mode
Invalid xpub prefix or malformed key → adapter throws
`credentials.xpub invalid` → classifies as `ADAPTER_CONFIG_ERROR`.

## Related edge functions
- `or-sync/` — the only call site
