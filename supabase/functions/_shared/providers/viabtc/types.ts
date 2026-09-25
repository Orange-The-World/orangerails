/**
 * ViaBTC pool API shapes, taken from the wiki pages cloned 2026-09-15
 * (https://github.com/viabtc/viapool_api/wiki). Field names are ViaBTC's.
 */

export const VIABTC_SOURCE_TAG = "viabtc.api.v1";
export const VIABTC_API_BASE = "https://www.viabtc.net/res/openapi/v1";

/** Merge-mined coins that Acquire Reward History documents as valid `coin` values. */
export const VIABTC_REWARD_COINS = ["NMC", "DOGE", "SYS", "ELA"] as const;

export interface ViaBtcCredentials {
  api_key: string;
  secret_key: string;
}

/** Wiki error codes that mean the credential or the signature was refused. */
export const VIABTC_AUTH_CODES = new Set([
  12001, // Invalid API key
  12002, // Signature error
  12003, // Invalid tonce
  12004, // IP not allowed
]);

/**
 * Auth failure that must never be rendered as an empty result.
 *
 * `upstreamCode` is what or-discover-wallets reads to pick HTTP status and
 * catalog copy. The message is shaped so classifyUpstreamError maps it to
 * UPSTREAM_AUTH_FAILED even if the property is stripped.
 */
export class ViaBtcAuthError extends Error {
  readonly upstreamCode = "UPSTREAM_AUTH_FAILED";
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

export type ViaBtcEnvelope = {
  code: number;
  message?: string;
  data?: unknown;
  count?: number;
  curr_page?: number;
  has_next?: boolean;
  total?: number;
  total_page?: number;
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

export type ViaBtcAccountInfo = {
  account?: {
    id?: number | string;
    account?: string;
  };
  withdraw_address?: Array<{ coin: string; address: string }>;
  balance?: Array<{ coin: string; amount: string }>;
};

export function parseViaBtcCredentials(c: Record<string, unknown>): ViaBtcCredentials {
  const api_key = c.api_key;
  const secret_key = c.secret_key;
  if (typeof api_key !== "string" || !api_key.trim()) {
    throw new Error("[viabtc] credentials.api_key required");
  }
  if (typeof secret_key !== "string" || !secret_key.trim()) {
    throw new Error("[viabtc] credentials.secret_key required");
  }
  return { api_key: api_key.trim(), secret_key: secret_key.trim() };
}
