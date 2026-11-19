/**
 * ViaBTC pool API client (CLI / staged-import path).
 *
 * Mirrors supabase/functions/_shared/providers/viabtc/client.ts so a local
 * `bun run scripts/viabtc-convert.ts` run uses the same signing, the same
 * four wallet endpoints, and the same auth-vs-empty contract. The edge
 * adapter is what the widget/sync path uses; this file is the founder-box
 * converter that emits a StagedImportPayload.
 */

import { buildQueryString, hmacSha256Hex } from "./sign";
import {
  VIABTC_API_BASE,
  VIABTC_AUTH_CODES,
  VIABTC_REWARD_COINS,
  ViaBtcApiError,
  ViaBtcAuthError,
  type ViaBtcHistory,
  type ViaBtcPaymentRow,
  type ViaBtcProfitRow,
} from "./types";

const PAGE_LIMIT = 50;
const MAX_PAGES = 200;
const USER_AGENT = "OrangeRails/1.0 (+https://orangerails.com; viabtc-connector)";

export type ViaBtcClientOptions = {
  apiKey: string;
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type Envelope = {
  code: number;
  message?: string;
  data?: unknown;
  has_next?: boolean;
};

function authMessage(code: number | undefined, message: string | undefined, httpStatus?: number): string {
  const bits = ["[viabtc] authentication failed: unauthorized"];
  if (code === 12001) bits.push("invalid api key");
  else if (code === 12002) bits.push("signature invalid");
  else if (code === 12003) bits.push("stale or invalid tonce");
  else if (code === 12004) bits.push("IP not allowed (forbidden)");
  if (httpStatus) bits.push(`(HTTP ${httpStatus})`);
  if (message) bits.push(message.slice(0, 120));
  return bits.join(": ");
}

function throwForEnvelope(env: Envelope, httpStatus?: number): never {
  if (VIABTC_AUTH_CODES.has(env.code)) {
    throw new ViaBtcAuthError(authMessage(env.code, env.message, httpStatus), env.code);
  }
  throw new ViaBtcApiError(
    `[viabtc] API error code ${env.code}${env.message ? `: ${env.message.slice(0, 120)}` : ""}`,
    env.code,
  );
}

function extractPage<T>(env: Envelope): { items: T[]; hasNext: boolean } {
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

export class ViaBtcApiClient {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(opts: ViaBtcClientOptions) {
    if (!opts.apiKey.trim()) throw new Error("[viabtc] credentials.api_key required");
    if (!opts.secretKey.trim()) throw new Error("[viabtc] credentials.secret_key required");
    this.apiKey = opts.apiKey.trim();
    this.secretKey = opts.secretKey.trim();
    this.baseUrl = (opts.baseUrl ?? VIABTC_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /** Signature-required probe so a bad secret never looks like an empty book. */
  async probeAuth(): Promise<void> {
    await this.getJson("/account/sub", {});
  }

  async fetchPaymentHistory(coin: string, startDate?: string, endDate?: string): Promise<ViaBtcPaymentRow[]> {
    return this.paginate<ViaBtcPaymentRow>("/wallet/payment/history", {
      coin,
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      utc: true,
    });
  }

  async fetchProfitHistory(coin: string, startDate?: string, endDate?: string): Promise<ViaBtcProfitRow[]> {
    return this.paginate<ViaBtcProfitRow>("/profit/history", {
      coin,
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      utc: true,
    });
  }

  async fetchRewardHistory(coin: string, startDate?: string, endDate?: string): Promise<ViaBtcProfitRow[]> {
    return this.paginate<ViaBtcProfitRow>("/reward/history", {
      coin,
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
    });
  }

  async fetchAccount(): Promise<{ coins: string[] }> {
    const env = await this.getJson("/account", {});
    const data = (env.data && typeof env.data === "object" ? env.data : {}) as {
      balance?: Array<{ coin?: string }>;
      withdraw_address?: Array<{ coin?: string }>;
    };
    const seen = new Set<string>();
    for (const row of data.balance ?? []) {
      if (row.coin) seen.add(row.coin.toUpperCase());
    }
    for (const row of data.withdraw_address ?? []) {
      if (row.coin) seen.add(row.coin.toUpperCase());
    }
    if (seen.size === 0) seen.add("BTC");
    return { coins: [...seen].sort() };
  }

  async fetchHistory(opts: { coins?: string[]; startDate?: string; endDate?: string } = {}): Promise<ViaBtcHistory> {
    await this.probeAuth();
    const coins =
      opts.coins && opts.coins.length > 0 ? opts.coins : (await this.fetchAccount()).coins;
    const payments: ViaBtcPaymentRow[] = [];
    const profits: ViaBtcProfitRow[] = [];
    const rewards: ViaBtcProfitRow[] = [];

    for (const coin of coins) {
      const [p, pr] = await Promise.all([
        this.fetchPaymentHistory(coin, opts.startDate, opts.endDate),
        this.fetchProfitHistory(coin, opts.startDate, opts.endDate),
      ]);
      payments.push(...p);
      profits.push(...pr);
    }

    for (const coin of VIABTC_REWARD_COINS) {
      try {
        rewards.push(...(await this.fetchRewardHistory(coin, opts.startDate, opts.endDate)));
      } catch (err) {
        if (err instanceof ViaBtcAuthError) throw err;
        if (err instanceof ViaBtcApiError && err.viabtcCode === 5001) continue;
        throw err;
      }
    }

    return { payments, profits, rewards };
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

  private async getJson(path: string, params: Record<string, string | number | boolean>): Promise<Envelope> {
    const withTonce = { ...params, tonce: this.nowMs() };
    const query = buildQueryString(withTonce);
    const signature = hmacSha256Hex(this.secretKey, query);
    const url = `${this.baseUrl}${path}?${query}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "X-API-KEY": this.apiKey,
          "X-SIGNATURE": signature,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      throw new ViaBtcApiError(`[viabtc] network error: ${(err as Error).message}`);
    }

    const rawText = await res.text().catch(() => "");
    let env: Envelope | null = null;
    if (rawText) {
      try {
        env = JSON.parse(rawText) as Envelope;
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
