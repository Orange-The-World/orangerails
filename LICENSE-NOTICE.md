# License Notice

This repository ships under the **Apache License 2.0** (see `LICENSE`).

One vendored Rust crate carries a different license. This notice is here so that anyone reusing the code can make a clear-headed decision before linking against it.

## `crates/or-bip158-wasm/` is AGPL-3.0-or-later

The crate at `crates/or-bip158-wasm/` is a thin WebAssembly wrapper around `rust-bitcoin`'s [BIP 158](https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki) compact-block-filter implementation. We use it inside Stealth Sync to match block filters in the browser without leaking the user's xpub or address set.

The crate's `Cargo.toml` declares:

```toml
license = "AGPL-3.0-or-later"
```

This is the GNU Affero General Public License, version 3 or later. The AGPL is a strong copyleft license, more permissive of distribution and modification than commercial proprietary licenses, but it requires source code disclosure for network-accessible deployments.

## Why the split

The rest of this repository is Apache 2.0 because we want third-party integrators (commercial Bitcoin businesses, accounting platforms, payment processors) to use Orange Rails without copyleft obligations. Apache 2.0 is the de-facto license for Bitcoin infrastructure (Bitcoin Core's MIT, BTCPay Server's MIT, LND's MIT, BDK's Apache 2.0) and we follow that convention.

The BIP 158 matcher is the one piece of code where wallet-correctness is the gating concern. Sparrow Wallet and Wasabi Wallet both use `rust-bitcoin`'s `bip158` module for the same reason: it is battle-tested. Compiling our own thin shim to WebAssembly and shipping it AGPL is a deliberate choice. It lets us inherit the correctness work without forking, and the AGPL on this one component is intentionally permissive of network deployments where the source is published (which is exactly what an open-source aggregator does).

## What this means for you

**If you are deploying Orange Rails as a network service:**
- The Apache 2.0 majority of the code has no copyleft obligation.
- The AGPL-licensed BIP 158 matcher requires that you make the corresponding source code available to users of the network service. Since this repository is already public, that obligation is satisfied as long as your fork (if any) is also public.

**If you are linking the BIP 158 matcher into a commercial application that you do not want to AGPL:**
- Do not link `crates/or-bip158-wasm/` directly. Instead, run Stealth Sync as a separate service over HTTP (the architecture supports this) and call into it across a network boundary. AGPL does not impose copyleft on consumers of a network service, only on its source code.
- Alternatively, replace the matcher with your own implementation. The crate is small and the BIP 158 spec is public.

**If you are an academic, security researcher, or hobbyist:**
- AGPL is welcoming to your use case. Read it, learn from it, fork it, publish improvements upstream.

## Other vendored components

Per the spirit of Apache 2.0's NOTICE file convention, future vendored code with licenses other than Apache 2.0 should be listed here. As of the v0.1 baseline, the BIP 158 crate is the only divergence.
