# OrangeRails Profiles

App Profiles are the YAML rules that drive each consumer app's sink behavior. The runtime loads them at startup, validates them against a small schema, and uses them to resolve account-mapping decisions and status-string translations per transaction.

## What's load-bearing today

Two parts of the YAML drive runtime behavior:

| Section | What it does | Read at runtime |
|---|---|---|
| `account_mapping_rules` | First-match-wins rules that map (canonical type, direction, ...) → debit and credit `ChartOfAccount` hints | Yes |
| `status_to_v2` (or analogous per-app) | Provider status string → consumer enum value, with a `default` fallback | Yes |

Editing these in the YAML and redeploying changes runtime behavior. No TypeScript edit required for rule edits.

## What's still in TypeScript

Two parts stay in code for now:

| Section | Why it's still TS |
|---|---|
| `output_tables` | Row construction is more invariant than rule rows and benefits from compile-time type checks. Lifts to YAML when a third consumer joins the protocol and the engine needs to handle multiple shapes. |
| Derived-context functions | Per-transaction calculations (sat → BTC conversion, ISO timestamp split into date+time, etc.) are sink-specific helpers that live alongside the sink adapter. |

## Files

- `bitbooks-v2.yaml` — BitBooks V2 (live, plaintext at the data tier, vault-password ZK at the credential tier). Format slug: `bitbooks-v2`. Loaded by `_shared/sinks/bitbooks-v2.ts` via `loadProfile('bitbooks-v2')`.

## Adding a new consumer

1. Author the App Profile YAML in this directory: `<format-slug>.yaml`.
2. Implement the SinkAdapter in `_shared/sinks/<format-slug>.ts`. Most of the work is pre-computing the derived context for each transaction. The engine handles rules.
3. Export an `ensureProfileLoaded` async function from the sink module.
4. Register the sink + loader in `_shared/sinks/dispatch.ts`.
5. The consumer can now call `or-sync` with `format: '<format-slug>'`.

## Validation

Profiles are validated at load time:

- `app`, `version`, `canonical_version` are required strings
- `account_mapping_rules` is a non-empty array
- Each rule has either `when` (object) or `default: true`, never both
- Each rule has `debit` and `credit` CoA hints with valid `accountType` values

Validation failures throw `ProfileLoadError` and surface as a 500 from `or-sync` with a clear message. Fail-closed: a malformed YAML never silently routes transactions to the wrong account.

## References

- `_shared/sinks/profile-loader.ts` — YAML parse + validate + cache
- `_shared/sinks/profile-engine.ts` — rule matcher + status mapper + dotted-path resolver
- `_shared/sinks/types.ts` — SinkAdapter interface
- `_shared/sinks/dispatch.ts` — format slug → adapter + profile-loader registry
- `OrangeRails-Protocol.html` (in the orangerails-docs repo) — protocol design spec
