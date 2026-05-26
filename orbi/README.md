# ORBI — Orange Rails Bitcoin Index

The open, audit-grade Bitcoin reference rate computed by Orange Rails. Volume-weighted median across regulated venues. Methodology open. Calculation code open. Every input candle in a public audit log. Free for the Bitcoin community.

## What this folder contains

This is the implementation of ORBI inside the `orangerails` monorepo. The methodology, growth phases, procurement, and risk-management strategy live in the [Orange Rails wiki](https://wiki.abascal.ca/doc/orbi-orange-rails-bitcoin-index-cTosEw5yaA). This folder is the code.

```
orbi/
├── README.md                  # this file
├── LICENSE                    # MIT — ORBI's calculation code is open source
├── methodology.md             # short overview + link to full wiki doc
├── schema/                    # database DDL (Orange Rails Supabase Postgres)
│   ├── 001_create_tables.sql  # exchange_rates, exchange_rate_resolutions, exchange_rate_providers
│   └── 002_seed_providers.sql # initial provider registry seed
├── src/
│   ├── sources/               # source plug-in framework
│   │   ├── types.ts           # Candle, Pair, HealthStatus
│   │   ├── interface.ts       # Source interface — all sources implement this
│   │   ├── kraken.ts          # Kraken source plug-in (Phase 0 first)
│   │   ├── bitstamp.ts        # (Phase 0 week 1)
│   │   ├── bitfinex.ts        # (Phase 0 week 1)
│   │   ├── mempool-space.ts   # (Phase 0 week 1)
│   │   ├── bitso.ts           # (Phase 0 week 2)
│   │   └── mercado-bitcoin.ts # (Phase 0 week 2)
│   ├── calculate/             # the VW-median algorithm
│   │   ├── vw-median.ts       # core
│   │   └── partition.ts       # 5-min partitioning for ORBI-D
│   └── edge-functions/        # Supabase Edge Function implementations
│       ├── or-rate-resolve/   # hot path
│       ├── or-rate-history/   # historical lookup
│       ├── or-rate-retry/     # PENDING recovery
│       └── or-rate-health/    # system status
└── tests/                     # vitest tests; worked examples reproducible by anyone
```

## Quickstart for contributors

```bash
cd orbi
bun install
bun test
```

## Source plug-in pattern (non-negotiable architecture)

Every data source implements the `Source` interface in `src/sources/interface.ts`. Activation is config-driven via the `exchange_rate_providers` table's `active` column. Adding/removing/disabling a source is a config flag, not a code change. This is the engineering bedrock of ORBI's [Hybrid Asymmetric Risk-Management Strategy](https://wiki.abascal.ca/doc/orbi-hybrid-asymmetric-risk-management-strategy-2AVKLwrxlF).

## Methodology in one paragraph

ORBI computes a volume-weighted median across 1-minute OHLC closes from a panel of regulated exchanges. ORBI-M publishes per-minute; ORBI-D publishes a daily fixing (5-min × 12 partitions, VW-median per partition, equal-weight cross-partition) with mechanics deliberately identical to CME CF BRR-NY. Every input candle is stored in a public audit log so anyone can reproduce any published rate from the original sources.

Full methodology: https://wiki.abascal.ca/doc/orbi-methodology-white-paper-d01sSwWofx

## Source panel at launch (Phase 1)

| Source | Pairs | Status |
|--------|-------|--------|
| Kraken | USD, EUR, GBP, CAD, AUD, JPY, CHF, USDT, USDC | ✅ Active |
| Bitstamp | USD, EUR, GBP | ✅ Active |
| Bitfinex | USD | ✅ Active |
| mempool.space | USD, EUR, GBP, CAD, CHF, AUD, JPY | ✅ Active |
| Bitso | MXN, BRL, ARS, USD, USDT | ✅ Active |
| Mercado Bitcoin | BRL, USDT, USDC | ✅ Active |
| Frankfurter (fiat-cross) | ~30 fiat pairs via ECB | ✅ Active |

Coverage matrix: https://wiki.abascal.ca/doc/orbi-coverage-matrix-lhqwp1bJ7j

## License

The `orbi/` folder is MIT-licensed (see `LICENSE`). The rest of the `orangerails` repo retains its own license.

Anyone may fork ORBI's calculation code, run it on their own data, and reproduce any rate ORBI publishes. The methodology and code are public goods.
