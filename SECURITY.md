# Security Policy

OrangeRails handles cryptographic credentials. Our zero-knowledge claims must be verifiable — we welcome the people who verify them.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead:

- **Email:** `security@orangerails.com` *(placeholder — production address live at Phase 5 launch).*
- **GPG key:** *Coming with Phase 5.* Until then, use email for initial contact and we will coordinate an encrypted channel.

Include:

1. A description of the vulnerability.
2. Steps to reproduce.
3. Affected versions or commit SHAs.
4. Your assessment of impact (confidentiality / integrity / availability).
5. Any suggested fixes, if you have them.

We will acknowledge receipt within 72 hours. We commit to:

- An initial triage within 7 days.
- A remediation timeline within 14 days of triage.
- Credit in the public changelog and hall of fame (below), unless you request anonymity.

---

## Scope

### In scope — we want to hear about these

- **Credential confidentiality** — any path by which our server could read a user's plaintext provider credentials without the user's active session.
- **Key derivation weaknesses** — attacks on Argon2id parameters, HKDF usage, AES-GCM key reuse, IV reuse, etc.
- **Transport security** — TLS downgrade, certificate pinning bypass, cross-origin leakage in the Link widget.
- **Authentication bypass** — forged app signatures, access-token reuse, session fixation.
- **Injection and XSS** in the Link widget, marketing site, or any web surface.
- **Denial of service** on the hosted service if the impact is material.
- **Supply-chain vulnerabilities** in our dependencies that we have not patched within reasonable time.
- **Logic bugs** in adapter implementations that could expose user data (e.g., a Kraken adapter accidentally logging balances to Sentry).

### Out of scope

- Social engineering of OrangeRails team members.
- Physical attacks on infrastructure.
- Vulnerabilities in dependencies that have been public for less than 24 hours (we will patch them; please do not report them).
- User compromise via malware on the user's own device (this is the architectural limitation disclosed in Section 11.3 of the architecture document).
- Brute-force of weak user passwords (this is the user's responsibility per the LastPass lesson; we enforce minimum entropy but cannot prevent users from choosing weak passwords).
- Self-XSS requiring the user to paste malicious payloads into their own browser console.
- Findings from automated scanners without demonstrated impact.
- DNS hijacking, domain squatting of typo variants — not our attack surface.

---

## Safe harbor

We commit to not pursuing legal action against security researchers who:

1. Report vulnerabilities privately before public disclosure.
2. Make a good-faith effort to avoid privacy violations, data destruction, and service disruption.
3. Do not exploit the vulnerability beyond what is necessary to demonstrate it.
4. Give us reasonable time to fix before any public disclosure.

In plain English: if you find a flaw and report it responsibly, we will treat you as a collaborator, not an adversary.

---

## Coordinated disclosure

Our default public-disclosure timeline is **90 days** from the date we acknowledge your report, or at the time of the fix release, whichever comes first. If 90 days is insufficient (e.g., complex remediation), we will coordinate with you on a longer timeline.

We ask that researchers coordinate with us before public disclosure. We will coordinate with you before public disclosure.

---

## Hall of fame

Security researchers who have responsibly disclosed verified vulnerabilities in OrangeRails will be listed here with their permission.

*The hall is currently empty because the codebase is small and new. It is not empty because we dismiss reports.*

---

## Bounty program

We plan to run a formal bug bounty program starting at Phase 5 (public launch). Initial reward tiers:

- **Critical** (credential confidentiality break): $5,000+ (funding pending)
- **High** (authentication bypass, key derivation flaw): $1,000+
- **Medium** (adapter logic bug, XSS): $250+
- **Low / informational**: swag + public credit

Until the formal program launches, we will personally thank and publicly credit researchers. Given the project's early stage, please treat this as open-source volunteer work.

---

## Architecture references

To find vulnerabilities efficiently, focus your review on these paths:

1. **Credential encryption path** — everything from user input to ciphertext storage.
2. **Sync key handoff** — how ORK/ORT travel from the browser to the server and back to zero-state.
3. **Argon2id parameters and KDF usage** — current parameters in `apps/web/src/lib/vault.ts`.
4. **HKDF context string uniqueness** — any collision between subkey contexts is a bug.
5. **Adapter credential handling** — each adapter must never log, cache, or persist plaintext credentials outside the in-memory sync window.

See [OrangeRails-Architecture.md Section 7 (Trust Model and Threat Analysis)](./docs/OrangeRails-Architecture.md#7-trust-model-and-threat-analysis) for the full threat model.

---

Thank you for helping us protect users. Zero-knowledge is only real if it survives scrutiny.
