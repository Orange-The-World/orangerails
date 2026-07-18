# scripts

Out-of-band utilities that are not part of the production widget runtime.
They are run by hand from a workstation or the operator's infrastructure box and live
outside `src/` so they cannot accidentally end up in the browser bundle.

## test-zpub-sync.ts

End-to-end live test of the Stealth Sync orchestrator. Imports the same
`runSync`, `liveFetchFilter`, `liveFetchBlock`, and `liveFetchTip`
helpers the customer widget uses, feeds them a real extended key, and
prints the resulting transaction summary.

The extended key and wallet birthday are read from environment
variables so they never land in shell history or argv:

```
STEALTH_TEST_INPUT='<bare xpub/ypub/zpub or output descriptor>' \
STEALTH_TEST_BIRTHDAY='2025-11-05' \
bun --bun run scripts/test-zpub-sync.ts
```

The script:

- Parses the input via `parseDescriptor`.
- Generates a one-shot 32-byte AES stealth key in memory.
- Seals a wallet payload under that key and runs `runSync` against the
  live filter producer at `stealth.orangerails.com` and the block source
  at `blocks.orangerails.com`.
- Streams progress lines to stdout and prints a summary with the
  transaction count, total satoshis, block-height range, unique
  addresses, first and last five txids, bytes downloaded, and wall-clock
  seconds.

Nothing is written to disk and no inputs are echoed back. Do not commit
extended keys.

## ccxt-stress.mjs

Per-exchange stress-test harness. Validates that real API credentials
connect to each CCXT exchange that OR wires via its standard adapter.
Reports green or red per exchange, plus a summary count.

Credentials are read from `CCXT_TEST_CREDS` (JSON keyed by exchange id)
so they never appear in shell history or code:

```
CCXT_TEST_CREDS='{"kraken":{"apiKey":"...","secret":"..."}, \
                  "binance":{"apiKey":"...","secret":"..."}}' \
node scripts/ccxt-stress.mjs
```

The script:

- Re-derives the OR-wired exchange list from the installed ccxt package
  (same `ALLOWED_CRED_SHAPES` filter as `generate-ccxt-manifest.mjs`).
- For each exchange whose credentials appear in `CCXT_TEST_CREDS`, calls
  `fetchBalance()` with a 15-second timeout to confirm auth succeeds.
- Prints one line per tested exchange: `GREEN` or `RED`, timing, and any
  error message.
- Prints a summary table: wired total, credentialed, green, red, skipped.
- Exits with code 1 if any credentialed exchange returns red.

Exchanges without credentials in `CCXT_TEST_CREDS` are skipped and do
not affect the exit code.

Intended use: run this against a test account before merging CCXT
expansion PRs and paste the summary line count into the Zulip thread as
the coverage number.

## generate-ccxt-manifest.mjs

Generates the CCXT exchange manifest by introspecting the installed
`ccxt` package. Run this whenever you bump ccxt in `package.json` so
the manifest and the support matrix stay in sync.

```
node scripts/generate-ccxt-manifest.mjs
```

Writes:
- `supabase/functions/_shared/providers/_ccxt/manifest.ts`
- `docs/ccxt-status.md`
