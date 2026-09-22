/**
 * or-stealth-reorg-check -- detect and mark reorged transactions for a stealth connection.
 *
 * Called by the widget after or-stealth-envelope-update, once per sync.
 * Non-fatal from the widget's perspective: a failure here must not fail the sync.
 *
 * THE TWO NUMBERS AND WHY THEY ARE DELIBERATELY FAR APART.
 *   CONFIRMATION_BUFFER = 6  (also used by the scan stop, lives in sync.ts)
 *   REORG_LOOKBACK_BLOCKS = 100
 *
 * The buffer is PREVENTION: we never record a transaction whose block is
 * fewer than 6 confirmations deep, matching the long-standing Bitcoin convention
 * covering every mainnet reorg observed since 2013.
 *
 * The look-back is DETECTION: if a transaction we already recorded ever gets
 * reorged out, this function catches it. The two lines of defence must not fail
 * for the same reason. If the look-back were also 6, the one event that defeats
 * the buffer is the same event that defeats the detector and we are back to a
 * silent wrong balance. At 100 the detector is independent in practice: no mainnet
 * reorg has ever exceeded 4 blocks. If 100 hash lookups per sync costs real money
 * against our block source, come back with the MEASURED cost and propose a number
 * on OR-T0999 -- do not quietly shrink it and do not set it equal to 6.
 *
 * HEIGHT 0 DECISION. block_height 0 is used as a sentinel for unknown heights in
 * addition to being the real genesis block. We cannot reliably distinguish a sentinel
 * row from a genuine genesis row, so height 0 rows are excluded from the look-back
 * and treated the same as NULL block_hash rows: not an error, just unverifiable.
 * This decision is written here so the next reader does not have to work it out.
 *
 * NULL block_hash. A NULL block_hash means the record was uploaded before hash
 * capture was added (PR #1431). It is permanently unverifiable. The detector
 * skips these rows in silence -- they are never logged as failures and never marked
 * orphaned_at. OR-T0407 ruling: never delete a customer row, only mark orphaned_at.
 *
 * POST body:
 *   connection_id:  string (uuid, required)
 *   app_user_id:    string (required)
 *   chain_tip:      number (current chain tip height, required)
 *   widget_token:   string (optional, widget mode credential)
 *
 * Response:
 *   { connection_id, checked, orphaned }
 *   checked: number of transactions compared against the canonical chain
 *   orphaned: number of transactions newly marked orphaned_at this call
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import {
  authenticateRequestOrWidgetToken,
  enforceWidgetAppUser,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

/**
 * How many blocks back from the chain tip to check on every sync.
 * Deliberately much larger than the 6-block confirmation buffer: the buffer
 * is prevention, this is detection, and they must not fail for the same reason.
 * See the module comment for the full rationale before changing this number.
 */
export const REORG_LOOKBACK_BLOCKS = 100;

const BLOCK_SOURCE_BASE = 'https://blocks.orangerails.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCK_HASH_RE = /^[0-9a-f]{64}$/;

interface ReorgCheckRequestBody {
  connection_id?: string;
  app_user_id?: string;
  /** Current chain tip height known to the caller. Used to compute the look-back window. */
  chain_tip?: number;
  widget_token?: string;
}

interface BlockSidecar {
  block_hash?: unknown;
  block_height?: unknown;
}

/**
 * Fetch the canonical block hash at a given height from the block source.
 * Returns the lowercase 64-char hex hash, or null when the sidecar is missing
 * or malformed (meaning we cannot verify this height -- caller should skip it).
 */
async function fetchCanonicalBlockHash(height: number): Promise<string | null> {
  try {
    const resp = await fetch(`${BLOCK_SOURCE_BASE}/${height}.json`);
    if (!resp.ok) return null;
    const sidecar = (await resp.json()) as BlockSidecar;
    const raw = sidecar.block_hash;
    if (typeof raw !== 'string' || !BLOCK_HASH_RE.test(raw)) return null;
    return raw.toLowerCase();
  } catch {
    return null;
  }
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    let body: ReorgCheckRequestBody;
    try {
      body = JSON.parse(raw || '{}') as ReorgCheckRequestBody;
    } catch {
      return jsonResponse({ error: 'Request body is not valid JSON' }, 400, cors);
    }

    const ctx = await authenticateRequestOrWidgetToken(req, body.widget_token);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length === 0) {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }
    if (
      body.chain_tip === undefined ||
      typeof body.chain_tip !== 'number' ||
      !Number.isInteger(body.chain_tip) ||
      body.chain_tip < 0
    ) {
      return jsonResponse({ error: 'chain_tip must be a non-negative integer' }, 400, cors);
    }

    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse({ error: 'app_user_id must match the authenticated user' }, 403, cors);
    }
    const widgetUserErr = enforceWidgetAppUser(ctx, body.app_user_id);
    if (widgetUserErr) {
      return jsonResponse({ error: widgetUserErr.message }, widgetUserErr.status, cors);
    }

    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    // Verify connection ownership.
    const { data: ownerRow, error: ownerErr } = await ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_user_id')
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .maybeSingle();
    if (ownerErr) {
      console.error('[or-stealth-reorg-check] owner check failed:', ownerErr);
      return jsonResponse({ error: 'Failed to verify connection' }, 500, cors);
    }
    if (!ownerRow) return jsonResponse({ error: 'Connection not found' }, 404, cors);
    if ((ownerRow.app_user_id as string) !== body.app_user_id) {
      return jsonResponse({ error: 'Connection does not belong to caller' }, 403, cors);
    }

    // Compute the look-back window.  Clamp to 0 so a very young chain cannot
    // produce a negative height.
    const lookbackFrom = Math.max(0, body.chain_tip - REORG_LOOKBACK_BLOCKS);

    // Fetch all transactions in the window that have a stored block_hash and
    // have not already been orphaned.
    //
    // HEIGHT 0 is excluded: it is used as a sentinel for unknown heights and we
    // cannot reliably distinguish a sentinel row from the real genesis block.
    // Treating them as unverifiable (skip silently) is the safe choice.
    //
    // NULL block_hash rows are excluded by the .not('block_hash','is',null) filter:
    // they were recorded before hash capture was added and are permanently
    // unverifiable -- not errors, just not checkable.
    const { data: rows, error: selErr } = await ctx.serviceClient
      .from('stealth_transactions')
      .select('id, block_height, block_hash')
      .eq('connection_id', body.connection_id)
      .is('orphaned_at', null)
      .not('block_hash', 'is', null)
      .gte('block_height', Math.max(1, lookbackFrom))  // > 0 excludes height-0 sentinel
      .lte('block_height', body.chain_tip);

    if (selErr) {
      console.error('[or-stealth-reorg-check] select failed:', selErr);
      return jsonResponse({ error: 'Failed to query transactions' }, 500, cors);
    }

    const candidates = (rows ?? []) as Array<{ id: string; block_height: number; block_hash: string }>;

    if (candidates.length === 0) {
      return jsonResponse({ connection_id: body.connection_id, checked: 0, orphaned: 0 }, 200, cors);
    }

    // Deduplicate block heights so we fetch each sidecar at most once, even
    // when many transactions share the same block.
    const heightSet = new Set(candidates.map((r) => r.block_height));
    const canonicalMap = new Map<number, string | null>();
    await Promise.all(
      Array.from(heightSet).map(async (h) => {
        canonicalMap.set(h, await fetchCanonicalBlockHash(h));
      }),
    );

    // Find rows whose stored hash disagrees with the canonical chain.
    const orphanedIds: string[] = [];
    for (const row of candidates) {
      const canonical = canonicalMap.get(row.block_height);
      if (canonical === null || canonical === undefined) {
        // Could not fetch the canonical hash for this height -- skip this row.
        // A transient fetch error must not orphan a real transaction.
        continue;
      }
      if (row.block_hash !== canonical) {
        orphanedIds.push(row.id);
      }
    }

    let orphaned = 0;
    if (orphanedIds.length > 0) {
      const orphanedAt = new Date().toISOString();
      const { error: updateErr } = await ctx.serviceClient
        .from('stealth_transactions')
        .update({ orphaned_at: orphanedAt })
        .in('id', orphanedIds)
        .is('orphaned_at', null);  // idempotent: do not overwrite an earlier timestamp
      if (updateErr) {
        console.error('[or-stealth-reorg-check] orphan update failed:', updateErr);
        return jsonResponse({ error: 'Failed to mark orphaned transactions' }, 500, cors);
      }
      orphaned = orphanedIds.length;
      console.log(
        `[or-stealth-reorg-check] connection ${body.connection_id}: ` +
        `${orphaned} transaction(s) orphaned at tip ${body.chain_tip}`,
      );
    }

    return jsonResponse(
      { connection_id: body.connection_id, checked: candidates.length, orphaned },
      200, cors,
    );
  } catch (err) {
    console.error('[or-stealth-reorg-check] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-reorg-check'));
