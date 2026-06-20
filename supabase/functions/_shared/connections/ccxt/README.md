# CCXT exchanges (manifest-driven)

## What this integrates
98+ centralized exchanges (Coinbase, Binance, Kraken, etc.) via the
[ccxt](https://github.com/ccxt/ccxt) library. The set is manifest-driven —
we don't hand-code per-exchange. Adding a new CCXT-supported exchange means
regenerating the manifest, not writing a new adapter.

## Files in this folder
- `adapter.ts` — generic ccxt adapter factory (was `_shared/providers/_ccxt.ts`)
- `manifest.ts` — generated list of supported exchanges (was `_shared/providers/_ccxt-manifest.ts`)

## Required configuration
Per-exchange API keys in `encrypted_credentials` (varies by exchange — keys,
secrets, passphrases). Format is the ccxt-native shape.

## Adding a new exchange
1. Ensure the exchange is supported by the pinned ccxt version
2. Run `scripts/generate-ccxt-manifest.mjs`
3. Commit the regenerated `manifest.ts` — dispatch auto-picks it up

## First plausible failure mode
Invalid key/secret → ccxt throws `AuthenticationError` → classified as
`UPSTREAM_AUTH_FAILED`.
