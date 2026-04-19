# OrangeRails — Comprehensive Plan
**Date:** 2026-04-17 (SESSION 2026-04-17-DUNE)
**Author:** Orange Rails + Claude
**Status:** Strategy draft (pre-spec)
**Sources:** 151 team transcripts (Dec 2025 – Apr 2026), existing BitBooks research (ZKA docs, Backend PRD, Roadmap-Gaps), OSS landscape scan (Apr 2026)

---

## Note on naming

Roark originally proposed **"OrangeRails"** as this product's name (referenced in transcripts from Jan 17, Mar 3, Mar 23). After availability + positioning research during SESSION 2026-04-17-DUNE, the team chose **OrangeRails** — part of the **Orange family** alongside the maintainer's **Orange Bridge** project. Rationale:

1. **"OrangeRails" / Bit* names are compromised**: BitBridge Capital Strategies is a NASDAQ-bound public Bitcoin treasury company (ticker BTTL). BitRail, BitForge, and related Bit* names are all blocked in crypto/fintech. The name collisions make trademark + marketing untenable.
2. **"Orange family" branding compounds**: Orange Bridge + OrangeRails + future Orange products (potentially Orange Ledger, Orange Node) signals Bitcoin ethos instantly to the target audience and builds multi-product brand equity.
3. **"Rails" is the correct metaphor**: financial *rails* is established industry terminology. OrangeRails positions this as infrastructure — the rails every Bitcoin business runs on.

**In this document:** Roark's quoted statements in Section 1 preserve his original "OrangeRails" wording for historical fidelity. All other narrative mentions use **OrangeRails**.

**Domain:** original proposed domain was `orangerails.com` (Roark's suggestion). Replaced throughout with `orangerails.com` — availability still to be verified (see Section 10, open questions).

---

## 0. Executive Summary

**OrangeRails** is a **separate product** from BitBooks (different brand, different codebase, different website: `orangerails.com`). Its mission: be the single integration layer that any Bitcoin-using business — and any accounting tool serving them — needs to pull financial data from the Bitcoin ecosystem.

**Positioning (revised):** *"The open-source, zero-knowledge alternative to Plaid — built for Bitcoin."*

Five differentiators, in order of weight:
1. **Zero-Knowledge Architecture (ZKA)** — we cannot read your transaction descriptions, counterparties, or categorizations. Plaid can. Mesh can. Vezgo can. Nobody else in this space can honestly claim this.
2. **Open source** — Apache 2.0. Self-host or use our hosted service. No vendor lock-in.
3. **Bitcoin-first** — not watered down by Ethereum/Solana/NFT noise. Every adapter optimized for the Bitcoin ecosystem.
4. **Accounting-grade** — minute-level exchange rate capture, immutable records, double-entry journal hints. Auditor-ready by default.
5. **Open API spec** — partners (banks, wallets, exchanges, mining pools) build to our spec. We build to theirs if they already have one. Either direction works.

**Business model: Open Core + Hosted SaaS** (Supabase / PostHog / Sentry pattern — **not** Plaid's closed model, **not** gated ZKA):
- **All code OSS, including ZKA mode.** The cypherpunk audience that values OSS is the same audience that values ZKA — gating either alienates both.
- **Paid tier sells operational leverage**, not crippled features: managed hosting, SSO, audit logs, compliance certs (SOC 2, HIPAA BAA), HSM/KMS integration, private deployment, priority SLA.
- **Moat = partnership relationships** (Lunar Rails, Blink, BitCredit, Fedi, Ocean), not closed code.

**Three phases:**
- **V1** = read-only ingestion + Open Core launch.
- **V2** = write-back (initiate payments via partner APIs).
- **V3** = published spec; partners build to it.

---

## 1. Roark's Vision (Direct Quotes)

### 1.1 Core identity — "Plaid, but for Bitcoin"
> *"What we do in BitBooks is we have another tool called Bitcoin Connector, which is like Plaid or some of these ones that connect to the banking partners, but we're gonna do that to connect to Bitcoin banks, or directly to wallets on chain. Wherever your bank account is that has Bitcoin in it, we're gonna connect to it."*
> — Roark, Mar 23, 2026 (call with Tom Benner / Lunar Rails) *[Roark's original name; now OrangeRails]*

### 1.2 Open API spec, not closed wall
> *"Our goal is to publish an API spec in Bitcoin Connector that anybody who wants to play ball with us could basically build to our spec. But we're also willing to build to the other partner specs if you already have an open API that we could connect to."*
> — Roark, Mar 23

### 1.3 Read now, write later
> *"For now it's mainly read-only, just to capture the transactions. In the future, transactions initiated in the accounting software, and then the payment is sent through a write to the API."*
> — Roark, Mar 23

### 1.4 Dual model: open source + commercialized
> *"bitcoinconnector.com is the commercialized version of the Bitcoin Integrations API. You can just use the API, download it, put it into your own product, do what you want. Or if you just want a third-party service where you've built an app and you just need to connect to the whole universe of wallets, you can subscribe — but again, it's using the same core application. If you do it through Bitcoin Connector and BitBooks, we'll do it for you. But the open source software is there."*
> — Roark, Jan 17, 2026 (Medellín — Jeff Booth session)

### 1.5 Single API, universal reach
> *"Bitcoin Connector is intended to be a single API that BitBooks or any accounting system can connect to, and it in turn connects to Blink, BitCredit — like all the different things, including the US banking system, the European banking system. It'll be a complete integration tool that allows with one API to get to everything you need. Both will be open source."*
> — Roark, Mar 3, 2026

### 1.6 Keep it architecturally separate
> *"Make sure that all of these integrations live within a different entity called Bitcoin Connector so that we do not run into the same problem as V1, where eventually you cannot take out the integration from the code."*
> — the maintainer to Brandon, Feb 18, 2026

### 1.7 Jeff Booth's Trojan horse framing
> *"Is there APIs that you could take yours into the other accounting softwares — a Trojan horse into the other system? ... So it's not a question of, is this valuable, it's how do you get it out there."*
> — Jeff Booth, Jan 17, 2026 (Medellín fireside)

> **Takeaway:** OrangeRails is the wedge. A QuickBooks or Xero user can install OrangeRails alone (without switching their GL) and suddenly their BTC transactions flow in. That lowers the adoption barrier from "replace your accounting stack" to "add a plugin."

---

## 2. Market Landscape (Apr 2026)

### 2.1 What exists

| Product | Category | Coverage | Open source? | Bitcoin-first? | Accounting-grade? |
|---|---|---|---|---|---|
| **Plaid** | Bank aggregator | 12,000+ banks | No | No | No |
| **Plaid Wallet Onboard** | Crypto onboarding | 300+ self-custody wallets | No | No | Onboarding only |
| **Mesh Connect** | Crypto payments/transfers | 300+ exchanges/wallets/custodians | No | No | No |
| **Vezgo** | Crypto data aggregator | 40 CEXes, 20 blockchains, 250 wallets | No | No | No |
| **Koinly** | Crypto tax software | 800+ exchanges/wallets | No | No | Tax-only |
| **CoinTracker** | Crypto tax software | Hundreds | No | No | Tax-only |
| **BTCPay Server** | Payment processor | Self-hosted merchants | Yes (MIT) | Yes | No (payments only) |
| **Galoy/Blink** | Bitcoin banking infra | Self-hosted banking | Yes (Apache 2) | Yes | Partial |
| **Sparrow / bwt / Electrum** | Watch-only wallets | Bitcoin on-chain only | Yes | Yes | No (no API aggregation) |

### 2.2 The gap

Nothing in the market satisfies **all four** of these:
1. Bitcoin-first (not watered down by Ethereum/Solana/NFT noise)
2. Open source (self-hostable, no vendor lock-in, matches cypherpunk audience)
3. Accounting-grade (minute-level rate capture, double-entry mappings, auditable immutable records)
4. Published open spec (partners build to it, not just us to them)

Mesh Connect is closest on coverage but misses open source + accounting. Plaid has the model but ignores crypto. BTCPay is the right philosophy but narrow (merchants only).

### 2.3 Why now
- **Bitcoin banking is exploding**: Lunar Rails, River, Blink, BitCredit, Fedi, Swan, Strike — all 2023–2026 arrivals. None have a common integration layer.
- **Accounting is broken**: every BTC-using business today is still doing CSVs or hand-entry. Mining companies with 400+ rigs (Roark's case) have no tooling.
- **Jeff Booth validated the gap**: "This is a huge problem in the space."
- **Ashar Khan (Feb 16)**: confirmed during product review — integration credentials belong in OrangeRails, not in BitBooks code.

---

## 3. Architecture (Building on ZKA API Connectors doc)

### 3.1 Three layers

```
┌────────────────────────────────────────────────────────────────┐
│                   BITCOIN CONNECTOR                             │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Layer 3: Published Open Spec                    │  │
│  │    (what partners build to: auth, txns, webhooks)         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           ▲                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Layer 2: Provider Adapters                      │  │
│  │  Banking: Lunar Rails, BitCredit, Fedi                    │  │
│  │  Exchanges: Kraken, River, CoinEx, Strike, Swan           │  │
│  │  Wallets: Blink, BTCPay, Sparrow, Bitcoin Core, bwt       │  │
│  │  Mining: Ocean, ViaBTC, Braiins, F2Pool                   │  │
│  │  Lightning: LND, CLN, LDK, Phoenix                        │  │
│  │  Files: CSV, OFX, QIF, QFX                                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           ▲                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Layer 1: Core API + SDK                         │  │
│  │  GET /transactions   POST /sync   POST /connectors        │  │
│  │  GET /accounts       GET /balances   Webhooks             │  │
│  │  Authentication, rate limiting, dedup, normalization      │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 Data model (normalized output)

Every adapter normalizes to a common shape so consumers (BitBooks, QuickBooks plugin, Xero plugin, partner apps) get consistent data:

```json
{
  "connector_id": "uuid",
  "provider": "kraken",
  "account": {
    "id": "ext-1234",
    "display_name": "Main Trading",
    "currency": "BTC",
    "balance": "1.45230000",
    "type": "exchange"
  },
  "transaction": {
    "external_id": "KRAKEN-TX-5678",
    "timestamp": "2026-04-17T14:32:19Z",
    "amount": "0.0847",
    "currency": "BTC",
    "direction": "in",
    "type": "trade",
    "counter_amount": "5693.30",
    "counter_currency": "USD",
    "fee_amount": "0.00011",
    "fee_currency": "BTC",
    "raw_description": "Buy 0.0847 BTC @ $67,200 (encrypted if ZKA)",
    "exchange_rate": {
      "pair": "BTC/USD",
      "rate": "67200.00",
      "provider": "kraken",
      "timestamp_minute": "2026-04-17T14:32:00Z",
      "method": "spot"
    }
  },
  "suggested_journal_entry": {
    "debits": [{"account_hint": "bitcoin_wallet", "amount": "0.0847", "currency": "BTC"}],
    "credits": [{"account_hint": "fiat_wallet", "amount": "5693.30", "currency": "USD"}]
  }
}
```

**Key normalization rules:**
- Amounts: strings (not floats) — preserve precision
- Dates: ISO 8601 UTC
- Exchange rates: **minute-precision, provider-tagged** (auditor requirement surfaced in Jan 13, Jan 17, Mar 23 meetings)
- Every txn has a `suggested_journal_entry` — hints only, the consumer decides. This is OrangeRails's accounting DNA.

### 3.3 ZKA integration (for BitBooks V3 specifically)

Already covered in `ZKA/16-ZKA-API-Connectors.md`. Key pattern: **Split Connector**.
- Server half: fetches raw data, posts amounts/dates (plaintext math) to Cala, stores descriptions in a 24-hour pending table.
- Client half: decrypts pending descriptions, categorizes (AI or user), encrypts metadata, writes blind indexes.
- **For non-ZKA consumers** (QuickBooks plugin, standard SaaS users): drop the pending table, write descriptions directly — simpler path when zero-knowledge isn't required.

### 3.4 Connector tiers (reliability & privacy)

From `ZKA/16-ZKA-API-Connectors.md`:
| Tier | Mechanism | Privacy |
|---|---|---|
| **Tier 1** | Client-side (Plaid Link, CSV upload, own Bitcoin node via BIP-157/158) | Full ZKA |
| **Tier 2** | Server-proxy with pending table (Kraken, Coinbase, BTCPay webhooks) | Pragmatic ZKA (24h exposure window) |
| **Tier 3** | Aspirational (Bria client-side, LDK-WASM Lightning, WebSocket exchange feeds) | Full ZKA, needs innovation |

---

## 4. Open-Source Building Blocks

Strategy: **don't reinvent. Wrap existing OSS.** OrangeRails's value is normalization + aggregation + accounting semantics, not writing yet another Bitcoin node client.

### 4.1 Per-provider adapter foundations

| Provider category | OSS foundation | License | Integration pattern |
|---|---|---|---|
| **On-chain watch-only** | [bwt (Bitcoin Wallet Tracker)](https://github.com/bwt-dev/bwt) — Rust, xpub descriptors → Electrum RPC + HTTP API | MIT | Wrap as an adapter; self-hostable |
| **On-chain explorer** | [mempool.space / Esplora](https://mempool.space) | AGPL / MIT | REST + WebSocket; hosted or self-hosted |
| **Bitcoin Core RPC** | `bitcoind` direct | MIT | `listtransactions`, `getreceivedbyaddress` for advanced users |
| **Lightning (node)** | [LND gRPC](https://lightning.engineering/api-docs/api/lnd/) + [Faraday](https://github.com/lightninglabs/faraday) accounting tool | MIT | gRPC/REST; Faraday already does accounting exports |
| **Lightning (SDK)** | [LDK (Lightning Development Kit)](https://lightningdevkit.org) | Apache 2.0 | Library; future WASM for browser-side nodes |
| **Lightning (protocol)** | NWC (Nostr Wallet Connect), LNURL, BOLT11/12 | Open standards | Alby SDK wraps these |
| **Bitcoin banking** | [Galoy/Blink](https://github.com/GaloyMoney/blink) | Apache 2.0 | GraphQL API; self-hostable custodial banking |
| **Merchant payments** | [BTCPay Server Greenfield API](https://docs.btcpayserver.org/API/Greenfield/v1/) | MIT | REST + HMAC-SHA256 signed webhooks |
| **Tax accounting reference** | [Clams](https://clams.tech) LND accounting | — | Good pattern reference for node ops reports |
| **Wallet pairing** | [WalletConnect](https://walletconnect.network) (less Bitcoin-native) | Open source | QR/deep-link pairing; mainly EVM |
| **Mining pools** | [Braiins Pool API](https://braiins.com/pool), Ocean payouts (BOLT12), [BTC-Mining-Pool-API sample](https://github.com/mansouryaacoubi/BTC-Mining-Pool-API) | varies | REST; CSV/JSON exports |

### 4.2 Core infrastructure (the thing we build)

The adapters exist. What we build:
1. **Adapter interface** — TypeScript/Rust trait that every provider plugin implements: `authenticate() / listAccounts() / syncTransactions(cursor) / normalize() / healthCheck()`.
2. **Orchestrator** — schedules syncs, handles credentials (encrypted at rest per-tenant), dedups by `(provider, external_id)`, retries, circuit-breaking.
3. **Normalization engine** — raw adapter output → canonical shape (Section 3.2).
4. **Journal-entry hinter** — maps transaction types to suggested DR/CR based on provider type and category. This is the accounting DNA Roark cares about. Pluggable: customers can override hint rules.
5. **Exchange-rate oracle** — queries configured provider (Lunar Rails primary, Kraken/Coinbase fallback), captures to the **minute** with provider tag, stores immutably. Referenced in Jan 13, Jan 17, Mar 23 meetings as auditor-critical.
6. **Webhook receiver** — HMAC-validated endpoint for push providers (BTCPay, etc.). Normalized payload emitted on internal event bus.
7. **Consumer API** — REST + webhooks for downstream (BitBooks, partner plugins). Cursor-based pagination, bulk fetch, real-time stream.

### 4.3 Stack decision (proposal)

| Component | Choice | Rationale |
|---|---|---|
| Language | **TypeScript/Node.js (Deno)** for adapters, **Rust** optional for heavy adapters | Matches V3 stack (Supabase Edge Functions = Deno). Rust allowed for `bwt`-like indexers. |
| API | REST + WebSocket | Widest consumer reach. GraphQL layer optional later. |
| DB | Postgres (pluggable) | Matches BitBooks' Supabase. Self-hosters can bring their own. |
| Auth | OAuth 2.0 + API keys | Standard. Per-tenant encrypted credential storage. |
| Packaging | Docker Compose + Helm chart | Self-hosters deploy in 5 min. Matches "hosting is our monetization" model. |
| License | **Apache 2.0** (recommended) | Permits commercial use, matches Galoy/BTCPay community expectations, protects against patent claims. MIT also viable. |

---

## 5. Product Shape

### 5.1 Two SKUs, one codebase

```
┌─────────────────────────────────────────────────────────────┐
│                   OrangeRails Core                    │
│                     (github.com/…, OSS)                     │
│                                                             │
│  - Adapter framework                                        │
│  - Orchestrator                                             │
│  - Normalization + JE hinter                                │
│  - Exchange rate oracle                                     │
│  - Webhook receiver                                         │
│  - Consumer REST/WS API                                     │
└─────────────────────────────────────────────────────────────┘
                  │                         │
    ┌─────────────┘                         └─────────────┐
    ▼                                                     ▼
┌───────────────────────┐                   ┌───────────────────────────┐
│  Self-Host (OSS)      │                   │  orangerails.com     │
│  - Docker Compose     │                   │  - Managed hosting         │
│  - Helm chart         │                   │  - Pre-configured adapters │
│  - Bring-your-own DB  │                   │  - Auto-upgrades           │
│  - Community support  │                   │  - SLA, support            │
│  - Free               │                   │  - Per-connection pricing  │
└───────────────────────┘                   └───────────────────────────┘
```

### 5.2 Consumer interfaces (who connects to OrangeRails?)

1. **BitBooks (first customer)** — direct REST consumer. Connector is the ingestion layer for all BTC-related data.
2. **QuickBooks plugin** (Trojan horse) — a thin QBO app that calls OrangeRails, translates output to QBO journal entries. Jeff Booth's suggestion.
3. **Xero plugin** — same pattern.
4. **Wave / FreshBooks / Zoho plugins** — same pattern, on demand.
5. **Partner SaaS products** — e.g., a Bitcoin payroll platform, a Bitcoin treasury dashboard — they install Connector to get wallet data without building their own adapters.
6. **Hosted API customers** — no accounting tool at all, just need BTC data piped into their CRM/ERP. SaaS pricing per-connection.

### 5.3 Partner program (the open spec side)

> "Our goal is to publish an API spec that anybody who wants to play ball with us could build to." — Roark

- **Inbound**: partners (Lunar Rails, Blink, BitCredit, Fedi) expose a standard data shape; we write a minimal adapter. Cost: low.
- **Outbound spec**: partners with no existing API consume our *integration SDK* to expose themselves in the standard shape. They host an endpoint; Connector calls it. This makes OrangeRails the *neutral integration fabric* for the Bitcoin banking industry.

---

## 6. Provider Adapter Roadmap

Merges Backend PRD Addendum + Roadmap-Gaps + transcript signals (Feb 18 pricing call, Feb 10 Daenon meeting, Mar 23 Lunar Rails call).

### 6.1 Tier 0 (MVP — demo + first customers)

| # | Provider | Why | Effort | Status |
|---|---|---|---|---|
| 1 | **CSV/OFX/QIF file import** | Universal fallback. 100% of competitors. | Small | Partly in Lovable-08 |
| 2 | **Lunar Rails (exchange rates)** | Auditor requirement per Jan 13/17/Mar 23 meetings. Active partnership (Tom Benner). | Small | Active partnership |
| 3 | **Bitcoin Core / bwt (xpub watch-only)** | Non-custodial users want this. Full ZKA viable. | Medium | Not started |
| 4 | **BTCPay Server** | Merchant customers. Webhook-based = low effort. | Small | Greenfield v1 stable |

### 6.2 Tier 1 (first paying customers)

| # | Provider | Why | Effort |
|---|---|---|---|
| 5 | **Blink/Galoy (GraphQL)** | Lightning + USD. Roark's network. Open source counterpart. | Medium |
| 6 | **Kraken** | Biggest BTC exchange by US volume. Strong REST API. | Medium |
| 7 | **River** | US-favored DCA + BTC-native. Demo-friendly customer base. | Medium |
| 8 | **Lunar Rails (banking read-only)** | Phase 2 of Lunar Rails partnership — fiat + BTC txns via single connection. | Medium–Large |
| 9 | **Mining pools (Ocean, Braiins, ViaBTC)** | Roark's own use case (~400 rigs). | Medium per pool |

### 6.3 Tier 2 (scale)

| # | Provider | Why | Effort |
|---|---|---|---|
| 10 | **LND / CLN direct** | Self-hosted Lightning nodes. Big prosumer market. | Medium |
| 11 | **CoinEx** | Listed in Backend PRD. | Medium |
| 12 | **Swan, Strike** | US BTC banking partners. | Medium |
| 13 | **BitCredit** | Referenced by Roark in Mar 3 OSS call. | Medium |
| 14 | **Fedi** | Mini-app ecosystem, Bitcoin Circular Economy donations. | Medium |

### 6.4 Tier 3 (long tail)

- Coinbase (OAuth, widely used)
- Cash App API (if opened)
- Sparrow Wallet (file-based) — signers already export CSV
- Phoenix Wallet, Breez, Mutiny (LDK-based) — when they expose APIs
- WalletConnect v2 — for dApp-adjacent BTC tooling

### 6.5 Write-back (V2)

> "In the future, transactions initiated in the accounting software, and the payment is sent through a write to the API." — Roark, Mar 23

- V1: read-only aggregation. Ship this before anything else.
- V2: invoices created in BitBooks → Connector POST → BTCPay/Blink creates on-chain/LN payment.
- V2: bill pay — BitBooks marks invoice as paid → Connector triggers Lunar Rails outgoing wire.
- V3: multi-sig approval workflows (treasury use case).

---

## 7. Business Model — Open Core + Hosted SaaS

### 7.1 Why NOT Plaid's model, and why NOT gated ZKA

**Plaid's model (fully closed source) doesn't fit** — Roark stated explicitly on Mar 3: *"Both will be open source. That's the plan."* Closing the code contradicts the cypherpunk positioning and sacrifices the community-distribution advantage.

**Gating ZKA behind an enterprise paywall also doesn't fit** — even though it's tempting as a moat:

| Why it fails | Explanation |
|---|---|
| Philosophically inconsistent | ZKA is the core differentiator. Making the *free* version *worse on privacy* alienates exactly the audience that values OSS. |
| Architecturally fragile | Split-connector + pending-inbox is ~500 lines of pattern code. A community fork reimplements it in a weekend (see Redis→Valkey, Terraform→OpenTofu, Elastic→OpenSearch). |
| Confuses the marketing story | *"We're the zero-knowledge alternative to Plaid"* is a powerful pitch. *"We're the zero-knowledge alternative to Plaid, unless you can't afford the enterprise plan"* is not. |

### 7.2 The right model: Supabase / PostHog / Sentry (Open Core + Hosted SaaS)

**Everything is OSS, including ZKA mode. Paid tier sells operational leverage, not gated features.**

| Capability | Self-host (free OSS) | orangerails.com (paid) |
|---|---|---|
| Core adapters + orchestrator + JE hinter | ✓ | ✓ |
| **ZKA split-connector mode** | **✓** | **✓** |
| Exchange-rate oracle (minute-precision) | ✓ | ✓ |
| REST + webhook consumer API | ✓ | ✓ |
| Community adapter marketplace | ✓ | ✓ |
| Docker Compose + Helm chart deploy | ✓ | n/a (we run it) |
| Multi-tenant orchestration | ✗ | **✓** |
| SAML / OIDC SSO | ✗ | **✓** |
| Audit log + compliance exports | ✗ | **✓** |
| SOC 2 Type II report, HIPAA BAA | ✗ | **✓** |
| Managed hosting + auto-upgrades | ✗ | **✓** |
| HSM / KMS integration for enterprise key custody | ✗ | **✓** |
| Priority SLA (99.95%, 1hr response) | ✗ | **✓** |
| Verified partner-signed adapters | ✗ | **✓** |
| Private deployment (single-tenant VPC) | ✗ | **✓** |

**Key insight:** these paid features are things solo developers *cannot* replicate — not because the code is secret, but because running SOC 2 audits, maintaining HIPAA BAAs, and operating 24/7 hosting with SLAs are genuinely expensive. Enterprises pay for the *service*, not the bits.

### 7.3 Revenue streams — Hybrid pricing model

OrangeRails serves three distinct audiences. A single tier structure can't price all three correctly. The hybrid model splits pricing by **who the customer is**, benchmarked against how Plaid, SimpleFIN, and Koinly actually monetize their segments today.

#### 7.3.1 Benchmarking — how Plaid and SimpleFIN make money

| | Plaid | SimpleFIN | Koinly |
|---|---|---|---|
| **Who pays** | Developers (fintech apps) | End users directly | End users directly |
| **Pricing unit** | Per connected account + per API call | Flat per-user subscription | Flat per-user subscription |
| **Typical price** | $0.30–$1.00/account/mo + $0.50–$2.00/API call | **$1.50/mo or $15/year** | $49–$279/year, tiered by transaction count |
| **OSS?** | No (closed) | Partial (protocol open, bridge paid) | No (closed) |
| **Revenue ceiling per customer** | Unlimited (metered) | ~$15/user/year | ~$279/user/year |
| **Target at scale** | Enterprise fintechs (~$250k+/year) | Hobbyist users ($15/year × thousands) | Prosumer tax filers |

**Key insight:** Plaid's revenue compounds because they charge every time a user syncs. SimpleFIN's revenue is capped per user but works at tiny operational cost. Koinly sits in between — flat fee, but prices rise with user sophistication (transaction count tiers).

**OrangeRails needs to serve all three models because it has all three audiences.** Forcing developers into a $99/year consumer plan leaves enterprise money on the table. Forcing individuals into a per-connection metered plan kills adoption.

#### 7.3.2 The three customer segments

| Segment | Who | Pricing model | Benchmark |
|---|---|---|---|
| **End users** | Individuals tracking their own BTC, small merchants, home miners | Flat subscription (SimpleFIN/Koinly style) | SimpleFIN $15/year, Koinly $99/year |
| **Teams & businesses** | Accounting firms, mid-sized miners, Bitcoin-native businesses | Flat subscription per org with user/feature caps | Linear/Notion/QuickBooks Online style |
| **Developers & fintechs** | BitBooks itself, QuickBooks plugin, partner apps, other accounting tools embedding us | Usage-based (Plaid style — per-connection per-month) | Plaid $0.30–$1.00/connection/month |

#### 7.3.3 End-user tiers (SimpleFIN-style, flat subscription)

| Tier | Price | Connections | Sync freq | Support | For |
|---|---|---|---|---|---|
| **Self-host** | Free forever | Unlimited | You control | Community | DIY, full ZKA, full capability — you run it |
| **Personal** | **$15/year** ($2/mo) | Up to 5 | Daily | Community | Individuals tracking their own BTC stack |
| **Prosumer** | **$99/year** ($10/mo) | Unlimited | Hourly + real-time webhooks | Email (72hr) | Miners, merchants, side-business owners |

Rationale: $15/year matches SimpleFIN's validated willingness-to-pay for hobbyist self-serve. $99/year matches Koinly's individual-tier anchor — Bitcoin users already accept this price point for tax software, so accounting aggregation isn't a stretch. Both tiers are deliberately cheap — acquisition engine for the hosted SaaS, and a signal that we're not Plaid squeezing users behind the scenes.

#### 7.3.4 Team & business tiers (standard SaaS subscription)

| Tier | Price | Connections | Users | Features | For |
|---|---|---|---|---|---|
| **Team** | **$49/mo** ($490/year) | Up to 25 | 5 seats | Email support (24hr), audit log, daily backups | Accounting firms serving BTC clients, small miners (<50 rigs) |
| **Business** | **$199/mo** ($1,990/year) | Unlimited | Unlimited | SAML/OIDC SSO, priority support (4hr), 99.9% SLA, verified adapters | Bitcoin-native companies, mid-sized mining ops, multi-entity orgs |
| **Enterprise** | Contact sales | Unlimited | Unlimited | SOC 2, HIPAA BAA, HSM/KMS, private deploy, 99.95% SLA, named CSM | Public-listed miners, banks, regulated treasuries |

Rationale: $49/mo is the standard "we're serious but not enterprise" anchor (QuickBooks Online Plus is $99/mo, Xero Growing is $47/mo — we sit in the same neighborhood). $199/mo is the SSO+SLA threshold, which is genuinely where operational costs go up. Enterprise is custom because compliance certifications vary by industry.

#### 7.3.5 Developer API tier (Plaid-style, usage-based)

Customers here aren't end users — they're other products (BitBooks itself, a QuickBooks plugin, a Bitcoin payroll SaaS, etc.) that embed OrangeRails as infrastructure.

| Tier | Price | For |
|---|---|---|
| **Sandbox** | Free (rate-limited) | Testing, up to 5 test connections, no production traffic |
| **Production** | **$500/mo base + $0.50/connection/month + $0.001/API call** | Apps with real users |
| **Volume** | Negotiated (25% off at >10k connections) | Scale customers |
| **Enterprise API** | Custom contract | Custom SLA, dedicated infrastructure, white-label |

Rationale: matches what developers already pay Plaid (~$0.30–$1.00/connection/mo). The $500/mo base covers operational minimums. BitBooks itself becomes OrangeRails's first paying API customer — clean intra-company accounting since BitBooks charges its users, pays OrangeRails per BTC connection they have.

#### 7.3.6 Additional revenue streams

1. **Accounting & bookkeeping services** — Roark's offshore team does the actual BTC accounting work. Connector is the data pipe; services are the margin layer. Priced per engagement.
2. **Partnership co-marketing** — banking partners (Lunar Rails, Blink, BitCredit, Fedi) pay for featured catalog placement, verified-adapter badges, co-branded launch campaigns. Priced per partnership tier.
3. **Self-hosted support contracts** — enterprises running the OSS themselves pay for expert implementation help, priority bug fixes, and dedicated support. Red Hat-on-Linux model. Priced per year.

#### 7.3.7 Year-1 revenue thought exercise (rough)

Just to pressure-test the numbers:

| Segment | Customers | ARPU | Year-1 ARR |
|---|---|---|---|
| Personal | 2,000 × $15 | $15/yr | $30k |
| Prosumer | 500 × $99 | $99/yr | $50k |
| Team | 100 × $588 | $588/yr | $59k |
| Business | 30 × $2,388 | $2,388/yr | $72k |
| Enterprise | 3 × $50k | $50k/yr | $150k |
| Developer API | 5 × $10k | $10k/yr | $50k |
| Partnership | 3 × $20k | $20k/yr | $60k |
| Services | 10 × $15k | $15k/engagement | $150k |
| **Total Y1** | | | **~$620k ARR** |

Not a promise — a sanity check. The model scales from hobbyist ($15/year) to enterprise ($50k+/year) without changing the product. That's the point of the hybrid.

#### 7.3.8 Before committing prices: price test the waitlist

**Don't hard-code the prices above on the landing page.** These are plausible placeholders. Real numbers come from:

1. **Waitlist signal**: use BC-03's `use_case` capture to segment signups. Ask the top 50 signups directly: *"What would you pay for this?"*
2. **Cohort price test**: offer 3 different prices to 3 cohorts via email. Measure conversion at $10/$15/$25 for Personal, $79/$99/$129 for Prosumer, $39/$49/$79 for Team. Anchor the Business tier at $199 since SSO buyers are price-insensitive.
3. **Partner feedback**: Lunar Rails, Blink — ask what their customers would accept. They have real B2B BTC pricing data we don't.
4. **Competitive repricing**: revisit every 6 months as Plaid, Mesh, Vezgo, and SimpleFIN evolve.

The plan doc locks in the **structure** (3 segments × hybrid model). Numbers are parametric.

### 7.4 The real moat

Not closed code. Not gated features. The moat is:

1. **Signed partnership agreements** — Lunar Rails, Blink, BitCredit, Fedi, Ocean. These take months to negotiate; you can't fork a relationship.
2. **Adapter quality + maintenance SLA** — community adapters exist but *verified, production-ready* adapters with guaranteed response times live in the paid tier.
3. **Compliance paperwork** — SOC 2 Type II is $100k+/year to maintain. HIPAA BAA, GDPR DPA, etc. are real barriers to competitive entry.
4. **Network effects** — every new partner who publishes to the open spec makes the ecosystem more valuable for every other consumer. BitBooks is the neutral hub.

### 7.5 Licensing decision

**Recommend: Apache 2.0.** Reasons:
- Permits commercial use (hosted SaaS, partner products)
- Community-standard in Bitcoin OSS (BTCPay, Galoy, LDK, LND — all Apache 2.0)
- Patent grant clause protects against submarine claims
- Compatible with MIT/BSD dependencies

**Alternatives considered:**
- **MIT** — simpler but no patent clause. Fine fallback.
- **BSL 1.1 → Apache after 3 years** (MongoDB/CockroachDB pattern) — sells "commercial redistribution" licenses during the BSL window. Purists dislike it, but tolerated. Only choose this if we need near-term license revenue. My recommendation: skip BSL — the hosted SaaS story is strong enough without it.
- **AGPL** — forces network-effect copyleft. Over-aggressive for a library meant to be integrated. Would scare off the QuickBooks-plugin Trojan horse strategy.

### 7.6 Go-to-market wedges

- **Wedge #1 (ZKA-over-Plaid narrative)**: *"Plaid sees every transaction you route through them. We can't. That's the architecture."* Marketing-friendly, backed by 2020 Plaid class action context, technically defensible.
- **Wedge #2 (Trojan horse)**: QuickBooks plugin using OrangeRails. Customer doesn't have to switch their GL — just install the plugin, BTC transactions flow in. Lowers BitBooks' adoption cost to near-zero.
- **Wedge #3 (sovereignty)**: *"Your Bitcoin data, your server, your accounting."* Self-host story resonates with cypherpunks, nodes-at-home movement, and privacy-conscious miners/treasuries.
- **Wedge #4 (banking co-marketing)**: ship alongside Lunar Rails, Blink, etc. *"Bank here, account here."* Single partnership announcement covers both products.
- **Wedge #5 (BCE donations)**: 1,000-license donation program (Jan 17 meeting) bundles OrangeRails self-host free for nonprofit Bitcoin orgs + Bitcoin Circular Economy members.

### 7.7 Positioning — tagline options

Candidates, in preference order:
1. **"OrangeRails — the open-source, zero-knowledge alternative to Plaid. Built for Bitcoin."** ← recommended hero
2. **"OrangeRails: the rails every Bitcoin business runs on."** ← strong alternative, infrastructure-forward
3. **"Ship your Bitcoin data on OrangeRails."** ← verb-forward, active
4. **"Plaid was built on your data. OrangeRails can't read yours."** ← direct Plaid comparison
5. **"One connection. Every Bitcoin bank. Nobody — not even us — sees your data."** ← privacy-forward
6. **"OrangeRails — Bitcoin's integration layer. Open source. Zero knowledge."**

**Short forms** (for app copy, tweets, logos):
- *"OrangeRails. Built for Bitcoin."*
- *"OrangeRails — the zero-knowledge bridge to the Bitcoin ecosystem."* (acknowledges the family alongside Orange Bridge)
- *"Rails for Bitcoin."*

Recommend #1 for the landing hero — direct Plaid comparison + clear differentiator + "Built for Bitcoin" signals focus without excluding the accounting-grade + ZKA differentiators.

---

## 8. MVP Scope & Build Sequence

### 8.1 MVP definition (V0.1)

**Goal:** ship the *smallest* Connector that proves the architecture and gives BitBooks demo-ready data flow.

Deliverables:
- [ ] Core framework: adapter interface, orchestrator, normalizer
- [ ] 4 Tier-0 adapters: CSV, Lunar Rails (rates), bwt/xpub, BTCPay
- [ ] REST consumer API (list accounts, list transactions, trigger sync)
- [ ] Webhook receiver
- [ ] Journal-entry hinter (basic rules per provider type)
- [ ] Exchange-rate oracle with minute-precision, provider-tagged
- [ ] Docker Compose deployment
- [ ] GitHub OSS release, Apache 2.0 license
- [ ] Landing page at `orangerails.com`

### 8.2 V1 (first paying customers)

- Add Tier 1 adapters: Blink, Kraken, River, Lunar Rails banking, mining pools (Ocean + Braiins)
- orangerails.com SaaS — signup, Stripe billing, tenant isolation, auto-sync scheduling
- Adapter plugin marketplace
- QuickBooks plugin (Trojan horse)

### 8.3 V2 (write-back)

- Payment initiation (BTCPay, Blink, Lunar Rails)
- Invoice lifecycle handling (create → paid → reconcile)
- Multi-sig approval workflows

### 8.4 V3 (open spec)

- Publish `orangerails-spec v1.0`
- Reference server implementation (what partners host)
- Partner onboarding program
- Spec governance (RFCs, versioning, etc.)

### 8.5 12-week sequence (proposed)

| Week | Milestone |
|---|---|
| 1 | Repo + framework + adapter interface + Docker skeleton |
| 2 | CSV + Lunar Rails exchange-rate adapter |
| 3 | bwt/xpub adapter (watch-only on-chain) |
| 4 | BTCPay webhook adapter |
| 5 | Normalization engine + journal-entry hinter |
| 6 | Consumer REST API + BitBooks integration end-to-end |
| 7 | MVP release (OSS) + landing page live |
| 8 | Blink adapter |
| 9 | Kraken adapter |
| 10 | Mining pool adapter (Ocean) |
| 11 | QuickBooks plugin (read-only, Trojan horse prototype) |
| 12 | SaaS MVP live at orangerails.com |

---

## 9. Architectural Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Provider API breaking changes | Adapter breaks silently | Adapter test suite with recorded fixtures + contract tests; circuit breaker; health monitoring |
| Credential compromise | Customer funds / data exposed | Per-tenant encryption at rest; read-only API keys where possible; audit trail; rotate support |
| Dedup failure (double-counting) | Accounting integrity breach | Strict `(provider, external_id)` uniqueness; idempotent ingest; reconciliation reports |
| Exchange rate mismatch | Audit failures | Minute-precision capture, provider tag, immutable records, fallback chain (Lunar Rails → Kraken → Coinbase) |
| Rate limiting (provider APIs) | Missed txns, delayed sync | Backoff + queue; cursor-based pagination; user-visible sync status |
| Self-host security posture weaker than SaaS | Customer data at risk | Secure defaults; Docker image hardening; documented threat model; discourage exposure to public internet without reverse proxy + auth |
| Write-back (V2) regulatory exposure | MTL / money-transmitter risk | Structure payments as partner-initiated (Lunar Rails, BTCPay), not BitBooks-held; legal review before V2 |
| OSS commoditization | Someone forks + runs a free SaaS | Dual-license option OR hosted SaaS features (multi-tenant, SSO, auto-upgrade) drive the paid tier |

---

## 10. Open Questions (For Roark / Team)

1. **Brand approval**: Roark to approve the rename from "Bitcoin Connector" to **OrangeRails** (decision made in SESSION 2026-04-17-DUNE based on availability research; Roark's original naming preference should be formally updated).
2. **Domain**: register `orangerails.com`, `orangerails.io`, `orangerails.dev`, `orangerails.xyz`. Availability check pending.
3. **Trademark**: USPTO search for "OrangeRails" in Class 9 (software) and Class 42 (SaaS services). Check for Orange Bridge trademark conflict since both share "Orange" prefix.
4. **License**: Apache 2.0 (recommended — Bitcoin OSS community standard) vs MIT vs dual-license. Affects forkability and revenue defense.
5. **Adapter curation**: do we accept community-contributed adapters, or gate them (quality/security/legal)? Recommend: accept with review + optional "verified" badge.
6. **Write-back liability**: which jurisdictions require licenses when initiating payments? Legal review needed before V2.
7. **Partner-first adapters**: should Lunar Rails' adapter be written by us or by Lunar Rails? Both valid — Mar 23 call suggests we'll do Phase 1, they may contribute later.
8. **QuickBooks plugin timing**: Jeff Booth suggested this as a wedge. Do we ship it in V1 (week 11) or delay to V2? It accelerates adoption but splits focus from BitBooks core.
9. **Pricing validation**: the hybrid model (Section 7.3) locks structure. Numbers still need waitlist-signal validation. A/B test $10/$15/$25 (Personal), $79/$99/$129 (Prosumer), $39/$49/$79 (Team) before hardcoding.
10. **Relationship to BitBooks' ZKA**: is OrangeRails ZKA-aware (split connector), or does ZKA logic live in BitBooks and OrangeRails just emits standard data? Recommend: **OrangeRails stays standard**, ZKA is a concern of the consumer (BitBooks V3 handles its own split-connector pattern on top).
11. **Orange family strategy**: if OrangeRails succeeds, does the Orange brand become its own umbrella (orangehq.com) with BitBooks as one member and Orange Bridge + OrangeRails as siblings? Or does BitBooks remain the umbrella with Orange family as a product line within it? Affects long-term brand architecture.

---

## 11. References

### 11.1 Internal (BitBooks research)
- `/home/claude/bitbooks/galoy-cala/ZKA/16-ZKA-API-Connectors.md` — split-connector + pending-inbox architecture
- `/home/claude/bitbooks/galoy-cala/BitBooks-Backend-PRD-Addendum.md` — connector_configs schema, provider matrix, Lunar Rails 3-phase plan
- `/home/claude/bitbooks/galoy-cala/BitBooks-Roadmap-Gaps.md` — build sequence + feature tiers
- `/home/claude/bitbooks/galoy-cala/Lovable-09-Integrations.md` — V3 frontend connector UI
- `/home/claude/bitbooks/galoy-cala/Lovable-08-Bitcoin-Features.md` — CSV import, exchange rate bar, smart txn categorization

### 11.2 Transcripts (Roark's voice)
- `2026-03-23_call-with-tom-benner-roark-janis-kevin_raw.md` — Plaid comparison, open API spec, read/write phases
- `2026-01-17_medellin-jeff-booth_raw.md` — OSS + commercialized dual model, Trojan-horse thesis
- `2026-03-03_cut-sycn-oss_raw.md` — single API, open source plan
- `2026-02-18_bitbooks-pricing_raw.md` — separate-entity architecture, competitor observation
- `2026-02-10_pricing_raw.md` — Plaid/Finicity reference for banking
- `2026-02-16_product-review_raw.md` — Ashar Khan confirming integration credentials live in OrangeRails

### 11.3 External OSS
- [Galoy / Blink](https://github.com/GaloyMoney/blink) — Apache 2.0 Bitcoin banking
- [BTCPay Server Greenfield API](https://docs.btcpayserver.org/API/Greenfield/v1/) — merchant payments
- [bwt](https://github.com/bwt-dev/bwt) — xpub descriptor tracker
- [mempool.space / Esplora](https://mempool.space) — on-chain explorer
- [LND gRPC](https://lightning.engineering/api-docs/api/lnd/) + [Faraday](https://github.com/lightninglabs/faraday) — Lightning node + accounting
- [LDK](https://lightningdevkit.org) — Lightning library (WASM potential)
- [Clams](https://clams.tech) — LND accounting reference
- [Braiins Pool API](https://braiins.com/pool), [Ocean](https://ocean.xyz) — mining pools

### 11.4 Market context
- [Mesh Connect](https://www.meshconnect.com) — closed-source crypto payments aggregator (300+ platforms)
- [Vezgo](https://vezgo.com) — closed-source crypto data aggregator (40 CEXes, 20 blockchains)
- [Plaid Crypto / Wallet Onboard](https://plaid.com/use-cases/crypto/) — onboarding only, no aggregation
- [Koinly](https://koinly.io) — crypto tax software, 800+ exchanges, closed-source

---

## 12. Next Steps

**Immediate (this week):**
1. the maintainer + Roark: review this plan. Confirm scope, naming, and whether OrangeRails is V0.1 priority or deferred behind BitBooks V3 core.
2. Confirm `orangerails.com` registration status.
3. Align on license (Apache 2.0 recommended).

**Next session:**
4. Create `BitBooks-Bitcoin-Connector-SPEC-v0.md` — formal API spec draft.
5. Scaffold `orangerails/core` GitHub repo (org `orangerails`, repo `core`) with adapter interface + CSV adapter as reference.
6. Lunar Rails: deliver the integration diagram the maintainer committed to on Mar 23.

**Dependencies:**
- BitBooks V3 (ZKA Level 2) — Connector consumed by V3; they evolve in parallel but Connector is decoupled enough to ship standalone.
- Team capacity: this is a **separate product**, not an extension of BitBooks. Needs its own build plan and potentially its own dev track (if Daenon stays on V2/V3, Connector may be the maintainer + contractors).
