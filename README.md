# OrangeRails

**Open-source, session-based zero-knowledge Bitcoin data aggregation.**

The rails every Bitcoin business runs on.

---

## What is OrangeRails?

OrangeRails is a data aggregation service for Bitcoin-related accounts — wallets, exchanges, payment processors, mining pools, and Bitcoin-friendly banks. Think of it as Plaid for Bitcoin, but architected so that **not even OrangeRails itself can read your credentials or transaction data.**

- **Session-based zero-knowledge encryption.** Credentials are encrypted in your browser with a key derived from your vault password. Our servers store ciphertext only.
- **Bitcoin-first, Lightning-native.** Every adapter is built for Bitcoin and Lightning, not retrofitted from legacy banking tooling.
- **Open source (Apache 2.0).** Every line of the credential-handling path is publicly auditable.
- **Self-hostable.** Same code runs in our hosted service or on your own server via Docker.

## Status

**Early development.** The OrangeRails API server is running at `orangerails.bitcoinsherpa.io` with a single Blink adapter as a proof of concept. The full hub (auth, vault, Link widget, multi-adapter sync engine) is in active design.

## Documentation

The source of truth for the project lives in the `docs/` folder:

- **[OrangeRails-Architecture.md](docs/OrangeRails-Architecture.md)** — definitive technical and strategic reference. Session-based ZKA design, threat model, regulatory alignment, cypherpunk heritage. All design decisions trace back to this document.
- **[OrangeRails-Plan.md](docs/OrangeRails-Plan.md)** — product plan, pricing model, adapter roadmap.
- **[OrangeRails-Lovable-Prompts.md](docs/OrangeRails-Lovable-Prompts.md)** — marketing-site Lovable prompts.

## Why

Every other data aggregator — Plaid, Mesh Connect, Teller, TrueLayer, Finicity, Vezgo, MX, Yodlee — stores user credentials in a form their servers can decrypt. That makes each of them the highest-value target in consumer fintech. A 2021 Hacker News commenter put it: *"Plaid is only one security breach away from being utterly destroyed."*

The 2022 LastPass breach is the proof-of-concept. Attackers exfiltrated encrypted vaults and then spent two years brute-forcing weak master passwords. Users lost hundreds of millions in crypto, including $150M from Ripple co-founder Chris Larsen. The lesson: **zero-knowledge works, but only if the architecture is actually zero-knowledge.** Promises are not security properties.

OrangeRails treats this as the design constraint. Our server literally cannot decrypt user credentials without active user participation. See [the architecture doc](docs/OrangeRails-Architecture.md) for the full reasoning and primary-source citations.

## License

Apache License 2.0. See [LICENSE](LICENSE).

This matches the licensing of Galoy, BTCPay Server, LND, and LDK — the de facto standard for Bitcoin open-source infrastructure.
