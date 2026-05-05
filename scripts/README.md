# scripts

Out-of-band utilities that are not part of the production widget runtime.
They are run by hand from a workstation or the bb-support box and live
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
