/**
 * Strike webhook queue drain, provider-specific sync path.
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

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
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

const DRAIN_BATCH = 100;

export interface DrainConnection {
  id: string;
  strike_subscription_id: string | null;
  last_sync_cursor: string | null;
  /**
   * The external_wallet_id stored on source_wallets for this connection.
   * Set during discover() to the account's immutable issuerId. Passed to
   * each normalize* call so transactions carry the correct wallet tag.
   * Callers must JOIN source_wallets on connection_id to populate this.
   */
  sourceWalletId: string;
}

export async function drainStrikeQueue(args: {
  serviceClient: SupabaseClient;
  connection: DrainConnection;
  credentials: Record<string, unknown>;
  webhookBaseUrl: string;
}): Promise<SyncResult> {
  const creds = parseStrikeCredentials(args.credentials);
  const conn = args.connection;

  // ─── Step 1: ensure subscription registered ─────────────────────────────
  if (!conn.strike_subscription_id) {
    // Strike caps the `secret` field at 50 chars per
    // docs.strike.me/api/create-subscription. 24 random bytes = 48 hex chars,
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
      // Surface the actionable customer-facing case: Strike API key
      // missing the partner.webhooks.manage scope. The customer needs to
      // regenerate the key from the API Key section on dashboard.strike.me.
      if (/403|FORBIDDEN|Insufficient permissions/i.test(message)) {
        console.error(
          `[strike-queue] connection ${conn.id} key is missing the ` +
          `partner.webhooks.manage scope; webhooks cannot be registered. ` +
          `Customer must regenerate the key from the API Key section on dashboard.strike.me ` +
          `with that scope enabled. Detail: ${message.slice(0, 200)}`,
        );
        // Mark the connection as needing attention so the consumer can
        // surface a clear "regenerate your Strike key" CTA.
        await args.serviceClient
          .from('connections')
          .update({ encrypted_last_error: 'STRIKE_SCOPE_MISSING_partner.webhooks.manage' })
          .eq('id', conn.id);
      } else {
        console.error(`[strike-queue] subscription registration failed for ${conn.id}:`, err);
      }
      return { transactions: [], next_cursor: conn.last_sync_cursor };
    }
  }

  // ─── Step 2: drain pending events ──────────────────────────────────────
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
      // conn.sourceWalletId is the issuerId written by discover() when the
      // connection was first made. Every transaction from this connection
      // belongs to that wallet.
      const wid = conn.sourceWalletId;

      if (ev.event_type.startsWith('invoice.')) {
        const inv = await strikeGetInvoiceById(creds, ev.entity_id);
        norm = normalizeInvoice(inv, wid);
      } else if (ev.event_type.startsWith('payment.')) {
        // Outgoing Lightning send. No list endpoint, so webhooks are the
        // ONLY discovery path for these, critical not to drop.
        const pay = await strikeGetPaymentById(creds, ev.entity_id);
        norm = normalizePayment(pay, wid);
      } else if (ev.event_type.startsWith('receive-request.')) {
        // Lightning-address receive. entityId is the receive_id (not the
        // parent receive-request id) per Strike webhook contract.
        const rec = await strikeGetReceiveById(creds, ev.entity_id);
        norm = normalizeReceive(rec, wid);
      } else if (ev.event_type.startsWith('deposit.')) {
        const dep = await strikeGetDepositById(creds, ev.entity_id);
        norm = normalizeDeposit(dep, wid);
      } else if (ev.event_type.startsWith('payout.')) {
        const po = await strikeGetPayoutById(creds, ev.entity_id);
        norm = normalizePayout(po, wid);
      } else if (ev.event_type.startsWith('currency-exchange-quote.')) {
        const q = await strikeGetExchangeQuoteById(creds, ev.entity_id);
        norm = normalizeExchange(q, wid);
      } else {
        // Unknown event type, log + skip + mark processed (don't loop).
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
      // Marking the events processed failed, non-fatal, they will just be
      // reprocessed on the next sync (idempotent thanks to the
      // transactions sink's UNIQUE (connection_id, external_id) constraint).
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
