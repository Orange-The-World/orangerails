# Contributing to OrangeRails

OrangeRails is a cypherpunk project. Its legitimacy depends on community scrutiny , people reading the credential-handling code and confirming it does what we claim. We welcome contributions in that spirit.

This document explains how to contribute usefully.

---

## Before you start

Read these first:

- **[OrangeRails-Architecture.md](./docs/OrangeRails-Architecture.md)** , the source of truth. All contributions must fit within the session-based zero-knowledge architecture.
- **[OrangeRails-Implementation-Plan.md](./docs/OrangeRails-Implementation-Plan.md)** , what we are building now, what is still open.

Contributions that conflict with the architecture document will be declined even if technically correct. If you believe the architecture itself needs to change, open a discussion , we will update the document before accepting code that depends on the new design.

---

## What we welcome

### 🟢 High-signal contributions

- **Adapter implementations** for additional Bitcoin providers (Kraken, Strike, River, Phoenix, Fedi, etc.) , see [adapter priority](./docs/OrangeRails-Implementation-Plan.md#71-adapter-priority-order).
- **Cryptography review.** Audit the credential-encryption path. Report design flaws privately via [SECURITY.md](./SECURITY.md); report nits openly in issues.
- **Documentation improvements** , clarify confusing language, fix broken links, translate to other languages.
- **Self-hosting instructions** for platforms we have not tested (Umbrel, Start9, Citadel, Replit, Fly.io, Railway, etc.).
- **Reproducible-build tooling** so third parties can verify the binary matches the published source.
- **Accessibility work** on the Link widget.

### 🟡 Welcome but coordinate first

Open an issue describing the work before submitting a PR:

- Major refactors of shared code.
- New user-visible features or UI redesign.
- Changes to database schema.
- Changes to the wire protocol between apps and OrangeRails.

### 🔴 Not welcome

- Any change that introduces a server-side ability to decrypt credentials when the user is offline. This is the architectural line we do not cross.
- Telemetry, tracking, or analytics that collects data not strictly necessary for operation.
- Dependencies from organizations with a track record of supply-chain compromise, or dependencies that cannot be verified by hash.
- Adapter implementations that require storing credentials the user would not normally trust a third party with (brokerage passwords for accounts with withdrawal permissions, etc.). Read-only API keys only.
- Proprietary or source-available licenses. The project is and remains Apache 2.0.

---

## Development setup

### Prerequisites

- Node.js 22+
- Bun (for marketing site) or npm (for server)
- Docker (for local Supabase + self-hosted deployment testing)

### Running the API server locally

```bash
cd server
npm install
node server.js
# Listens on port 3003
```

### Running the marketing site locally

```bash
bun install
bun run dev
# Opens at http://localhost:5173 (Vite default)
```

### Running the full hub locally

*Coming with Phase 1* , will be a single `docker compose up` from the repo root.

---

## Good first issues

We tag beginner-friendly tickets with `good first issue`. If you're new and want to start somewhere small, open https://github.com/Orange-The-World/orangerails/labels/good%20first%20issue for the current list. If nothing's tagged yet, file an issue saying "I'd like a good first issue" and a maintainer will route you to one.

## Code style

- **TypeScript** for all new frontend and adapter code. Server-side is TypeScript-first (some Phase 0 JavaScript exists for legacy passthrough reasons and will be migrated).
- **Single quotes.** ESLint-enforced.
- **2-space indentation.** Prettier-enforced.
- **No `any` types** without a comment explaining why.
- **Function-level unit tests** for cryptographic code. Integration tests for adapter flows. Property-based tests welcome where applicable.
- **No comments describing what the code does.** Code explains *what*; comments explain *why*. Inline comments are for non-obvious design decisions only.
- **Edge functions must wrap `Deno.serve` with `wrapSentryHandler`.** New Supabase edge functions under `supabase/functions/<name>/index.ts` import `wrapSentryHandler` from `../_shared/sentry.ts` and wrap the handler: `Deno.serve(wrapSentryHandler(async (req) => { ... }, '<fn-name>'))`. Uncaught exceptions are then reported to the self-hosted GlitchTip at `pulse.orangerails.com` for triage. The helper is a no-op when `SENTRY_DSN` is unset (local dev).

---

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) loosely:

```
feat(adapter): add Strike adapter
fix(link-widget): encrypt before sending, not after
docs(architecture): clarify HKDF context strings
security(vault): bump Argon2id parameters
chore(deps): upgrade @noble/hashes to 1.4.0
```

Scope is optional but encouraged. Use the present tense ("add Strike adapter", not "added Strike adapter").

When a commit removes a restricted value (an internal hostname, reserved term, or sensitive string), describe it in the message rather than quoting the literal value. Write `fix: remove CGNAT host references from workflow docs`, not the actual string. Quoting a restricted value puts it back into git history.

---

## Pull requests

1. Fork the repo.
2. Create a feature branch: `git checkout -b feature/strike-adapter`.
3. Make changes, commit with a clean message.
4. Push: `git push origin feature/strike-adapter`.
5. Open a pull request against `main`.

**What makes a PR mergeable:**

- Tests pass in CI.
- Linked issue describing the problem (for anything beyond a typo fix).
- Clear before/after description of behavior change.
- Screenshot or demo video for UI changes.
- Threat-model impact statement for anything touching crypto or credentials.

**What delays merging:**

- No tests for new functionality.
- PR larger than ~500 lines of code without prior discussion.
- Dependencies added without justification.
- Inconsistent style with the rest of the codebase.

---

## Developer Certificate of Origin

All commits must be signed off per the [Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s -m "feat: add Strike adapter"
```

The `-s` flag appends `Signed-off-by: Your Name <your.email@example.com>`. By signing off, you certify the DCO , you have the right to submit the contribution under Apache 2.0.

This is not a legal document but a lightweight guarantee that every commit's provenance is traceable.

---

## Security issues

**Do not open public issues for security vulnerabilities.** Follow [SECURITY.md](./SECURITY.md) for private disclosure.

---

## Community expectations

Be kind. Be specific. Show your work.

- Disagreements are fine. Personal attacks are not.
- "This doesn't work" is not useful. Include the command, the output, the environment, the expected vs. actual behavior.
- Assume good faith. If someone asks a question you find obvious, answer it or skip it , do not shame them for asking.
- Code review is about the code, not the author.

This isn't a corporate workplace. It is, however, a technical community that needs to be welcoming enough that strangers feel safe asking questions and submitting their first PR. That norm is maintained by all of us.

---

## Questions?

- Technical questions: open a [discussion](https://github.com/Orange-The-World/orangerails/discussions).
- Governance questions: open an issue tagged `governance`.
- Anything private: security@orangerails.com *(placeholder , real address live at Phase 5).*

Thank you for considering a contribution. We are building something that matters.
