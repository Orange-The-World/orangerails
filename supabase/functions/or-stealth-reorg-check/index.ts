/**
 * or-stealth-reorg-check -- server-side Bitcoin reorg detector.
 *
 * For every recorded stealth transaction whose block is within
 * REORG_LOOKBACK_BLOCKS of the current chain tip AND whose block_hash IS NOT
 * NULL AND orphaned_at IS NULL, this function fetches the canonical block hash
 * at that height from the block source and compares it to the stored hash. On
 * a mismatch (the block the transaction was recorded in has been replaced by a
 * reorg), orphaned_at is set to now() and the transaction is excluded from
 * every balance and list the customer sees.
 *
 * WHY TWO NUMBERS. The confirmation buffer (6 blocks, in the widget sync path)
 * is PREVENTION: new transactions are not recorded until their block is old
 * enough to be stable. This detector (100 blocks) is DETECTION: it catches
 * reorgs that reach past the buffer. The numbers are deliberately far apart so
 * the single event that defeats the buffer is not also the event that defeats
 * the detector. At 100 the detector covers every reorg ever observed on Bitcoin
 * mainnet by more than an order of magnitude. If they were equal (both 6, say),
 * a 6-block reorg would defeat both in the same event, leaving the customer
 * with a permanently wrong balance and no correction path.
 *
 * HEIGHT 0. The genesis block (height 0) is a Bitcoin sentinel that cannot be
 * reorganised; it is also used in this codebase as a sentinel for "unknown
 * height". Height-0 rows are excluded from the look-back because:
 *   1. The canonical hash at height 0 will never change.
 *   2. A row at height 0 may be an "unknown height" sentinel, not a real block.
 * This decision is written here and in code, not left to fall out of a query.
 *
 * NULL block_hash. A row whose block_hash IS NULL was recorded before this
 * field existed (before PR #1431). It is permanently unverifiable, not an
 * error. Such rows are silently skipped and never flagged as orphaned. This is
 * also written in the reorg-columns migration and in every comment path that
 * touches block_hash.
 *
 * Auth: POST only, X-Internal-Worker-Token checked against the Vault secret
 * or_internal_worker_token (same pattern as or-webhook-dispatch). Never
 * exposed to integrators; invoked by a scheduled cron or by an operator.
 *
 * POST body (all optional):
 *   connection_id:    string (uuid) -- if present, scan only this connection;
 *                                      omit to scan all connections (batch-capped)
 *   block_source_base: string       -- override the block source URL; only
 *                                      accepted when SUPABASE_URL points to
 *                                      localhost (test escape hatch)
 *
 * Response:
 *   { checked: number, orphaned: number, tip: number }
 *
 * OR-T0999 step 9.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { jsonResponse, readBoundedText } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

// The DETECTION side of the two-number reorg design (see file header).
//
// REORG_CONFIRMATION_BUFFER = 6 is the PREVENTION side and lives in the widget
// sync path (src/stealth/lib/sync.ts). It is not imported here because that
// code runs in the browser. The two numbers must not be set equal.
export const REORG_LOOKBACK_BLOCKS = 100;

// Maximum transactions to check in one invocation. If this is hit the caller
// should invoke again; the remaining rows will be checked on the next run.
const BATCH_SIZE = 500;

// The block source that serves canonical block hashes. Used by the live path
// and overridable in tests (via block_source_base in the request body, accepted
// only when SUPABASE_URL points to localhost).
export const DEFAULT_BLOCK_SOURCE_BASE = 'https://blocks.orangerails.com';

/**
 * Sidecar shape served by the block source at /<height>.json.
 * block_hash is lowercase hex, RPC display order (same format as the value
 * stored in stealth_transactions.block_hash).
 */
export interface BlockSidecar {
  block_hash: string;
  block_height: number;
  time: number;
  filter_size: number;
}

/**
 * Fetch the current chain tip height from the block source.
 * Exported for tests that intercept fetch.
 */
export async function fetchChainTip(
  baseUrl: string = DEFAULT_BLOCK_SOURCE_BASE,
): Promise<number> {
  const resp = await fetch(`${baseUrl}/tip`);
  if (!resp.ok) throw new Error(`fetchChainTip failed: ${resp.status}`);
  const j = (await resp.json()) as { height: number };
  return j.height;
}

/**
 * Fetch the canonical block hash at a given height from the block source.
 * Returns null if the fetch fails; the caller skips the row rather than
 * falsely marking it orphaned (a network blip must not corrupt balances).
 * Exported for tests that intercept fetch.
 */
export async function fetchBlockHash(
  height: number,
  baseUrl: string = DEFAULT_BLOCK_SOURCE_BASE,
): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl}/${height}.json`);
    if (!resp.ok) return null;
    const sidecar = (await resp.json()) as BlockSidecar;
    return typeof sidecar.block_hash === 'string' ? sidecar.block_hash : null;
  } catch {
    return null;
  }
}

function makeServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

/** Constant-time string compare. Same implementation as or-webhook-dispatch's. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(wrapSentryHandler(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const serviceClient = makeServiceClient();

    // Auth: X-Internal-Worker-Token (same pattern as or-webhook-dispatch). The
    // token is read via an RPC rather than directly from vault because the vault
    // schema is not exposed over PostgREST in the deployed edge runtime (DL-0599).
    const callerToken = req.headers.get('X-Internal-Worker-Token');
    // deno-lint-ignore no-explicit-any
    const { data: expected, error: vaultErr } = await (serviceClient as any)
      .rpc('get_or_internal_worker_token');
    if (vaultErr) {
      console.error('[or-stealth-reorg-check] vault RPC failed:', vaultErr.code, vaultErr.message);
      return jsonResponse({ error: 'vault read error' }, 503);
    }
    if (!expected) {
      return jsonResponse({ error: 'worker token missing from vault' }, 503);
    }
    if (!callerToken || !timingSafeEqual(callerToken, expected)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    // Parse optional body. Every field is optional; an empty or absent body is fine.
    let connectionId: string | null = null;
    let blockSourceBase = DEFAULT_BLOCK_SOURCE_BASE;
    const raw = await readBoundedText(req);
    if (raw) {
      let body: { connection_id?: unknown; block_source_base?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return jsonResponse({ error: 'Request body is not valid JSON' }, 400);
      }
      if (body.connection_id !== undefined) {
        if (typeof body.connection_id !== 'string' || !UUID_RE.test(body.connection_id)) {
          return jsonResponse({ error: 'connection_id must be a uuid' }, 400);
        }
        connectionId = body.connection_id;
      }
      // block_source_base is a test escape hatch: only accepted when SUPABASE_URL
      // points to localhost. In production the override is silently ignored.
      if (
        body.block_source_base !== undefined &&
        typeof body.block_source_base === 'string' &&
        (Deno.env.get('SUPABASE_URL') ?? '').includes('localhost')
      ) {
        blockSourceBase = body.block_source_base;
      }
    }

    // Get the current chain tip. A fetch failure aborts the whole invocation:
    // without a tip we cannot compute the look-back window, and checking 0
    // transactions is not the same as checking them all and finding 0 orphaned.
    let tip: number;
    try {
      tip = await fetchChainTip(blockSourceBase);
    } catch (e) {
      console.error('[or-stealth-reorg-check] fetchChainTip failed:', e);
      return jsonResponse({ error: 'block source unavailable' }, 503);
    }

    // Build the candidate query.
    //
    // Conditions, and the reason each exists:
    //   orphaned_at IS NULL     -- not already flagged (idempotent)
    //   block_hash IS NOT NULL  -- NULL = pre-feature, permanently unverifiable;
    //                              skipping rather than orphaning is a ruling (ticket)
    //   block_height > 0        -- height 0 is excluded (see file header)
    //   block_height >= lookbackFrom  -- only blocks in the reorg-possible window
    //
    // The look-back is an open upper bound: every block from lookbackFrom to
    // the tip (inclusive) is checked. Blocks older than REORG_LOOKBACK_BLOCKS
    // below tip are treated as immutable: a reorg that deep has never occurred
    // on Bitcoin mainnet and the cost of checking them is real.
    const lookbackFrom = tip - REORG_LOOKBACK_BLOCKS;
    let txQuery = serviceClient
      .from('stealth_transactions')
      .select('id, block_height, block_hash, connection_id')
      .is('orphaned_at', null)
      .not('block_hash', 'is', null)
      .gt('block_height', 0)
      .gte('block_height', lookbackFrom)
      .limit(BATCH_SIZE);

    if (connectionId !== null) {
      txQuery = txQuery.eq('connection_id', connectionId);
    }

    const { data: rows, error: selErr } = await txQuery;
    if (selErr) {
      console.error('[or-stealth-reorg-check] select failed:', selErr);
      return jsonResponse({ error: 'Failed to query transactions' }, 500);
    }

    const txRows = (rows ?? []) as Array<{
      id: string;
      block_height: number;
      block_hash: string;
      connection_id: string;
    }>;

    if (txRows.length === 0) {
      return jsonResponse({ checked: 0, orphaned: 0, tip }, 200);
    }

    // Deduplicate heights so each sidecar is fetched once, even when multiple
    // transactions share the same block (common in wallets with many UTXOs).
    const distinctHeights = [...new Set(txRows.map((r) => r.block_height))];

    // Fetch all canonical hashes in parallel. A null return means the fetch
    // failed for that height: the rows at that height are left unchecked rather
    // than falsely orphaned. A network blip must not corrupt a customer's balance.
    const canonicalHashes = new Map<number, string | null>();
    await Promise.all(
      distinctHeights.map(async (h) => {
        const hash = await fetchBlockHash(h, blockSourceBase);
        canonicalHashes.set(h, hash);
      }),
    );

    // Identify orphaned rows: stored block_hash != canonical hash for that height.
    // Rows where the canonical fetch failed (null) are silently skipped.
    const orphanedIds: string[] = [];
    for (const row of txRows) {
      const canonical = canonicalHashes.get(row.block_height);
      // null means the fetch failed; skip rather than orphan.
      if (canonical === null || canonical === undefined) continue;
      if (row.block_hash !== canonical) {
        orphanedIds.push(row.id);
        console.log(
          `[or-stealth-reorg-check] orphaned tx ${row.id} ` +
          `connection=${row.connection_id} height=${row.block_height} ` +
          `stored=${row.block_hash} canonical=${canonical}`,
        );
      }
    }

    if (orphanedIds.length > 0) {
      // Mark all orphaned rows in one UPDATE. orphaned_at is the only change:
      // sealed_record is kept intact for audit purposes (rows are never deleted,
      // per the irreversibility ruling in the ticket). The IS NULL guard makes
      // this idempotent: a concurrent run cannot double-set orphaned_at or
      // extend it to rows flagged between the SELECT and this UPDATE.
      const now = new Date().toISOString();
      const { error: updErr } = await serviceClient
        .from('stealth_transactions')
        .update({ orphaned_at: now })
        .in('id', orphanedIds)
        .is('orphaned_at', null);
      if (updErr) {
        console.error('[or-stealth-reorg-check] orphan update failed:', updErr);
        return jsonResponse({ error: 'Failed to mark orphaned transactions' }, 500);
      }
    }

    return jsonResponse({ checked: txRows.length, orphaned: orphanedIds.length, tip }, 200);
  } catch (err) {
    console.error('[or-stealth-reorg-check] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500);
  }
}, 'or-stealth-reorg-check'));
