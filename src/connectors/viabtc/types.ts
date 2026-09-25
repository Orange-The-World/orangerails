/**
 * Orange Rails, ViaBTC pool connector type surface.
 *
 * Paths and field names are from the ViaBTC wiki (cloned 2026-09-15):
 * https://github.com/viabtc/viapool_api/wiki
 */

import type { StagedImportPayload } from "../contract";

export const VIABTC_SOURCE_TAG = "viabtc.api.v1";
export const VIABTC_API_BASE = "https://www.viabtc.net/res/openapi/v1";
export const VIABTC_REWARD_COINS = ["NMC", "DOGE", "SYS", "ELA"] as const;
export const VIABTC_AUTH_CODES = new Set([12001, 12002, 12003, 12004]);

export type ViaBtcCredentials = {
  apiKey: string;
  secretKey: string;
};

export type ViaBtcPaymentRow = {
  id: number;
  coin: string;
  amount: string;
  address: string;
  tx: string;
  create_time: number;
};

export type ViaBtcProfitRow = {
  coin: string;
  date: string;
  pplns_profit?: string;
  pps_profit?: string;
  solo_profit?: string;
  total_profit: string;
};

export type ViaBtcHistory = {
  payments: ViaBtcPaymentRow[];
  profits: ViaBtcProfitRow[];
  rewards: ViaBtcProfitRow[];
};

export class ViaBtcAuthError extends Error {
  readonly viabtcCode?: number;
  constructor(message: string, viabtcCode?: number) {
    super(message);
    this.name = "ViaBtcAuthError";
    this.viabtcCode = viabtcCode;
  }
}

export class ViaBtcApiError extends Error {
  readonly viabtcCode?: number;
  constructor(message: string, viabtcCode?: number) {
    super(message);
    this.name = "ViaBtcApiError";
    this.viabtcCode = viabtcCode;
  }
}

export type IngestViaBtcOptions = {
  apiKey: string;
  secretKey: string;
  since?: string;
  until?: string;
  orgHint?: { name?: string; currency?: string };
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  baseUrl?: string;
};

export type IngestViaBtcResult = {
  payload: StagedImportPayload;
  pathUsed: "api";
  warnings: string[];
  history: ViaBtcHistory;
};
