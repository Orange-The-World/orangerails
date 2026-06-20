# Blink (Lightning wallet via API)

## What this integrates
Blink (Galoy) Lightning wallet accounts. Customers connect by pasting a Blink
API key. We pull on-chain + Lightning transactions through Blink's GraphQL
endpoint, normalize them, and feed them into the sink (V2 / V3 / OWM).

## Required configuration
| Where | Name | Notes |
|---|---|---|
| `encrypted_credentials` on the `connections` row | `api_key` | Blink-issued API key, AES-GCM encrypted under the customer's MEK |

No Supabase project env vars required. No per-platform config in `platforms`.

## First plausible failure mode on a fresh OR project
401 from Blink GraphQL when the key is missing scopes (`READ` on wallets).
Classifies as `UPSTREAM_AUTH_FAILED`.

## Related edge functions
- `sync-blink/` — sandbox tester
- `or-sync/` — calls `blinkAdapter.discoverWallets` / `syncByWallets` / `syncAccountWide`
