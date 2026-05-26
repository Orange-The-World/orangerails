# ORBI Methodology — Short Reference

*The full methodology document, with worked examples, prior art, ToS findings, and operational commitments, lives at https://wiki.abascal.ca/doc/orbi-methodology-white-paper-d01sSwWofx. This file is a code-side mirror of the essential math.*

## The algorithm in four steps

### 1. Anchor the timestamp

For each transaction needing a rate, the timestamp `T` is the reference point. For on-chain Bitcoin transactions: the block timestamp. For Lightning: wallet-reported timestamp. For non-Bitcoin sources: user-entered date.

### 2. Find the 1-minute partition ending just before T

For ORBI-M, we want the candle ending at `floor(T to minute)`. Example: block mined at 14:35:21 → use the 14:34:00–14:35:00 candle.

### 3. Pull OHLC from every active source

In parallel, with a 3-second timeout each. Each source's plug-in handles its own endpoint format. Failures are logged but do not break the calculation; we proceed with surviving sources.

### 4. Volume-weighted median

Sort candles by close price. Walk cumulative volume. The price where cumulative volume crosses 50% of total volume is the VW-median. Zero-volume candles are dropped before the calculation.

```
function vwMedian(candles):
  valid = candles where volume > 0
  sort valid by close ascending
  total_volume = sum of volumes
  half = total_volume / 2
  cumulative = 0
  for each candle in sorted valid:
    cumulative += candle.volume
    if cumulative >= half:
      return candle.close
```

## ORBI-M vs ORBI-D

| Product | Window | Per-partition statistic | Cross-partition aggregation | Frequency |
|---------|--------|--------------------------|------------------------------|-----------|
| ORBI-M  | 1 minute | VW-median across sources' 1-min closes | n/a (single partition) | Every minute |
| ORBI-D  | 1 hour ending 16:00 New York | VW-median per 5-min partition × 12 | Equal-weighted average of the 12 partition medians | Once daily |

ORBI-D mechanics are deliberately identical to CME CF Benchmarks' BRR-NY for the credibility positioning.

## Why VW-median, not VW-mean

Volume-weighted median is manipulation-resistant. A single bad print on one venue cannot drag the median unless that venue represents more than 50% of trading volume in the partition — which is implausible across a panel of regulated exchanges. The same property is used by CME CF, Kaiko Reference Rates, Coin Metrics CMBI, and Nasdaq NQBTC.

## Tier classification per pair

Every published rate carries its tier in the audit log:

- **A** — 3+ direct sources quote the pair natively
- **B** — 1-2 direct sources quote the pair natively
- **C** — composite via `BTC↔USD ORBI × USD↔fiat from ECB`

The full coverage matrix is at https://wiki.abascal.ca/doc/orbi-coverage-matrix-lhqwp1bJ7j.

## Reproducibility commitment

Every rate ORBI publishes can be reproduced by anyone:

1. Pull the audit log entry from `exchange_rate_resolutions` (linked via `rate.id` → `resolution.rate_id`)
2. Re-run `vwMedian()` with the stored input candles
3. Verify the result matches the published rate

Anyone can fork the calculation code and run it on their own data — that's the public-goods commitment.
