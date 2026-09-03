/**
 * or-stealth-envelope-fetch , return a SealedEnvelope by connection_id.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * The widget popup calls this at the start of a sync to retrieve the
 * sealed xpub envelope, which it then decrypts in the user's browser.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string (uuid)
 *   app_slug:      string (optional, used as defense-in-depth filter)
 *
 * Response:
 *   { connection_id, sealed_envelope, connection_kind,
 *     wallet_birthday_plaintext, last_block_scanned, last_sync_at, status,
 *     scan_ranges }
 *
 * scan_ranges is the connection's recorded block coverage, the read side of
 * migration 20260821000000. It is returned rather than reduced to a single
 * resume height on purpose: the resume rule is anchored at the wallet birthday
 * height, and that height is derived in the browser by resolving the birthday
 * out of the SEALED envelope. This function does not know it and would have to
 * be told it to do the reduction here. Sending the intervals instead keeps the
 * computation with the only party that already holds both halves.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import {
  authenticateRequestOrWidgetToken,
  enforceWidgetAppUser,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface EnvelopeFetchRequestBody {
  connection_id?: string;
  app_user_id?: string;
  app_slug?: string;
  /**
   * Widget-mode credential. Present when the caller is browser code inside a
   * host app's connect session and holds neither a platform API key nor an
   * OrangeRails JWT. Ignored when X-Platform-API-Key is present.
   */
  widget_token?: string;
}

interface EnvelopeFetchResponseBody {
  connection_id: string;
  sealed_envelope: unknown;
  connection_kind: 'xpub_stealth' | 'descriptor_stealth';
  wallet_birthday_plaintext: string | null;
  last_block_scanned: number | null;
  last_sync_at: string | null;
  status: 'active' | 'error' | 'archived';
  /**
   * Recorded block coverage for this connection, ascending by from_height.
   * An empty array means "no coverage recorded". Null means the coverage read
   * FAILED and the coverage is unknown; the caller must keep using its cursor
   * rather than treat unknown as empty.
   */
  scan_ranges: Array<{ from_height: number; to_height: number }> | null;
}

/**
 * Upper bound on intervals returned. record_stealth_scan_range() merges
 * adjacent and overlapping writes, so a healthy connection holds a handful.
 * The cap exists so that a connection which somehow accumulates pathological
 * fragmentation degrades into a slower resume rather than an unbounded
 * response body. Hitting it is logged, because it would mean the merge in the
 * writer is not doing its job and that is worth knowing about.
 */
const MAX_SCAN_RANGES = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Length of a canonical UUID in its hyphenated 8-4-4-4-12 form. */
const UUID_LENGTH = 36;

/**
 * True only for a canonical UUID, and for nothing else.
 *
 * WHY THE LENGTH CHECK IS NOT REDUNDANT. JavaScript has no end-of-string
 * anchor. Without the m flag, `$` matches at the end of the string OR
 * immediately before a final newline, so the pattern above alone accepts a
 * 37-character value that is a UUID followed by "\n". The length check is
 * what makes this exact.
 */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && v.length === UUID_LENGTH && UUID_RE.test(v);
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    // The body is read BEFORE auth because a widget-mode caller presents its
    // credential in the body rather than in a header. Header-based callers are
    // resolved exactly as before; see authenticateRequestOrWidgetToken.
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    // Parsing now happens before authentication, so malformed JSON from an
    // unauthenticated caller must answer 400 rather than fall through to the
    // catch below and answer 500.
    let body: EnvelopeFetchRequestBody;
    try {
      body = JSON.parse(raw || '{}') as EnvelopeFetchRequestBody;
    } catch {
      return jsonResponse({ error: 'Request body is not valid JSON' }, 400, cors);
    }

    const ctx = await authenticateRequestOrWidgetToken(req, body.widget_token);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    if (!isUuid(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }

    // Direct mode: the authenticated user must own this connection.
    // Platform mode: trust the caller's app_user_id (platform has its own
    // mapping back to its end users; we just route by it).
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    // Widget mode gets the same lock for the same reason: the token pins one
    // app_user_id, so a body naming a different one is an attempt to reach
    // into another user's records.
    const widgetUserErr = enforceWidgetAppUser(ctx, body.app_user_id);
    if (widgetUserErr) {
      return jsonResponse({ error: widgetUserErr.message }, widgetUserErr.status, cors);
    }

    // Audit 2026-05-16 High #2: every stealth_connections read/write must be
    // bound to the calling platform. Resolve once here.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    let query = ctx.serviceClient
      .from('stealth_connections')
      .select(
        'id, app_slug, connection_kind, sealed_envelope, wallet_birthday_plaintext, last_block_scanned, last_sync_at, status, app_user_id',
      )
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .eq('app_user_id', body.app_user_id);
    if (body.app_slug) {
      query = query.eq('app_slug', body.app_slug);
    }
    const { data: row, error: selErr } = await query.maybeSingle();

    if (selErr) {
      console.error('[or-stealth-envelope-fetch] select failed:', selErr);
      return jsonResponse({ error: 'Failed to load stealth connection' }, 500, cors);
    }
    if (!row) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    // Coverage map. A failure here must not fail the whole fetch: without it
    // the widget falls back to the legacy last_block_scanned cursor, which is
    // exactly the behaviour that shipped before this field existed. Losing the
    // improvement is acceptable; losing the ability to sync is not.
    //
    // On failure this stays null rather than becoming an empty array, and the
    // difference is load-bearing. An empty array is a truthful statement that
    // this connection has no recorded coverage, and the widget answers it by
    // resuming at the wallet birthday. Null means the coverage is UNKNOWN, and
    // the only safe answer to unknown is the cursor the widget already had. If
    // these two collapsed into one value, a transient read error would silently
    // restart the scan at the birthday.
    let scanRanges: Array<{ from_height: number; to_height: number }> | null = [];
    const { data: rangeRows, error: rangeErr } = await ctx.serviceClient
      .from('stealth_scan_ranges')
      .select('from_height, to_height')
      .eq('connection_id', row.id)
      .order('from_height', { ascending: true })
      .limit(MAX_SCAN_RANGES);
    if (rangeErr) {
      console.error('[or-stealth-envelope-fetch] scan range read failed:', rangeErr);
      scanRanges = null;
    } else if (rangeRows) {
      scanRanges = rangeRows.map((r) => ({
        from_height: r.from_height as number,
        to_height: r.to_height as number,
      }));
      if (scanRanges.length === MAX_SCAN_RANGES) {
        console.warn(
          '[or-stealth-envelope-fetch] scan range cap hit for connection',
          row.id,
          '-- the writer should have merged these; resume may start further back than necessary',
        );
      }
    }

    const resp: EnvelopeFetchResponseBody = {
      connection_id: row.id as string,
      sealed_envelope: row.sealed_envelope,
      connection_kind: row.connection_kind as 'xpub_stealth' | 'descriptor_stealth',
      wallet_birthday_plaintext: (row.wallet_birthday_plaintext as string | null) ?? null,
      last_block_scanned: (row.last_block_scanned as number | null) ?? null,
      last_sync_at: (row.last_sync_at as string | null) ?? null,
      status: row.status as 'active' | 'error' | 'archived',
      scan_ranges: scanRanges,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-envelope-fetch] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-envelope-fetch'));

export type { EnvelopeFetchRequestBody, EnvelopeFetchResponseBody };
