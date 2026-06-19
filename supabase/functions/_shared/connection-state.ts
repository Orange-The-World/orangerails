/**
 * Shared helpers for the atomic connect-flow state machine (finding N6,
 * audit 2026-05-21).
 *
 * or-link-complete creates a connection in the `pending` state when the
 * ATOMIC_CONFIRM_REQUIRED feature flag is on. The consumer either:
 *   - calls or-connection-confirm   → pending becomes active
 *   - calls or-connection-cancel    → pending row is deleted
 *
 * If the consumer crashes, a janitor (see migration
 * 20260523000000_atomic_connect_flow.sql) deletes pending rows older
 * than 10 minutes.
 *
 * These helpers are intentionally thin and pure-ish (they take the
 * service client as a parameter) so the edge function handlers stay
 * small and the test files can stub the client.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface ConnectionRow {
  id: string;
  status: string;
  subaccount_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Fetch a connection scoped to a subaccount.
 *
 * Returns null on "not found" (or wrong owner) , callers must NOT
 * leak the distinction between "no such id" and "id belongs to
 * another tenant"; both map to 404.
 */
export async function fetchScopedConnection(
  client: SupabaseClient,
  connectionId: string,
  subaccountId: string,
): Promise<ConnectionRow | null> {
  const { data, error } = await client
    .from('connections')
    .select('id, status, subaccount_id')
    .eq('id', connectionId)
    .eq('subaccount_id', subaccountId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ConnectionRow;
}

/**
 * Idempotent confirm: pending → active. Already-active → no-op.
 *
 * Returns the resulting status (or null if no row exists).
 */
export async function confirmConnection(
  client: SupabaseClient,
  conn: ConnectionRow,
): Promise<'active' | 'noop' | 'invalid_state'> {
  if (conn.status === 'active') return 'noop';
  if (conn.status !== 'pending') return 'invalid_state';

  const { error } = await client
    .from('connections')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', conn.id)
    .eq('status', 'pending');
  if (error) throw error;
  return 'active';
}

/**
 * Cancel a pending connection. Active → caller gets 409.
 *
 * Returns the action taken so the handler can choose status codes.
 */
export type CancelResult = 'deleted' | 'already_active' | 'invalid_state';

export async function cancelPendingConnection(
  client: SupabaseClient,
  conn: ConnectionRow,
): Promise<CancelResult> {
  if (conn.status === 'active') return 'already_active';
  if (conn.status !== 'pending') return 'invalid_state';

  const { error } = await client
    .from('connections')
    .delete()
    .eq('id', conn.id)
    .eq('status', 'pending');
  if (error) throw error;
  return 'deleted';
}
