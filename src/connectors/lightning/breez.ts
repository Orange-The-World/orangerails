/**
 * Orange Rails - Breez Lightning Network confirms adapter (WIP).
 *
 * Breez differs from Alby and Zeus in the one way that shapes this whole
 * adapter: a receive can arrive through a submarine / Liquid swap, so an
 * invoice can settle materially LATER than it was created, and its settle
 * time can be BACKDATED once the swap record finalises. So on every sync this
 * adapter re-scans a trailing window sized to cover worst-case swap
 * settlement lag, and emits the whole window rather than a strict delta.
 *
 * BOUNDARY CONTRACT (read before changing fetchSettled):
 *   - The fetch lower bound is (cursor - rescanWindowSec).
 *   - Every settled receive in that window is EMITTED. There is deliberately
 *     no strict settled_at > cursor filter on the way out. Such a filter
 *     would drop exactly the late and backdated swap settlements the window
 *     exists to catch, which would make the window pointless.
 *   - Therefore this adapter REQUIRES an idempotent ingest: upsert on
 *     payment_hash, falling back to tx_id for swap records that carry no
 *     hash. Without that upsert, re-emitting the window each sync duplicates
 *     money data. Alby and Zeus can lean on an emit filter for their delta
 *     because they have no backdating. Breez cannot.
 *
 * STATUS: WIP. The listPayments mapping body (toInvoice) is unverified
 * against a live SDK response, and the DB cursor read is not wired. Both are
 * marked below.
 *
 * The Breez SDK is injected as BreezPaymentsSource rather than imported here,
 * so the adapter stays unit-testable and does not drag the native SDK into
 * the build. The concrete SDK wiring lands with the mapping body.
 */

import type { LNConfirmsClient, LNFetchOptions, LNInvoice } from './client';
import { toLNSettledState } from './client';
import type { LNProviderName } from './types';

/**
 * One Breez payment as the SDK returns it from list_payments.
 *
 * VERIFY against a live Breez SDK response before relying in production:
 * field names and units below are grounded in the documented ListPayments
 * surface but must be confirmed. Amounts are millisatoshis; timestamps are
 * Unix seconds. paymentTime is the SETTLE time, which is what we cursor on.
 */
export type BreezRawPayment = {
  /** Payment hash (hex) when present; some swap records key on id. */
  paymentHash?: string | null;
  id?: string | null;
  /** 'received' | 'sent'. Only received settlements are money-in here. */
  paymentType?: string;
  /** 'complete' | 'pending' | 'failed'. Only complete crosses the boundary. */
  status?: string;
  /** Amount actually moved, native millisatoshis. */
  amountMsat?: number | string | null;
  /** Fee paid, native millisatoshis (informational for now). */
  feeMsat?: number | string | null;
  description?: string | null;
  /** Unix seconds the invoice was created. */
  createdAt?: number | string | null;
  /** Unix seconds the payment settled ('0' / absent when unsettled). */
  paymentTime?: number | string | null;
};

/** Request shape passed to the SDK. offset/limit drive pagination. */
export type BreezListPaymentsRequest = {
  offset: number;
  limit: number;
  /** Unix seconds lower bound on settle time, when the SDK supports it. */
  fromTimestamp?: number;
};

/**
 * The slice of the Breez SDK this adapter depends on. Injected so tests and
 * the build do not need the native module. The real SDK's list_payments is
 * adapted to this shape at construction.
 */
export interface BreezPaymentsSource {
  listPayments(req: BreezListPaymentsRequest): Promise<BreezRawPayment[]>;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Maximum pages fetched in a single fetchSettled call when the caller does not
 * supply opts.maxPages. Mirrors Zeus/Alby: high enough that no legitimate
 * dataset reaches it, low enough to stop an infinite loop when the backend
 * ignores the offset cursor.
 */
const DEFAULT_MAX_PAGES = 1000;

/**
 * Trailing re-scan window, in seconds.
 *
 * On each sync the effective fetch lower bound is (cursor - RESCAN_WINDOW) so
 * that a swap which settled after its invoice was created, or whose settle
 * time was backdated, is still picked up. This value MUST be >= worst-case
 * swap settlement lag, otherwise late swaps are silently dropped from money
 * data.
 *
 * 24h. The worst case here is a chain-confirmation problem, not a Lightning
 * one: a submarine swap's on-chain leg can sit unconfirmed through a fee
 * spike, so the window has to cover a slow chain rather than a typical one.
 * Over-emitting a 24h window each sync is cheap once ingest is idempotent
 * (see BOUNDARY CONTRACT above); under-sizing it loses money data
 * permanently. Overridable per client via options.rescanWindowSec.
 */
const DEFAULT_RESCAN_WINDOW_SEC = 24 * 60 * 60;

export type BreezConfirmsClientOptions = {
  /** Injected Breez SDK payments source (see BreezPaymentsSource). */
  source: BreezPaymentsSource;
  /**
   * Trailing re-scan window in seconds. Defaults to DEFAULT_RESCAN_WINDOW_SEC.
   * Size this to cover worst-case swap settlement lag.
   */
  rescanWindowSec?: number;
};

/** Parse a Breez int-or-string numeric field to a number, defaulting to 0. */
function parseNumField(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function unixToIso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function isComplete(raw: BreezRawPayment): boolean {
  return (raw.status ?? '').toLowerCase() === 'complete';
}

/**
 * WIP: map a raw Breez payment to the canonical LNInvoice.
 *
 * Not final. Open points before this is done:
 *   - confirm paymentHash vs id as the stable key for swap records
 *   - confirm amountMsat is the received (paid) amount, not the invoiced one
 *   - confirm paymentTime is settle time in Unix seconds
 *
 * payment_hash is the ingest dedupe key, so an empty value here would defeat
 * the upsert. Swap records that carry no hash fall back to id (tx_id).
 */
function toInvoice(raw: BreezRawPayment): LNInvoice {
  const created = parseNumField(raw.createdAt);
  const settleTime = parseNumField(raw.paymentTime);
  const settled = isComplete(raw);
  return {
    payment_hash: raw.paymentHash ?? raw.id ?? '',
    amount_msat: parseNumField(raw.amountMsat),
    description: raw.description ?? null,
    created_at: created > 0 ? unixToIso(created) : unixToIso(settleTime),
    // Breez does not surface a reliable expiry on settled records yet.
    expires_at: null,
    provider: 'breez' as LNProviderName,
    // Cursor on settle time: pass paymentTime, not createdAt.
    state: toLNSettledState(settled, settled && settleTime > 0 ? settleTime : null),
  };
}

export class BreezConfirmsClient implements LNConfirmsClient {
  readonly provider = 'breez';
  private readonly source: BreezPaymentsSource;
  private readonly rescanWindowSec: number;

  constructor(opts: BreezConfirmsClientOptions) {
    this.source = opts.source;
    this.rescanWindowSec = opts.rescanWindowSec ?? DEFAULT_RESCAN_WINDOW_SEC;
  }

  async fetchSettled(opts?: LNFetchOptions): Promise<LNInvoice[]> {
    const pageSize = opts?.limit ?? DEFAULT_PAGE_SIZE;
    const resolvedMaxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;

    // The caller's cursor sets the fetch lower bound, widened by the trailing
    // re-scan window so late and backdated swap settlements are still seen.
    // Everything settled inside that window is emitted (see BOUNDARY
    // CONTRACT at the top of this file): ingest dedupes on payment_hash.
    let fromTimestamp: number | undefined;
    if (opts?.after) {
      const afterSec = Math.floor(new Date(opts.after).getTime() / 1000);
      fromTimestamp = Math.max(0, afterSec - this.rescanWindowSec);
    }

    const settledInvoices: LNInvoice[] = [];
    let offset = 0;
    let page = 0;

    // WIP: pagination loop matches Zeus (paginate to exhaustion, safety cap,
    // cursor advances deterministically). The SDK call surface is via the
    // injected source; error handling and the DB cursor read land with the
    // mapping body.
    while (true) {
      const batch = await this.source.listPayments({
        offset,
        limit: pageSize,
        fromTimestamp,
      });

      for (const raw of batch) {
        // Only settled receives cross into the pipeline.
        if ((raw.paymentType ?? '').toLowerCase() === 'sent') continue;
        const inv = toInvoice(raw);
        if (inv.state.settled) settledInvoices.push(inv);
      }

      // A page shorter than requested signals exhaustion. We stop on a short
      // RAW batch, never on a short settled-count, so money data is not
      // silently truncated mid-window.
      if (batch.length < pageSize) break;

      offset += batch.length;
      page++;
      if (page >= resolvedMaxPages) {
        throw new Error(
          `BreezConfirmsClient: pagination safety cap reached after ${resolvedMaxPages} page(s). ` +
            'The backend may not be honoring the offset cursor.',
        );
      }
    }

    // No strict settled_at > cursor filter here, deliberately. See BOUNDARY
    // CONTRACT above: that filter would drop the late and backdated swap
    // settlements this adapter exists to catch. Idempotent ingest, not an
    // emit filter, is what keeps the re-scanned window from duplicating.
    return settledInvoices;
  }
}
