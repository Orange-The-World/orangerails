/**
 * Core types for ORBI source plug-ins.
 *
 * Every source implementation imports from this file. Keeping types here
 * (separate from the Source interface) means consumer code can use the types
 * without pulling in the interface contract.
 */

/** A 1-minute OHLC bar from one source. */
export interface Candle {
  /** Start of the 1-minute window, UTC. */
  bucketTs: Date;
  open: number;
  high: number;
  low: number;
  /** Close price — this is what feeds the VW-median. */
  close: number;
  /** Volume in the source currency (typically BTC). Zero-volume candles are dropped from the median. */
  volume: number;
}

/** A canonical (source, target) pair representation. */
export interface Pair {
  /** e.g. 'BTC'. */
  source: string;
  /** e.g. 'USD'. */
  target: string;
}

/** ORBI's two products. */
export type Product = "ORBI-M" | "ORBI-D";

/** Granularity stored alongside rates. */
export type Granularity = "1m" | "1d";

/** Status reported by a source's health check. */
export interface HealthStatus {
  name: string;
  reachable: boolean;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastError?: string;
}

/** One source's response to a fetch attempt, including failure context. */
export interface SourceResponse {
  source: string;
  candles: Candle[];
  success: boolean;
  errorMessage?: string;
  fetchedAt: Date;
}

/** Tier classification of a published rate. */
export type Tier = "A" | "B" | "B-single" | "C-composite" | "stable";
