/**
 * Orange Rails - Zeus Lightning Network confirms adapter.
 *
 * Zeus is a wallet that fronts the user's own Lightning node. The confirms
 * path therefore speaks the LND REST invoice API (GET /v1/invoices), which
 * is the surface Zeus proxies to for LND-backed nodes. Auth is the node's
 * macaroon, passed at call time and never stored by OR.
 *
 * IMPORTANT (verify before relying in production): the LND REST field names
 * and units below (amt_paid_msat, settle_date, index_offset) are grounded in
 * the documented LND REST schema, but must be confirmed against a live
 * LND/Zeus response. LND REST serialises int64 fields as JSON strings, so
 * numeric fields are parsed, not read as numbers.
 */

import type { LNConfirmsClient, LNFetchOptions, LNInvoice } from './client';
import { toLNSettledState } from './client';
import type { LNProviderName } from './types';

/**
 * Raw invoice as LND REST returns it (GET /v1/invoices).
 * int64 fields arrive as strings; we parse them in toInvoice().
 */
type LndRawInvoice = {
  /** Payment hash, base64 in LND REST. */
  r_hash: string;
  memo?: string | null;
  /**
   * Invoiced value. LND returns both a satoshi field (value / amt_paid_sat)
   * and a native millisatoshi field (value_msat / amt_paid_msat). We prefer
   * the msat field to avoid any sats-to-msat conversion.
   */
  value?: string;
  value_msat?: string;
  amt_paid_sat?: string;
  amt_paid_msat?: string;
  /** 'OPEN' | 'SETTLED' | 'CANCELED' | 'ACCEPTED'. */
  state?: string;
  settled?: boolean;
  /** Unix seconds the invoice was created (string in LND REST). */
  creation_date?: string;
  /** Unix seconds the invoice was settled, '0' when unsettled. */
  settle_date?: string;
  /** Invoice expiry in seconds relative to creation (string). */
  expiry?: string;
};

type LndInvoicesResponse = {
  invoices: LndRawInvoice[];
  /** Cursor for the next page. */
  last_index_offset?: string;
};

const DEFAULT_PAGE_SIZE = 100;
/**
 * Maximum pages fetched in a single fetchSettled call when the caller does
 * not supply opts.maxPages. Mirrors the Alby adapter: high enough that no
 * legitimate dataset reaches it, low enough to stop an infinite loop when a
 * backend ignores the index_offset cursor.
 */
const DEFAULT_MAX_PAGES = 1000;

export type ZeusConfirmsClientOptions = {
  /**
   * Base URL of the LND REST endpoint Zeus is connected to,
   * e.g. https://my-node:8080. No trailing slash required.
   */
  apiBase: string;
  /** Hex-encoded invoice macaroon for read access to /v1/invoices. */
  macaroon: string;
};

function unixToIso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function toIsoOrNull(unix: number | null | undefined): string | null {
  if (unix == null || unix <= 0) return null;
  return unixToIso(unix);
}

/** Parse an LND int64-as-string field to a number, defaulting to 0. */
function parseIntField(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve the amount in millisatoshis for a settled invoice.
 *
 * A settled invoice's real value is what was actually paid, which can diverge
 * from what was invoiced: a zero-amount invoice carries no invoiced amount at
 * all, an overpayment settles above it, and AMP splits settle at a paid amount
 * the invoiced field does not reflect. So both paid fields rank ahead of both
 * invoiced fields, in this order:
 *   1. amt_paid_msat  (paid, native millisatoshis)
 *   2. amt_paid_sat   (paid, satoshis -> *1000)
 *   3. value_msat     (invoiced, native millisatoshis)
 *   4. value          (invoiced, satoshis -> *1000)
 *
 * Within each pair the native millisatoshi field wins, so the single
 * sats-to-msat conversion (Invariant #3: verify the unit before converting)
 * only runs when no msat field is present. Each step is guarded on `> 0` so a
 * zero or absent field falls through to the next candidate rather than
 * masking a populated lower-ranked one.
 */
function toMsat(raw: LndRawInvoice): number {
  const paidMsat = parseIntField(raw.amt_paid_msat);
  if (paidMsat > 0) return paidMsat;
  const paidSat = parseIntField(raw.amt_paid_sat);
  if (paidSat > 0) return paidSat * 1000;
  const invoicedMsat = parseIntField(raw.value_msat);
  if (invoicedMsat > 0) return invoicedMsat;
  const invoicedSat = parseIntField(raw.value);
  return invoicedSat * 1000;
}

function isSettled(raw: LndRawInvoice): boolean {
  if (raw.state) return raw.state === 'SETTLED';
  return raw.settled === true;
}

function toInvoice(raw: LndRawInvoice): LNInvoice {
  const created = parseIntField(raw.creation_date);
  const expiry = parseIntField(raw.expiry);
  const settleDate = parseIntField(raw.settle_date);
  const settled = isSettled(raw);
  return {
    payment_hash: raw.r_hash,
    amount_msat: toMsat(raw),
    description: raw.memo ?? null,
    created_at: unixToIso(created),
    // LND expiry is a duration from creation, not an absolute timestamp.
    expires_at: expiry > 0 && created > 0 ? unixToIso(created + expiry) : null,
    provider: 'zeus' as LNProviderName,
    // Cursor on settle time: pass the settle_date, not creation_date.
    state: toLNSettledState(settled, settled && settleDate > 0 ? settleDate : null),
  };
}

export class ZeusConfirmsClient implements LNConfirmsClient {
  readonly provider = 'zeus';
  private readonly apiBase: string;
  private readonly macaroon: string;

  constructor(opts: ZeusConfirmsClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.macaroon = opts.macaroon;
  }

  async fetchSettled(opts?: LNFetchOptions): Promise<LNInvoice[]> {
    const pageSize = opts?.limit ?? DEFAULT_PAGE_SIZE;
    // Resolve the cap before the loop so it is always active, exactly as the
    // Alby adapter does. Omitting maxPages must still be bounded in prod.
    const resolvedMaxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
    const allInvoices: LNInvoice[] = [];
    // LND paginates by index_offset: pass 0 to start, then feed the response's
    // last_index_offset back in. Walk forward (not reversed) so the cursor
    // advances deterministically until the settled window is exhausted.
    let indexOffset = 0;
    let page = 0;

    while (true) {
      const params = new URLSearchParams({
        index_offset: String(indexOffset),
        num_max_invoices: String(pageSize),
      });

      const url = `${this.apiBase}/v1/invoices?${params.toString()}`;
      const res = await fetch(url, {
        headers: {
          'Grpc-Metadata-macaroon': this.macaroon,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(
          `ZeusConfirmsClient: request failed ${res.status} ${res.statusText}`,
        );
      }

      const body = (await res.json()) as LndInvoicesResponse;
      const batch = body.invoices ?? [];
      // Only settled rows cross into the pipeline; the rest are dropped here.
      for (const raw of batch) {
        const inv = toInvoice(raw);
        if (inv.state.settled) allInvoices.push(inv);
      }

      // An empty page (or one shorter than requested) signals exhaustion.
      // We do not stop early on a short settled-count, only on a short raw
      // batch, so we never silently truncate money data mid-window.
      if (batch.length < pageSize) break;

      const nextOffset = parseIntField(body.last_index_offset);
      // Defensive: if the cursor fails to advance we would loop forever on
      // the same page, so treat a non-advancing offset as exhaustion.
      if (nextOffset <= indexOffset) break;
      indexOffset = nextOffset;

      page++;
      if (page >= resolvedMaxPages) {
        throw new Error(
          `ZeusConfirmsClient: pagination safety cap reached after ${resolvedMaxPages} page(s). ` +
            'The backend may not be honoring the index_offset cursor.',
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

    return invoices;
  }
}
