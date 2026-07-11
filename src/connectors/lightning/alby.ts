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
  /**
   * Amount in satoshis (VERIFIED: Alby REST API, GET /invoices, "amount" field).
   * We convert to millisatoshis in toInvoice() below.
   */
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
/**
 * Maximum pages fetched in a single fetchSettled call when the caller does
 * not supply opts.maxPages. Set high enough (100,000 invoices at the default
 * page size) that no legitimate dataset ever reaches it. The cap exists only
 * to stop an infinite loop when a backend ignores the page param; it must
 * never fire for a real user's history, however large.
 */
const DEFAULT_MAX_PAGES = 1000;

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
    // raw.amount is satoshis (see AlbyRawInvoice). Multiply by 1000 to
    // produce millisatoshis as LNInvoice.amount_msat requires.
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
    // Paginate through all pages so we never silently truncate money data.
    // Alby does not expose a server-side settle-time filter; we filter
    // client-side on settled_at when `after` is set.
    const pageSize = opts?.limit ?? DEFAULT_PAGE_SIZE;
    // Resolve the cap before the loop so it is always active. Callers can
    // pass opts.maxPages to override; DEFAULT_MAX_PAGES guards the case where
    // none is supplied (e.g. the production ingest path).
    const resolvedMaxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
    const allInvoices: LNInvoice[] = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        'q[settled]': 'true',
        items: String(pageSize),
        page: String(page),
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
      const batch = (body.invoices ?? []).map(toInvoice);
      allInvoices.push(...batch);

      // A page shorter than pageSize signals the result set is exhausted.
      if (batch.length < pageSize) break;

      page++;

      // Safety cap: if the backend is ignoring the page parameter and
      // returning a full page on every request, we would loop without bound
      // and exhaust the function's execution budget. resolvedMaxPages is
      // always set (DEFAULT_MAX_PAGES when the caller omits maxPages) so this
      // guard fires in production, not only in explicit test scenarios.
      if (page > resolvedMaxPages) {
        throw new Error(
          `AlbyConfirmsClient: pagination safety cap reached after ${resolvedMaxPages} page(s). ` +
            'The backend may not be honoring the page parameter.',
        );
      }
    }

    let invoices = allInvoices;

    if (opts?.after) {
      // Cursor is settle time, NOT creation time. An invoice created before
      // the cursor but settled after it must not be missed.
      const afterMs = new Date(opts.after).getTime();
      invoices = invoices.filter((inv) => {
        if (!inv.state.settled_at) return false;
        return new Date(inv.state.settled_at).getTime() > afterMs;
      });
    }

    // Guard: only return what the API confirmed as settled.
    return invoices.filter((inv) => inv.state.settled);
  }
}
