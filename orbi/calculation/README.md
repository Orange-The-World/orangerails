# ORBI calculation

This folder holds the code that computes every ORBI minute rate (ORBI-M): the
volume-weighted median across sources, and the composite rule for currencies
that no source quotes directly. It is copied from the ORBI engine so that anyone
can read and re-run the exact math behind a published rate.

| File | What it does |
|---|---|
| `calculate/vw-median.ts` | Drops zero-volume candles, sorts by close, returns the close where cumulative volume first reaches half of the total. |
| `calculate/resolve.ts` | Picks each source's candle for the target minute (exact minute first, otherwise up to 5 minutes older), runs the median, assigns the tier (A: 3+ sources, B: 2, B-single: 1) and builds the audit record. |
| `calculate/resolve-composite.ts` | Composite tier: BTC/X = BTC/USD ORBI x USD/X cross-rate. |
| `sources/interface.ts`, `sources/types.ts` | The shapes the calculation reads. |

Source connectors (the code that downloads candles from each venue) are not
published here. Which sources feed a rate is recorded per rate in its audit
record.

## Reproducing a published rate

Every minute rate published since late May 2026 has an audit record holding
each source's candles, which sources failed and why, and the median walk.
Take each source's candle for the rate's minute from that record and pass the
list to `vwMedian()`; the result equals the published rate.

The audit record is not yet returned by the public API. Until it is, ask
Orange Rails for the record of any rate by pair and timestamp.

Licence: Apache-2.0, as for the rest of this repository.
