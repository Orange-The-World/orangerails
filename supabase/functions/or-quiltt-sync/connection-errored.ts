/**
 * connection.errored fan-out for or-quiltt-sync.
 *
 * Called after reconcileConnectionError has flipped the OR connection to
 * error. Enqueues one connection.errored webhook_delivery row for the
 * connection's platform, which or-webhook-dispatch then delivers.
 *
 * Rules, each pinned by a test in connection-errored.test.ts:
 *   - Quiltt only. Other providers are a follow-on.
 *   - Sends nothing, and logs one line, when the Quiltt event carries no
 *     record.id or when no OR connections row matches it. The boundary
 *     cases: the mapping-miss fallback in the drain loop never reaches here
 *     because it has no platform or subaccount.
 *   - Sends nothing when the platform has no webhook_url (no opt-in), the
 *     same rule as the sync.completed fan-out.
 *   - At most one event per connection in any rolling 24 hours, decided by
 *     looking for an existing outbox row, whatever its delivery state. That
 *     makes a replayed or retried inbox event harmless.
 *   - Best-effort: returns an outcome and never throws. The connection is
 *     already reconciled, and failing the inbox event here would retry the
 *     reconcile, which could flip a recovered connection back to error.
 *
 * Known limit: the 24 hour check is a read followed by an insert, with no
 * unique index behind it, so two drains handling two events for the same
 * connection at the same instant could both send. Closing that needs a
 * migration and is not done here.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import {
  buildConnectionErroredPayload,
  CONNECTION_ERRORED,
  connectionErroredReason,
} from '../_shared/webhook-events.ts';

/** One connection gets at most one connection.errored in any window this long. */
export const CONNECTION_ERRORED_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ConnectionErroredOutcome =
  | 'enqueued'
  | 'no-record-id'
  | 'no-connection-row'
  | 'no-webhook-url'
  | 'within-window'
  | 'failed';

interface ErroredEvent {
  event_id: string;
  event_type: string;
  payload: any;
}

export async function enqueueConnectionErrored(
  client: SupabaseClient,
  ev: ErroredEvent,
  platformId: string,
  subaccountId: string,
  now: () => number = Date.now,
): Promise<ConnectionErroredOutcome> {
  const skip = (outcome: ConnectionErroredOutcome, why: string): ConnectionErroredOutcome => {
    console.log(`[or-quiltt-sync] connection.errored not sent for event ${ev.event_id}: ${why}`);
    return outcome;
  };
  const fail = (why: string): ConnectionErroredOutcome => {
    console.error(`[or-quiltt-sync] connection.errored enqueue failed for event ${ev.event_id}: ${why}`);
    return 'failed';
  };

  try {
    const quilttConnectionId = typeof ev.payload?.record?.id === 'string' ? ev.payload.record.id : null;
    if (!quilttConnectionId) return skip('no-record-id', 'event carries no record.id');

    const conn = await client
      .from('connections')
      .select('id')
      .eq('subaccount_id', subaccountId)
      .eq('provider_type', 'quiltt')
      .eq('quiltt_connection_id', quilttConnectionId)
      .maybeSingle();
    if (conn.error) return fail(`connection lookup: ${conn.error.message}`);
    if (!conn.data) return skip('no-connection-row', 'no OR connections row for this event');

    const plat = await client
      .from('platforms')
      .select('webhook_url')
      .eq('id', platformId)
      .maybeSingle();
    if (plat.error) return fail(`platform lookup: ${plat.error.message}`);
    const url = plat.data?.webhook_url;
    // No webhook_url means the platform has not opted in. Silent, like sync.completed.
    if (typeof url !== 'string' || url.length === 0) return 'no-webhook-url';

    const since = new Date(now() - CONNECTION_ERRORED_WINDOW_MS).toISOString();
    const recent = await client
      .from('webhook_delivery')
      .select('id')
      .eq('platform_id', platformId)
      .eq('event_type', CONNECTION_ERRORED)
      .eq('payload->data->>connection_id', conn.data.id)
      .gte('created_at', since)
      .limit(1);
    if (recent.error) return fail(`outbox lookup: ${recent.error.message}`);
    if (recent.data && recent.data.length > 0) {
      return skip('within-window', 'one was already queued for this connection in the last 24 hours');
    }

    const { reasonCode, repairable } = connectionErroredReason(ev.event_type);
    const inserted = await client.from('webhook_delivery').insert({
      platform_id: platformId,
      subaccount_id: subaccountId,
      event_type: CONNECTION_ERRORED,
      payload: buildConnectionErroredPayload({
        subaccountId,
        connectionId: conn.data.id,
        reasonCode,
        repairable,
      }),
    });
    if (inserted.error) return fail(`insert: ${inserted.error.message}`);
    return 'enqueued';
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
