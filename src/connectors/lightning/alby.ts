/**
 * Orange Rails - Alby Lightning Network confirms adapter.
 *
 * Fetches settled incoming invoices from the Alby REST API.
 * Auth: OAuth2 bearer token granted by the user via the Alby OAuth flow.
 * The token is never stored by OR; it is passed at call time.
 *
 * Outgoing payments (GET /payments) are a follow-up.
 * Validate against a real Alby account before relying on field names,
 * as Alby's API docs are informal and subject to revision.
 */

import type { LNConfirmsClient, LNFetchOptions, LNInvoice } from './client';
import { toLNSettledState } from './client';
import type { LNProviderName } from './types';

/** Raw invoice object as Alby returns it. */
type AlbyRawInvoice = {
  payment_hash: string;
  /** Amount in satoshis. */
  amount: number;
  memo?: string | null;
  settled: boolean;
  /** Unix seconds when the invoice was settled, or null/absent. */
  settled_at?: number | null;
  /** Unix seconds when the invoice was created. */
  created_at: number;
  /** Unix seconds when the invoice expires, or null/absent. */
  expires_at?: number | null;
};

type AlbyInvoicesResponse = {
  invoices: AlbyRawInvoice[];
};

const ALBY_API_BASE = 'https://api.getalby.com';
const DEFAULT_PAGE_SIZE = 100;

export type AlbyConfirmsClientOptions = {
  /** Alby OAuth bearer token for the user's account. */
  accessToken: string;
  /** Override the Alby API base URL (for tests). */
  apiBase?: string;
};

function unixToIso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function toIsoOrNull(unix: number | null | undefined): string | null {
  if (unix == null || unix <= 0) return null;
  return unixToIso(unix);
}

function toInvoice(raw: AlbyRawInvoice): LNInvoice {
  return {
    payment_hash: raw.payment_hash,
    amount_msat: raw.amount * 1000,
    description: raw.memo ?? null,
    created_at: unixToIso(raw.created_at),
    expires_at: toIsoOrNull(raw.expires_at),
    provider: 'alby' as LNProviderName,
    state: toLNSettledState(raw.settled, raw.settled_at ?? null),
  };
}

export class AlbyConfirmsClient implements LNConfirmsClient {
  readonly provider = 'alby';
  private readonly accessToken: string;
  private readonly apiBase: string;

  constructor(opts: AlbyConfirmsClientOptions) {
    this.accessToken = opts.accessToken;
    this.apiBase = opts.apiBase ?? ALBY_API_BASE;
  }

  async fetchSettled(opts?: LNFetchOptions): Promise<LNInvoice[]> {
    const limit = opts?.limit ?? DEFAULT_PAGE_SIZE;

    // Alby does not expose a server-side after-timestamp filter, so we
    // request settled:true and filter on created_at client-side when `after`
    // is set. The `items` cap keeps each request bounded.
    const params = new URLSearchParams({
      'q[settled]': 'true',
      items: String(limit),
    });

    const url = `${this.apiBase}/invoices?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(
        `AlbyConfirmsClient: request failed ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as AlbyInvoicesResponse;
    let invoices = (body.invoices ?? []).map(toInvoice);

    if (opts?.after) {
      const afterMs = new Date(opts.after).getTime();
      invoices = invoices.filter((inv) => new Date(inv.created_at).getTime() > afterMs);
    }

    // Guard: only return what the API confirmed as settled.
    return invoices.filter((inv) => inv.state.settled);
  }
}
