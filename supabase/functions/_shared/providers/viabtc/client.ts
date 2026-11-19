/**
 * ViaBTC pool OpenAPI client.
 *
 * Base URL and paths are from the wiki (cloned 2026-09-15):
 *   GET /account/sub                 signature required (auth probe)
 *   GET /account                     account + balances + payout addresses
 *   GET /profit                      profit summary
 *   GET /profit/history              daily pool credits (mining_earning)
 *   GET /reward/history              merge-mined credits (mining_earning)
 *   GET /wallet/payment/history      on-chain payouts (mining_payout)
 *
 * Every request is signed (tonce + HMAC-SHA256) even on endpoints the wiki
 * marks "Signature Required: No", so a wrong secret or a stale tonce fails
 * closed instead of looking like an empty history. Auth codes 12001-12004
 * throw ViaBtcAuthError; they never return an empty list.
 */

import { buildQueryString, hmacSha256Hex } from "./sign.ts";
import {
  VIABTC_API_BASE,
  VIABTC_AUTH_CODES,
  ViaBtcApiError,
  ViaBtcAuthError,
  type ViaBtcAccountInfo,
  type ViaBtcCredentials,
  type ViaBtcEnvelope,
  type ViaBtcPaymentRow,
  type ViaBtcProfitRow,
} from "./types.ts";

const PAGE_LIMIT = 50;
const MAX_PAGES = 200;
const USER_AGENT = "OrangeRails/1.0 (+https://orangerails.com; viabtc-adapter)";

export type ViaBtcClientOptions = {
  credentials: ViaBtcCredentials;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type Page<T> = { items: T[]; hasNext: boolean };

function authMessage(code: number | undefined, message: string | undefined, httpStatus?: number): string {
  // "unauthorized" is load-bearing: classifyUpstreamError maps it to
  // UPSTREAM_AUTH_FAILED. Do not drop it from 12003 (invalid tonce).
  const bits = ["[viabtc] authentication failed: unauthorized"];
  if (code === 12001) bits.push("invalid api key");
  else if (code === 12002) bits.push("signature invalid");
  else if (code === 12003) bits.push("stale or invalid tonce");
  else if (code === 12004) bits.push("IP not allowed (forbidden)");
  if (httpStatus) bits.push(`(HTTP ${httpStatus})`);
  if (message) bits.push(message.slice(0, 120));
  return bits.join(": ");
}

function throwForEnvelope(env: ViaBtcEnvelope, httpStatus?: number): never {
  if (VIABTC_AUTH_CODES.has(env.code)) {
    throw new ViaBtcAuthError(authMessage(env.code, env.message, httpStatus), env.code);
  }
  throw new ViaBtcApiError(
    `[viabtc] API error code ${env.code}${env.message ? `: ${env.message.slice(0, 120)}` : ""}`,
    env.code,
  );
}

function extractPage<T>(env: ViaBtcEnvelope): Page<T> {
  const data = env.data;
  if (Array.isArray(data)) {
    return { items: data as T[], hasNext: Boolean(env.has_next) };
  }
  if (data && typeof data === "object") {
    const inner = data as { data?: unknown; has_next?: boolean };
    if (Array.isArray(inner.data)) {
      return { items: inner.data as T[], hasNext: Boolean(inner.has_next) };
    }
  }
  return { items: [], hasNext: false };
}

export class ViaBtcClient {
  private readonly creds: ViaBtcCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(opts: ViaBtcClientOptions) {
    this.creds = opts.credentials;
    this.baseUrl = (opts.baseUrl ?? VIABTC_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Signature-required probe. GET /account/sub is the wallet-group sibling
   * that the wiki marks Signature Required: Yes, so a wrong secret or a
   * stale tonce fails here instead of later looking like "no payouts".
   */
  async probeAuth(): Promise<void> {
    await this.getJson("/account/sub", {});
  }

  async fetchAccount(): Promise<ViaBtcAccountInfo> {
    const env = await this.getJson("/account", {});
    const data = env.data;
    if (!data || typeof data !== "object") {
      return {};
    }
    return data as ViaBtcAccountInfo;
  }

  async fetchProfitSummary(coin: string): Promise<ViaBtcProfitRow | null> {
    const env = await this.getJson("/profit", { coin });
    const data = env.data;
    if (!data || typeof data !== "object") return null;
    const row = data as ViaBtcProfitRow;
    if (typeof row.coin !== "string" || typeof row.total_profit !== "string") return null;
    return row;
  }

  async fetchPaymentHistory(opts: {
    coin: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ViaBtcPaymentRow[]> {
    return this.paginate<ViaBtcPaymentRow>("/wallet/payment/history", {
      coin: opts.coin,
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
      utc: true,
    });
  }

  async fetchProfitHistory(opts: {
    coin: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ViaBtcProfitRow[]> {
    return this.paginate<ViaBtcProfitRow>("/profit/history", {
      coin: opts.coin,
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
      utc: true,
    });
  }

  async fetchRewardHistory(opts: {
    coin: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ViaBtcProfitRow[]> {
    return this.paginate<ViaBtcProfitRow>("/reward/history", {
      coin: opts.coin,
      ...(opts.startDate ? { start_date: opts.startDate } : {}),
      ...(opts.endDate ? { end_date: opts.endDate } : {}),
    });
  }

  private async paginate<T>(path: string, baseParams: Record<string, string | number | boolean>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const env = await this.getJson(path, { ...baseParams, page, limit: PAGE_LIMIT });
      const { items, hasNext } = extractPage<T>(env);
      out.push(...items);
      if (!hasNext || items.length < PAGE_LIMIT) break;
    }
    return out;
  }

  private async getJson(
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<ViaBtcEnvelope> {
    const withTonce: Record<string, string | number | boolean> = {
      ...params,
      tonce: this.nowMs(),
    };
    const query = buildQueryString(withTonce);
    const signature = await hmacSha256Hex(this.creds.secret_key, query);
    const url = `${this.baseUrl}${path}?${query}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "X-API-KEY": this.creds.api_key,
          "X-SIGNATURE": signature,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      throw new ViaBtcApiError(`[viabtc] network error: ${(err as Error).message}`);
    }

    const rawText = await res.text().catch(() => "");
    let env: ViaBtcEnvelope | null = null;
    if (rawText) {
      try {
        env = JSON.parse(rawText) as ViaBtcEnvelope;
      } catch {
        env = null;
      }
    }

    if (env && typeof env.code === "number" && env.code !== 0) {
      throwForEnvelope(env, res.status);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ViaBtcAuthError(authMessage(undefined, undefined, res.status));
      }
      throw new ViaBtcApiError(`[viabtc] HTTP ${res.status} GET ${path}`);
    }

    if (!env || typeof env.code !== "number") {
      throw new ViaBtcApiError(`[viabtc] GET ${path} returned a non-JSON body`);
    }
    return env;
  }
}

/** Coins this account has actually used, from balances and payout addresses. */
export function coinsFromAccount(info: ViaBtcAccountInfo): string[] {
  const seen = new Set<string>();
  for (const row of info.balance ?? []) {
    if (row.coin) seen.add(row.coin.toUpperCase());
  }
  for (const row of info.withdraw_address ?? []) {
    if (row.coin) seen.add(row.coin.toUpperCase());
  }
  if (seen.size === 0) seen.add("BTC");
  return [...seen].sort();
}
