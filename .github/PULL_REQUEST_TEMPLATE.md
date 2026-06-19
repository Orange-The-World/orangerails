## Summary

<!-- One sentence: what this PR does, in plain language. -->

## Why

<!-- 2-4 bullets: the problem and why it matters now. Link issues if any. -->

## What changed

<!-- A short list of the concrete edits, grouped by file or area. Not a diff , a reader's-digest version. -->

## What I considered and rejected

<!-- 1-3 bullets. Each one: the alternative, and why you didn't pick it. If you didn't consider alternatives, say so. -->

## Risks and trade-offs

<!-- Be honest. "This adds a DB round-trip per request" is useful. "No risks" is almost never true and is a red flag to reviewers. -->

## Zero-knowledge check

<!-- Does this change let the server read anything it previously could not? If yes, justify. If no, confirm. -->

## How to verify

<!-- The exact commands a reviewer should run, or the manual steps to click through. If you ran tests, paste the summary line (e.g. "12 tests pass, 0 fail"). -->

## Out of scope

<!-- What you deliberately did not touch, so the reviewer knows not to ask for it here. -->

## Pre-publish checklist

<!--
Required for every PR. The leak-check workflow runs `scripts/pre-publish-scan.sh`
as a CI gate. Run it locally first to skip the CI round-trip:

  bash scripts/pre-publish-scan.sh
-->

- [ ] `bash scripts/pre-publish-scan.sh` exits clean on this branch
- [ ] No personal names in comments or strings
- [ ] No internal infrastructure references (private hostnames, internal wikis)
- [ ] No internal milestone tags (D-numbers, SEC-N, CQ-N, DB-N, PERF-N) outside the documented load-bearing exemptions
- [ ] No references to brands other than Orange Way, Orange Rails, or Bitcoin ZKA
- [ ] No `BitBooks` / `Lovable` / `Cala` / `Galoy` strings outside the documented crypto/storage exemptions in `src/lib/vault.ts` and the localStorage banner files
- [ ] No PR refs to deleted PRs (`PR #N`, `V2 PR`, `V3 PR`)
- [ ] No em-dashes, en-dashes, or spaced hyphens used as sentence breaks in user-facing copy
- [ ] Crypto load-bearing constants (`VAULT_VERIFIER_PLAINTEXT`, KDF salts) untouched
- [ ] If a new acceptable-product reference was added, the allowlist in `scripts/pre-publish-scan.sh` was updated in the same PR
