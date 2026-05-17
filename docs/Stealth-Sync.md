# Stealth Sync — Architecture Overview

**Audience:** developers integrating Stealth Sync into their own SaaS, BitBooks engineers maintaining the system, security researchers auditing the design.
**Status:** developer reference. Source of truth for the build is `STEALTH-SYNC-MASTER-PLAN.md` v0.4.

---

## TL;DR

Stealth Sync delivers the [BIP 157 / BIP 158](https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki) compact block filter sync model in a browser, packaged as a drop-in web widget. Sparrow Wallet and Wasabi Wallet provide the same privacy guarantees in desktop apps; Stealth Sync provides them as a service that any SaaS can integrate via a documented `postMessage` protocol.

The customer's xpub never leaves the browser. The Orange Rails server holds a sealed envelope it cannot open. Filter files come from a CDN with no auth and no logs. Block-fetches go to our own Bitcoin Core node, not a third party.

## How it compares to existing wallet sync architectures

| Architecture | Where addresses are derived | What the server sees | Privacy posture |
|---|---|---|---|
| **Stealth Sync** | Browser | Sealed bytes only; cannot decrypt | Strong. Match Sparrow / Wasabi default |
| **Sparrow Wallet** (default) | Desktop app | Public block source sees address-level data unless user runs own node | Strong with own node; medium with public Esplora |
| **Wasabi Wallet** | Desktop app | Wasabi's coordinator sees no addresses (BIP 158 client-side) | Strong; same model as Stealth Sync |
| **LND Neutrino mode** | Lightning node | Public peers see partial address info | Strong; designed for mobile Lightning |
| **Server-side xpub adapter** (the previous OR implementation) | Server | Server holds xpub; queries public block explorer with all addresses grouped | Weak. The structural problem Stealth Sync replaces |
| **Electrum personal server** | Personal server | None; the user runs the indexer | Strong; requires self-hosting |
| **Public Electrum servers** | Server | Server sees all addresses for the wallet | Weak |
| **Plaid / MX bank connectors** | Aggregator's servers | Plaintext bank credentials and transactions on aggregator's servers | Weak by structural necessity |
| **Mempool.space xpub view** | Public website | Mempool.space sees the xpub and all derived addresses | Weak; convenience tool, not privacy tool |

## Three subdomains, three jobs

```
┌────────────────────────────┐
│  Customer's browser        │
│  (in a popup window)       │
└────────────┬───────────────┘
             │
   postMessage with INIT
             │
             ▼
┌────────────────────────────┐
│  connect.orangerails.com   │  ← The widget host
│  Static HTML/JS/WASM       │     Where the math runs
│  Loaded in popup           │     CSP locked, logged
└────────────┬───────────────┘
             │
   ┌─────────┴─────────────────┐
   │                           │
   ▼                           ▼
┌──────────────────────┐  ┌──────────────────────┐
│ stealth.orangerails  │  │ blocks.orangerails   │
│ Public filter CDN    │  │ Bitcoin block lookup │
│ One file per block   │  │ Reads our Core node  │
│ No auth, no logs     │  │ Raw block bytes      │
└──────────────────────┘  └──────────────────────┘
             │                           │
             │  Sealed envelopes + sealed transactions
             ▼                           ▼
┌────────────────────────────┐
│  db.orangerails.com        │  ← Existing OR Supabase
│  Sealed bytes only         │     Cannot decrypt anything
│  RLS policies enforce      │     Stealth Sync customer's
│  per-app-user access       │     view
└────────────────────────────┘
             │
   postMessage SYNC_COMPLETE with sealed_transactions[]
             │
             ▼
┌────────────────────────────┐
│  Consuming app             │  V2, V3, Orange Way,
│  (browser tab)             │  any third-party SaaS
└────────────────────────────┘
```

## The keystone: per-app vault key, never on our server

Each consuming app derives an OR-scoped key locally:

```
or_stealth_key = HKDF-SHA256(input = app_MEK, salt = "", info = "or-stealth-v1", length = 32)
```

This key is sent via cross-window `postMessage` to the OR Connect widget popup. The widget uses it to seal envelopes (xpubs, descriptors) and to seal transactions. The key never appears in any HTTP request to `*.orangerails.com`. The orangerails.com server cannot intercept a `postMessage` between two browser windows.

When the widget needs to make a network request (fetch filters, fetch a block, store a sealed envelope), it does so without including the key. The server gets opaque bytes only.

## The cross-domain `postMessage` protocol

Documented in `src/stealth/lib/postmessage.ts` in the orangerails repo. Stable surface for third-party integration. Versioned via `protocol_version` field; bumping it is the migration mechanism.

**App → Widget:** one message type, `OR_STEALTH_INIT`, carrying mode (add / sync / list / delete), the per-app key, and the consuming app's identity.

**Widget → App:** seven message types: `OR_STEALTH_READY`, `OR_STEALTH_PROGRESS` (with eight stages), `OR_STEALTH_ADD_COMPLETE`, `OR_STEALTH_SYNC_COMPLETE` (with sealed transactions array), `OR_STEALTH_LIST_RESULT`, `OR_STEALTH_DELETE_COMPLETE`, `OR_STEALTH_ERROR` (with eight error codes).

Origin checks: the widget validates that the parent window's origin is on an allowlist (the consuming app's domain) before accepting an INIT.

## Sealed envelope schema

The unit Orange Rails stores at rest:

```
SealedEnvelope:
  version: 1
  algorithm: AES-256-GCM
  iv_b64: 12 random bytes per encryption (base64)
  ciphertext_b64: includes auth tag (base64)
```

Plaintext (before encryption) is JSON:

```json
{
  "kind": "xpub_stealth",
  "xpub": "xpub6CUGRUonZSQ4...",
  "label": "Cold Storage",
  "wallet_birthday": "2021-01-15",
  "gap_limit": 20,
  "script_type": "p2wpkh"
}
```

Multisig is the same schema with `kind: "descriptor_stealth"` and a `descriptor` field instead of `xpub`. BIP 47 payment codes are reserved as a v2 extension.

Sealed transactions follow the same encryption scheme. Plaintext is the normalized transaction (txid, height, occurred_at, direction, amount_sats, address, memo, vin/vout count). Plaintext `occurred_at` and `block_height` are stored alongside the sealed bytes for indexed range queries; everything else is sealed.

A blind index (HMAC-SHA256 of the txid under the per-app key) allows server-side dedup without revealing the txid.

## Server-side platform binding (audit 2026-05-16)

Every row in `stealth_connections` is bound to a single platform via the `platform_id` foreign key. The binding is set at create time from the calling platform's verified API key (platform mode) or the special `direct` platform (consumer users on orangerails.com). Every read, write, and delete also filters by `platform_id = ctx.platformId`.

Why the binding exists: before this change, the table held `app_slug` (a caller-supplied text field) and `app_user_id`. Platform A's API key with a stolen `(connection_id, app_user_id)` pair could read, overwrite, or delete Platform B's connections. The sealed envelope itself stays recipient-encrypted so disclosure was mitigated, but the write/delete vector caused integrity loss and DoS. Binding to a real platform foreign key closes that hole.

`app_slug` is kept as a UX field (which app group a connection belongs to, useful for the picker UI) but is no longer trusted for authentication.

## Threat model

What each party can and cannot see during a typical sync:

| Party | Sees | Cannot see |
|---|---|---|
| Customer's browser | Vault password, MEK, derived key, xpub, addresses, balances, transactions | n/a |
| stealth.orangerails.com | IP, requested filter URLs, block-range pattern, sync timing, browser fingerprint | Xpub, addresses, balances, whether any filter matched |
| connect.orangerails.com | IP, popup load timing | Vault password, derived key, xpub, addresses, transactions (all live in popup browser memory only) |
| blocks.orangerails.com | IP, requested block hash | Which xpub triggered the request |
| db.orangerails.com | Sealed bytes, plaintext occurred_at, opaque uuids, sync timestamps | Xpub, addresses, balances, transaction details |
| Consuming app server (V2/V3/OW) | Sealed transaction records, opaque connection_id | Xpub, addresses, balances, transaction details |
| Network observer (ISP) | TLS-encrypted traffic to orangerails.com subdomains | Anything inside TLS |

Acceptable plaintext residue, named in the picker disclosure: IP at filter fetch, block-range fetched (hints at wallet birthday give-or-take a month), sync timing.

## Why we self-host the block source

When the filter scan finds a possible match, the browser needs to download that full block to confirm and read transactions. Sparrow's default is `blockstream.info`, a public Bitcoin block explorer. blockstream.info would see "this IP wants block X, Y, Z" with each match.

Stealth Sync runs that lookup against our own Bitcoin Core 28.1 node on bb-support, exposed at `blocks.orangerails.com`. No third party learns which blocks our customers are interested in. The only watcher is us; customers who do not trust us are not worse off, but a stranger is not in the loop.

Year-2 roadmap: BYO node URL field for the most paranoid customers, plus optional Tor mode for filter downloads.

## The Bitcoin Core node

- Bitcoin Core 28.1 (`/Satoshi:28.1.0/`) on bb-support.
- Config: `txindex=1`, `blockfilterindex=1`, `peerblockfilters=1`. The block filter index is what the filter producer reads to generate per-block fingerprint files.
- Storage: ~840 GB on disk for the full chain.
- Sync state: tip-following via systemd unit, 40+ peers, IBD complete.
- RPC localhost-only (`127.0.0.1:8332`); no public RPC. The block source endpoint at `blocks.orangerails.com` is a small Bun service that proxies authenticated RPC calls for read-only methods (`getblock`, `getblockheader`, `getbestblockhash`).

## The filter producer worker

Runs on bb-support at `/opt/bb-support/btc-filter-worker/`. Subscribes to Bitcoin Core's ZMQ feed for new blocks (`tcp://127.0.0.1:28332`), calls `bitcoin-cli getblockfilter <hash> basic` per new block, gzips the filter, writes to disk at `/var/lib/btc-filter-worker/<height>.gcs.gz`. Caddy serves the directory at `stealth.orangerails.com` with no logging and aggressive caching.

Memory footprint: ~100 MB peak. CPU: minimal except during initial backfill.

## What changes for consuming apps

A consuming app that wants Stealth Sync only needs to:

1. Open a popup at `https://connect.orangerails.com/connect?mode=...`
2. Listen for `OR_STEALTH_READY`
3. Send `OR_STEALTH_INIT` with the per-app key derived locally
4. Render progress and final state from the messages flowing back

No server-side code is required. No Bitcoin libraries are required. The widget owns the entire sync pipeline. The consuming app stores sealed transactions if it wants to and decrypts them client-side under its own MEK.

This is why Stealth Sync can ship to BitBooks V2, V3, Orange Way, and arbitrary third-party SaaS without each one re-implementing the math.

## Why we did NOT use existing libraries directly

- **BDK WASM** (`@bitcoindevkit/bdk-wallet-web`): does not expose BIP 158 in its WASM target as of v0.3.0. Documented limitation: "Network access is limited to http(s)... only supports Esplora as blockchain client." We use rust-bitcoin's `bip158` module directly, compiled to WASM with `wasm-pack`. About 100 lines of Rust glue.
- **Pure-TypeScript `bip158` package**: drop-in but unaudited. We considered using it as a quick prototype and rejected the path; auditing risk on the matching code is the wallet's correctness gate. Wallet correctness bugs cause silent missed transactions, which are unacceptable.
- **rust-bitcoin's `bip158` module**: this is what Sparrow Wallet and Wasabi Wallet use internally. Battle-tested. Our WASM wrapper is a thin shim.

## Performance budget

- Wallet add: under 1 second after the user clicks Add.
- Wallet sync, recent activity (less than 1 day): 1 to 3 seconds.
- Wallet sync, 1-year history backfill: 5 to 15 seconds. Most filter download volume.
- Wallet sync, 5-year history backfill: 15 to 45 seconds. Edge case; most users will not see this.
- Browser memory: about 100 MB peak during sync.
- Bandwidth: about 50 MB per month going forward. A few hundred MB to a few GB for historical backfill depending on wallet birthday.

## Why this matters strategically

Bitcoin-native businesses do not want their bookkeeping data on Plaid's servers. Their wallets are sensitive. The traditional connector stack (Plaid, MX, Yodlee) cannot serve them and never will. Stealth Sync gives them a connector with the same convenience as a bank link and the same privacy as a desktop wallet.

The architecture is also re-usable. Lightning Network watchtowers, Nostr relay reads, and other "I want to know something about an address without telling anyone which address" use cases can all live under the same `stealth.*` brand. The compact block filter pattern generalizes.

## Further reading

- BIP 158 specification: https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki
- BIP 157 specification: https://github.com/bitcoin/bips/blob/master/bip-0157.mediawiki (the network protocol; Stealth Sync uses HTTPS instead but the filter format is identical)
- Sparrow Wallet's connection guide: https://sparrowwallet.com/docs/connecting-server.html
- Wasabi Wallet backend architecture: https://docs.wasabiwallet.io/why-wasabi/BackendArchitecture.html
- rust-bitcoin's `bip158` module: https://docs.rs/bitcoin/latest/bitcoin/bip158/
- The original BIP 157 motivation paper by Olaoluwa Osuntokun and Alex Akselrod
