/**
 * Orange Rails, ViaBTC pool connector public surface.
 *
 * API-only. The four wallet endpoints (profit summary is a snapshot, not an
 * event; profit history, reward history, payment history) live in ./api.
 * ingestViaBtc is what the CLI calls.
 *
 * Auth failures throw ViaBtcAuthError. They are never returned as an empty
 * staged payload.
 */

import type { StagedImportPayload } from "../contract";
import { ViaBtcApiClient } from "./api";
import { buildViaBtcStagedPayload } from "./to-staged-payload";
import type { IngestViaBtcOptions, IngestViaBtcResult } from "./types";

export { ViaBtcApiClient } from "./api";
export { buildViaBtcStagedPayload, historyToJournalStagedRows } from "./to-staged-payload";
export { hmacSha256Hex, buildQueryString } from "./sign";
export { ViaBtcAuthError, ViaBtcApiError, VIABTC_SOURCE_TAG } from "./types";
export type { IngestViaBtcOptions, IngestViaBtcResult, ViaBtcHistory } from "./types";

export async function ingestViaBtc(opts: IngestViaBtcOptions): Promise<IngestViaBtcResult> {
  if (!opts.apiKey) {
    throw new Error("[viabtc] credentials.api_key required");
  }
  if (!opts.secretKey) {
    throw new Error("[viabtc] credentials.secret_key required");
  }

  const client = new ViaBtcApiClient({
    apiKey: opts.apiKey,
    secretKey: opts.secretKey,
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    nowMs: opts.nowMs,
  });

  const history = await client.fetchHistory({
    startDate: opts.since,
    endDate: opts.until,
  });
  const { payload, warnings } = buildViaBtcStagedPayload(history, opts.orgHint);
  return { payload, pathUsed: "api", warnings, history };
}

export type { StagedImportPayload };
