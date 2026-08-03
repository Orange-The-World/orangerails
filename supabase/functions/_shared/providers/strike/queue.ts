/**
 * Strike webhook queue drain , provider-specific sync path.
 *
 * Strike is webhook-driven (see strike.ts header comment + the ADR at
 * On every user-initiated sync we:
 *
 *   1. Ensure a Strike webhook subscription is registered for this connection.
 *      If strike_subscription_id is NULL, generate a fresh HMAC secret and
 *      POST /v1/subscriptions to Strike with our or-strike-webhook URL.
 *      Store the subscription_id + secret on the connection row.
 *
 *   2. Drain the strike_webhook_events queue:
 *      - SELECT pending rows (processed_at IS NULL) for this connection
 *      - For each event, call GET /v1/invoices/{id} or /v1/payments/{id}
 *      - Normalize the result into a NormalizedTransaction
 *      - Mark the event row processed
 *
 * No OData, no list scans, no Cloudflare 403. All Strike API calls in this
 * file hit ID-addressed paths only.
 *
 * Lives in a separate file from strike.ts so the adapter library stays free
 * of SupabaseClient dependencies (testable in isolation).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import {
  STRIKE_DEFAULT_EVENT_TYPES,
  normalizeDeposit,
  normalizeExchange,
  normalizeInvoice,
  normalizePayment,
  normalizePayout,
  normalizeReceive,
  parseStrikeCredentials,
  strikeCreateSubscription,
  strikeGetDepositById,
  strikeGetExchangeQuoteById,
  strikeGetInvoiceById,
  strikeGetPaymentById,
  strikeGetPayoutById,
  strikeGetReceiveById,
} from './index.ts';
import type { NormalizedTransaction, SyncResult } from '../types.ts';
import { computeWalletFingerprint } from '../../account-fingerprint.ts';
import { toByteaHex } from '../../bytea.ts';

const DRAIN_BATCH = 100;

/**
 * Map a Strike subscription-create failure to a distinct, actionable plaintext
 * marker stored in connections.encrypted_last_error. Pure and side-effect free
 * so the mapping is unit-tested independently. Strike API errors arrive as
 * `Strike <status> POST /subscriptions: <detail>` (see strikePost in index.ts),
 * so the status drives the class. The scope marker string is unchanged for
 * backward compatibility with existing consumers.
 */
export function strikeSubscriptionErrorMarker(message: string): string {
  if (/403|FORBIDDEN|Insufficient permissions/i.test(message)) {
    return 'STRIKE_SCOPE_MISSING_partner.webhooks.manage';
  }
  if (/\b401\b|Unauthorized/i.test(message)) {
    return 'STRIKE_KEY_INVALID';
  }
  if (/\b400\b|Bad Request/i.test(message)) {
    return 'STRIKE_SUBSCRIPTION_REJECTED';
  }
  if (/\b429\b|rate.?limit/i.test(message)) {
    return 'STRIKE_RATE_LIMITED';
  }
  return 'STRIKE_SUBSCRIPTION_FAILED';
}

export interface DrainConnection {
  id: string;
  strike_subscription_id: string | null;
  last_sync_cursor: string | null;
}

/**
 * Resolve the source_wallet_id for a Strike invoice at drain time.
 *
 * Computes wallet_fingerprint = HMAC-SHA256(key, domain || subaccountId ||
 * providerType || receiverId || currency) then looks up in walletsByFingerprintHex.
 * Returns null on no-match: the transaction holds unattributed and heals on
 * natural re-sync. No mis-file to a wrong wallet is possible because the
 * fingerprint is scoped to the exact (account, currency) pair.
 *
 * receiverId is the canonical_account_key from the Strike invoice response.
 * INTERNAL ONLY: never log or surface receiverId outside this call.
 */
export async function resolveInvoiceWallet(
  subaccountId: string,
  providerType: 'strike',
  receiverId: string,
  currency: string,
  walletsByFingerprintHex: Map<string, string>,
): Promise<string | null> {
  if (!receiverId || !currency) return null;
  const fp = await computeWalletFingerprint(subaccountId, providerType, receiverId, currency);
  return walletsByFingerprintHex.get(toByteaHex(fp)) ?? null;
}

export async function drainStrikeQueue(args: {
  serviceClient: SupabaseClient;
  connection: DrainConnection;
  credentials: Record<string, unknown>;
  webhookBaseUrl: string;
  /**
   * Map of wallet_fingerprint bytea-hex string (\x + lowercase hex) to
   * external_wallet_id for this connection. Built from source_wallets rows
   * selected with wallet_fingerprint. Used to attribute invoice transactions
   * to the correct per-currency wallet at drain time by recomputing the
   * fingerprint from the Strike invoice response (subaccountId + "strike" +
   * inv.receiverId + inv.amount.currency). A no-match returns null: held
   * unattributed, heals on natural re-sync. No mis-file to a wrong wallet.
   */
  walletsByFingerprintHex: Map<string, string>;
  /**
   * Subaccount ID owning this connection. Required to compute wallet
   * fingerprints: HMAC(key, domain || subaccountId || providerType ||
   * receiverId || currency).
   */
  subaccountId: string;
}): Promise<SyncResult> {
  const creds = parseStrikeCredentials(args.credentials);
  const conn = args.connection;

  // Step 1: ensure subscription registered
  if (!conn.strike_subscription_id) {
    // Strike caps the `secret` field at 50 chars per
    // docs.strike.me/api/create-subscription. 24 random bytes -> 48 hex chars,
    // safely under the limit while still 192 bits of entropy.
    const secret = generateHexSecret(24);
    const webhookUrl = `${args.webhookBaseUrl}?conn=${conn.id}`;
    try {
      const sub = await strikeCreateSubscription(creds, {
        webhookUrl,
        secret,
        eventTypes: STRIKE_DEFAULT_EVENT_TYPES,
      });
      const { error } = await args.serviceClient
        .from('connections')
        .update({ strike_subscription_id: sub.id, strike_webhook_secret: secret })
        .eq('id', conn.id);
      if (error) throw error;
      console.log(`[strike-queue] registered subscription ${sub.id} for connection ${conn.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Persist an actionable marker on EVERY subscription-failure branch, not
      // just the scope case. The old code console.error'd non-scope failures
      // into the void, leaving the connection with no readable cause and
      // forcing a server-log dig on the next failure. strikeSubscriptionErrorMarker
      // maps the error to a distinct plaintext marker the consumer maps to a CTA.
      const marker = strikeSubscriptionErrorMarker(message);
      if (marker === 'STRIKE_SCOPE_MISSING_partner.webhooks.manage') {
        console.error(
          `[strike-queue] connection ${conn.id} key is missing the ` +
          `partner.webhooks.manage scope; webhooks cannot be registered. ` +
          `Customer must regenerate the key from the API Key section on dashboard.strike.me ` +
          `with that scope enabled. Detail: ${message.slice(0, 200)}`,
        );
      } else {
        console.error(
          `[strike-queue] subscription registration failed for ${conn.id} -> ${marker}: ${message.slice(0, 200)}`,
        );
      }
      await args.serviceClient
        .from('connections')
        .update({ encrypted_last_error: marker })
        .eq('id', conn.id);
      return { transactions: [], next_cursor: conn.last_sync_cursor };
    }
  }

  // Step 2: drain pending events
  const { data: events, error: fetchErr } = await args.serviceClient
    .from('strike_webhook_events')
    .select('id, event_type, entity_id')
    .eq('connection_id', conn.id)
    .is('processed_at', null)
    .order('received_at', { ascending: true })
    .limit(DRAIN_BATCH);

  if (fetchErr) throw fetchErr;
  if (!events || events.length === 0) {
    return { transactions: [], next_cursor: conn.last_sync_cursor };
  }

  const transactions: NormalizedTransaction[] = [];
  const processedIds: string[] = [];

  for (const ev of events) {
    try {
      let norm: NormalizedTransaction | null = null;

      if (ev.event_type.startsWith('invoice.')) {
        const inv = await strikeGetInvoiceById(creds, ev.entity_id);
        const invCurrency = (inv.amount?.currency ?? '').toUpperCase();
        const invReceiverId = inv.receiverId ?? '';
        const invWalletId = await resolveInvoiceWallet(
          args.subaccountId, 'strike', invReceiverId, invCurrency, args.walletsByFingerprintHex,
        );
        if (invWalletId === null) {
          console.warn(
            `[strike-queue] event ${ev.id}: invoice fingerprint no-match` +
            ` (currency present=${!!invCurrency}, receiverId present=${!!invReceiverId}); held unattributed`,
          );
        }
        norm = normalizeInvoice(inv, invWalletId);
      } else if (ev.event_type.startsWith('payment.')) {
        // Outgoing Lightning send. No list endpoint, so webhooks are the
        // ONLY discovery path for these , critical not to drop.
        //
        // THE FIVE NON-INVOICE TYPES BELOW ALL HOLD UNATTRIBUTED (wallet null).
        // Attribution needs a wallet_fingerprint, and a fingerprint needs the
        // receiverId (canonical_account_key). Strike returns receiverId on the
        // invoice response only; payment, receive, deposit, payout and exchange
        // responses do not carry it. The previous currency-keyed fallback is
        // gone with no replacement: it was built from a source_wallets.currency
        // column that does not exist in the database and cannot be added
        // (currency lives in ORK-encrypted encrypted_metadata, Privacy HOLD).
        // Holding a transaction unattributed is recoverable on re-sync; filing
        // it against a guessed wallet is not.
        const pay = await strikeGetPaymentById(creds, ev.entity_id);
        norm = normalizePayment(pay, null);
      } else if (ev.event_type.startsWith('receive-request.')) {
        // Lightning-address receive. entityId is the receive_id (not the
        // parent receive-request id) per Strike webhook contract.
        const rec = await strikeGetReceiveById(creds, ev.entity_id);
        norm = normalizeReceive(rec, null);
      } else if (ev.event_type.startsWith('deposit.')) {
        const dep = await strikeGetDepositById(creds, ev.entity_id);
        norm = normalizeDeposit(dep, null);
      } else if (ev.event_type.startsWith('payout.')) {
        const po = await strikeGetPayoutById(creds, ev.entity_id);
        norm = normalizePayout(po, null);
      } else if (ev.event_type.startsWith('currency-exchange-quote.')) {
        const q = await strikeGetExchangeQuoteById(creds, ev.entity_id);
        norm = normalizeExchange(q, null);
      } else {
        // Unknown event type , log + skip + mark processed (don't loop).
        console.warn(`[strike-queue] unknown event_type=${ev.event_type} on ${ev.id}`);
      }

      if (norm) transactions.push(norm);
      processedIds.push(ev.id);
    } catch (err) {
      // GET-by-id failed (404, network, CF flake). Leave processed_at NULL
      // so the next sync retries. Log and continue with the next event.
      console.error(`[strike-queue] event ${ev.id} (${ev.event_type} ${ev.entity_id}) failed:`, err);
    }
  }

  if (processedIds.length > 0) {
    const { error: markErr } = await args.serviceClient
      .from('strike_webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .in('id', processedIds);
    if (markErr) {
      // Marking the events processed failed , non-fatal, they'll just be
      // reprocessed on the next sync (idempotent thanks to the
      // transactions sink's UNIQUE (connection_id, external_id) constraint)
      console.error('[strike-queue] mark-processed failed:', markErr);
    }
  }

  return {
    transactions,
    next_cursor: conn.last_sync_cursor, // cursor unused in the webhook model
  };
}

function generateHexSecret(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
