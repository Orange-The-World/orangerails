<div align="center">

# OrangeRails

### The open-source rails for Bitcoin financial data.

**Open-source, self-hostable, Bitcoin-native.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-F7931A.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Orange-The-World/orangerails/ci.yml?branch=prod&label=CI)](https://github.com/Orange-The-World/orangerails/actions/workflows/ci.yml)
[![Status: Early Development](https://img.shields.io/badge/Status-Early%20Development-yellow.svg)](#three-honest-caveats)
[![Architecture: Session-Based](https://img.shields.io/badge/Architecture-Session--Based-informational.svg)](./docs/OrangeRails-Architecture.md)
[![Self-Hostable: Yes](https://img.shields.io/badge/Self--Hostable-Yes-success.svg)](#self-host-in-under-30-minutes)
[![Bitcoin-Native](https://img.shields.io/badge/Bitcoin-Native-F7931A.svg?logo=bitcoin&logoColor=white)](#)

[**Architecture**](./docs/OrangeRails-Architecture.md) ·
[**Contributing**](./CONTRIBUTING.md) ·
[**Security**](./SECURITY.md)

</div>

---

## Why this exists

> *"Here we are faced with the problems of loss of privacy, creeping computerization, massive databases, more centralization, and \[David\] Chaum offers a completely different direction to go in, one which puts power into the hands of individuals rather than governments and corporations. The computer can be used as a tool to liberate and protect people, rather than to control them."*
>
> Hal Finney, cypherpunks mailing list, November 1992

Thirty-four years later, every financial data aggregator in existence still operates the way Finney warned against.

Plaid, Finicity, Teller, TrueLayer, Yodlee, MX, Mesh Connect, Vezgo: every one of them stores user credentials in a form their servers can decrypt. That makes each of them a high-value target. A single breach can expose tens of millions of users' financial histories in plaintext.

In 2022, [LastPass was breached](https://en.wikipedia.org/wiki/LastPass_2022_data_breach). Attackers exfiltrated encrypted vaults and spent the next three years brute-forcing weak master passwords. In March 2025, [federal prosecutors linked a $150 million cryptocurrency heist](https://krebsonsecurity.com/2025/03/feds-link-150m-cyberheist-to-2022-lastpass-hacks/) directly to that breach.

Plaid itself has never publicly disclosed a breach. As one Hacker News commenter put it in 2021:

> *"Plaid is only one security breach away from being utterly destroyed."* ([HN, August 2021](https://news.ycombinator.com/item?id=28229319))

Orange Rails exists so that the next generation of Bitcoin apps does not have to repeat that mistake. The server holds ciphertext. The keys live with the user.

---

## What Orange Rails is

Orange Rails is the open-source rails for Bitcoin financial data. Apps integrate once, customers connect their wallets, exchanges, Lightning nodes, and banks, and the data flows back to the app encrypted in a form Orange Rails' servers cannot read. The server proxies, the server stores, the server schedules. The server does not decrypt.

What ships in this repository:

- **API gateway.** A Cloudflare Worker that exposes a stable, versioned HTTP surface at `api.orangerails.com` and proxies to the backend.
- **Edge functions.** Supabase Edge runtime that handles connect flows, sync orchestration, webhook receivers, and per-platform isolation.
- **SDKs.** Typed clients for integrators, published from `packages/`.
- **Stealth Sync widget.** The drop-in connect widget that runs the in-browser key derivation and encrypts credentials before they leave the device.

For the full reference, including the session-based zero-knowledge boundary, the hybrid post-quantum key exchange, and the BIP 158 compact block filter design for on-chain wallets, read [docs/OrangeRails-Architecture.md](./docs/OrangeRails-Architecture.md).

---

## Who uses this today

Two production apps consume Orange Rails today. Both are sibling projects under the same ownership, which is how the API gets exercised end to end before it is asked to support unaffiliated integrators.

- **BitBooks.** Bookkeeping on a Bitcoin standard. The first consuming app, and the reason the bank, Lightning, and exchange adapter set looks the way it does. [bitbooks.com](https://bitbooks.com)
- **Orange Way.** A personal-finance manager and a personal-bookkeeping app in the same family. Drives the consumer side of the connect flow and the mobile-friendly widget surface.

Adding your app is the v0.1 path. The contract is the same one BitBooks and Orange Way use. If you want to be the third integrator, open an issue and say hello.

---

## Quick start (for integrators)

```bash
git clone https://github.com/Orange-The-World/orangerails
cd orangerails
npm install
npm run dev
```

You will need a Supabase project, a Cloudflare account for the Worker, and a Bitcoin or banking provider key for whichever adapter you want to exercise first (Blink and Quiltt are the easiest starting points). Copy `.env.example` to `.env.local` and fill in what is marked required.

Before you ship anything against a real customer, read [SECURITY.md](./SECURITY.md) and [docs/OrangeRails-Architecture.md](./docs/OrangeRails-Architecture.md). The integration contract assumes you understand which side of the encryption boundary your code is running on.

---

## Self-host in under 30 minutes

The same code that runs the hosted Orange Rails runs on your own infrastructure. The supported self-host stack is:

- **Cloudflare Pages** for the frontend and the widget.
- **Supabase** (hosted or self-hosted) for the database, auth, and edge functions.
- **One Cloudflare Worker** for the public API surface at your chosen domain.

Setup walkthroughs live in [/docs](./docs). You bring the accounts, the deploy scripts wire them together. The architecture guarantees are the same in both deployments because the credential-handling code is the same code.

---

## Three honest caveats

1. **Early development.** The proof-of-concept API at `api.orangerails.com` is live, but the full hub (auth, vault, widget, multi-adapter sync engine) is in active build. Expect breaking changes until the v0.1 tag.
2. **Self-host is not turnkey yet.** You will need a Supabase account, a Cloudflare account, and a willingness to read the setup docs end to end. A one-command installer is on the roadmap, it is not here today.
3. **Adapter coverage is narrow.** Blink (Lightning and USD stablecoin) and Quiltt (banks) are the production-tested paths. BTCPay, xpub watch-only, Kraken, River, Strike, LND, Core Lightning, and pool adapters are designed but not all shipped. See the Implementation Plan for the priority order.

---

## Join the build

Specific contributor profiles the project needs right now:

- **Backend engineers who write careful code.** The encryption boundary and the sync orchestration are the load-bearing surfaces. Work happens in `supabase/functions/`, `workers/api-gateway/`, and `packages/`.
- **Cryptographers who can audit the zero-knowledge boundary.** Every claim about what the server cannot see must be verifiable in code. Audit the key derivation, the session token lifetime, the in-memory decryption path, and the wipe semantics.
- **Bank and exchange integration developers.** New adapters follow a small, well-defined interface. A working adapter can be written in a day if you know the upstream API.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the developer certificate of origin (DCO) sign-off process and the code style guide.

---

## Architecture

Orange Rails is built around a session-based zero-knowledge boundary. The user's vault password derives keys in the browser via Argon2id and HKDF. Provider credentials are encrypted with those keys before they ever reach the server. When an app requests a sync, a derived key rides along in the TLS request body, the server decrypts in memory, talks to the upstream provider, re-encrypts the result, returns it, and zeros the key.

On the wire, the key exchange is hybrid post-quantum so that recorded traffic stays opaque to a future quantum adversary. On the on-chain side, BIP 158 compact block filters let watch-only wallets reconstruct their transaction history without ever telling the server which addresses to look for.

For the full reference (13 sections, 60+ cited primary sources, every claim traced to auditable code), see [docs/OrangeRails-Architecture.md](./docs/OrangeRails-Architecture.md).

---

## Heritage

Orange Rails stands on thirty-five years of cypherpunk thought.

- **Satoshi Nakamoto**, Bitcoin whitepaper (2008): *"electronic cash without going through a financial institution."* ([bitcoin.org](https://bitcoin.org/bitcoin.pdf))
- **Eric Hughes**, *A Cypherpunk's Manifesto* (1993): *"Privacy is the power to selectively reveal oneself to the world... Cypherpunks write code."* ([activism.net](https://www.activism.net/cypherpunk/manifesto.html))
- **Tim May**, *The Crypto Anarchist Manifesto* (1988): *"A specter is haunting the modern world, the specter of crypto anarchy."* ([Nakamoto Institute](https://nakamotoinstitute.org/library/crypto-anarchist-manifesto/))
- **Phil Zimmermann**, *Why I Wrote PGP* (1991): *"It's personal. It's private. And it's no one's business but yours."* ([philzimmermann.com](https://philzimmermann.com/EN/essays/WhyIWrotePGP.html))
- **Hal Finney**, cypherpunks list (1992): *"The computer can be used as a tool to liberate and protect people, rather than to control them."* ([Nakamoto Institute](https://nakamotoinstitute.org/finney/))

Orange Rails was originally created by MorningRevolution and is now developed in the open under the `Orange-The-World` organization.

---

## Related projects

- **BitBooks**: bookkeeping on a Bitcoin standard. First consuming app. [bitbooks.com](https://bitbooks.com)
- **Orange Way (Manager + Books)**: personal-finance and bookkeeping apps in the same family. Consumer of the widget and the sync engine.
- **ORBI**: Orange Rails Bitcoin Index, the price and rates dataset. Sibling repo at [`Orange-The-World/orbi`](https://github.com/Orange-The-World/orbi).
- **Orange World**: public CC-BY 4.0 truth tables at [orangethe.world](https://orangethe.world). Sibling repo at [`Orange-The-World/orange-world`](https://github.com/Orange-The-World/orange-world).

---

## License

Apache License 2.0. See [LICENSE](./LICENSE).

This matches the licensing of Galoy, BTCPay Server, Lightning Development Kit, and LND, the de facto standard for Bitcoin open-source infrastructure. Apache was chosen specifically for its explicit patent grant, which matters for a library other apps will build on.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The project uses DCO sign-off (`git commit -s`).

---

## Security

See [SECURITY.md](./SECURITY.md). Disclose responsibly via GitHub security advisory.

---

<div align="center">

*"Cypherpunks write code. We know that someone has to write software to defend privacy, and since we can't get privacy unless we all do, we're going to write it."*

Eric Hughes, *A Cypherpunk's Manifesto*, 1993

</div>

