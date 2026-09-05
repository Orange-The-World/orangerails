/**
 * Per-platform Quiltt config resolution with env fallback.
 *
 * OR is the multi-tenant gateway between Bitcoin-native apps and the shared
 * BitBest Quiltt account. Each consumer platform (bitbooks-v2, orangeway-me,
 * orangeway-books, …) picks its own Quiltt Profile, Connectors, and API key
 * by setting columns on its `public.platforms` row.
 *
 * Migration 20260610150000 added the columns; this helper provides a single
 * resolution point so individual edge functions don't reinvent the logic.
 *
 * Resolution order, per field, for each call:
 *   1. `platforms.<column>` if non-NULL (per-platform value)
 *   2. Process env `QUILTT_*` (global fallback during transition)
 *   3. `undefined` — caller decides whether that's fatal
 *
 * The env-fallback path is intentional: it keeps OR backwards-compatible
 * during the multi-tenant transition. Once every consumer platform's row
 * is populated, the env vars can be retired in a follow-up cleanup.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';

export interface PlatformQuilttConfig {
  /** Master API key (Bearer token to Quiltt). */
  apiKey: string;
  /** Connector id for first-time bank linking. */
  connectorIdLink: string;
  /** Connector id for repairing an expired connection. Falls back to LINK. */
  connectorIdReconnect: string;
  /** Catalog Profile id — the rate-limit subject (10/hr, 20/day). May be ''. */
  catalogProfileId: string;
  /** Public half of the API key, used for rotation. May be ''. */
  apiKeyId: string;
  /** Slug of the resolved platform (mostly for logs). */
  platformSlug: string;
  /** Whether each field came from the platform row (true) or env fallback (false). */
  source: {
    apiKey: 'platform' | 'env' | 'missing';
    connectorIdLink: 'platform' | 'env' | 'missing';
    connectorIdReconnect: 'platform' | 'env' | 'missing';
    catalogProfileId: 'platform' | 'env' | 'missing';
  };
}

interface PlatformRow {
  slug: string;
  quiltt_api_key: string | null;
  quiltt_api_key_id: string | null;
  quiltt_connector_id_link: string | null;
  quiltt_connector_id_reconnect: string | null;
  quiltt_catalog_profile_id: string | null;
}

/**
 * Resolve the effective Quiltt config for a given platform id.
 *
 * Reads the platform row via the service-role client, then layers env-var
 * fallback so an empty/NULL column doesn't break a platform that hasn't
 * been backfilled yet.
 */
export async function resolveQuilttConfigForPlatform(
  service: SupabaseClient,
  platformId: string,
): Promise<PlatformQuilttConfig> {
  const { data, error } = await service
    .from('platforms')
    .select(
      'slug, quiltt_api_key, quiltt_api_key_id, quiltt_connector_id_link, quiltt_connector_id_reconnect, quiltt_catalog_profile_id',
    )
    .eq('id', platformId)
    .maybeSingle<PlatformRow>();

  if (error) {
    throw new Error(`platforms lookup failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`platform ${platformId} not found`);
  }

  const envApiKey = Deno.env.get('QUILTT_API_KEY') ?? '';
  const envConnectorIdLink = Deno.env.get('QUILTT_CONNECTOR_ID_LINK') ?? '';
  const envConnectorIdReconnect = Deno.env.get('QUILTT_CONNECTOR_ID_RECONNECT') ?? '';
  const envCatalogProfileId = Deno.env.get('QUILTT_CATALOG_PROFILE_ID') ?? '';

  const apiKey = data.quiltt_api_key ?? envApiKey;
  const connectorIdLink = data.quiltt_connector_id_link ?? envConnectorIdLink;
  const connectorIdReconnect =
    data.quiltt_connector_id_reconnect || envConnectorIdReconnect || connectorIdLink;
  const catalogProfileId = data.quiltt_catalog_profile_id ?? envCatalogProfileId;

  // Fail-loud guard (DL-1402): when neither the per-platform reconnect column
  // nor the env var is set, connectorIdReconnect above silently resolves to the
  // LINK connector. A reconnect that runs on the LINK connector opens a fresh
  // link instead of repairing the existing connection, which mints new account
  // ids and breaks downstream account mapping. Emit a distinct, greppable signal
  // so this is never invisible again. We do not throw: a noisy reconnect is
  // recoverable, a silent one is not, and hard failing here would break every
  // repair on a platform whose reconnect id has not been backfilled yet.
  if (!data.quiltt_connector_id_reconnect && !envConnectorIdReconnect) {
    console.error(
      `[quiltt-config] RECONNECT_FALLBACK_TO_LINK platform=${data.slug} ` +
        `platformId=${platformId}: no per-platform quiltt_connector_id_reconnect ` +
        `and no QUILTT_CONNECTOR_ID_RECONNECT env; reconnect resolved to the LINK ` +
        `connector and may mint new account ids. Backfill the reconnect connector id.`,
    );
  }

  return {
    apiKey,
    connectorIdLink,
    connectorIdReconnect,
    catalogProfileId,
    apiKeyId: data.quiltt_api_key_id ?? '',
    platformSlug: data.slug,
    source: {
      apiKey: data.quiltt_api_key ? 'platform' : (envApiKey ? 'env' : 'missing'),
      connectorIdLink: data.quiltt_connector_id_link
        ? 'platform'
        : (envConnectorIdLink ? 'env' : 'missing'),
      connectorIdReconnect: data.quiltt_connector_id_reconnect
        ? 'platform'
        : (envConnectorIdReconnect ? 'env' : 'missing'),
      catalogProfileId: data.quiltt_catalog_profile_id
        ? 'platform'
        : (envCatalogProfileId ? 'env' : 'missing'),
    },
  };
}

/**
 * Resolve the platform's `sink_format` for or-sync (with body.format fallback
 * for legacy callers like V2 that pre-date the multi-tenant refactor).
 *
 * V2 today still sends `format: 'bitbooks-v2'` in the request body. If the
 * platform row has sink_format populated, server-side resolution wins
 * (defends against a malicious or buggy caller asking for a sink that's not
 * theirs). If the column is NULL (transition state), fall back to body.format.
 */
export async function resolveSinkFormatForPlatform(
  service: SupabaseClient,
  platformId: string,
  bodyFormatFallback?: string | null,
): Promise<string | null> {
  const { data, error } = await service
    .from('platforms')
    .select('sink_format')
    .eq('id', platformId)
    .maybeSingle<{ sink_format: string | null }>();

  if (error) {
    throw new Error(`platforms.sink_format lookup failed: ${error.message}`);
  }

  // 'none' is the explicit no-sink sentinel (OR-T1208): a platform that has
  // deliberately opted out of sink delivery, as opposed to one that has
  // simply never been configured (NULL). or-sync's sink-mode test treats any
  // non-empty string as a format to look up, so the sentinel must resolve to
  // null here, before it ever reaches that check, or a stored 'none' 400s
  // with "Unknown format: none" instead of falling through to the
  // legacy/direct path the platform actually wants.
  //
  // Unlike NULL, 'none' must NOT fall back to bodyFormatFallback. NULL means
  // "never configured", where the body.format fallback exists precisely for
  // pre-multi-tenant callers (V2) that predate this column. 'none' means the
  // platform was explicitly configured to have no sink, and the whole reason
  // this resolver's result is meant to win over body.format is so a caller
  // cannot request a sink shape that is not theirs. Falling back to the body
  // here would let a legacy caller re-arm sink mode on a platform that was
  // just told it does not have one.
  if (data?.sink_format === 'none') {
    return null;
  }

  return data?.sink_format ?? bodyFormatFallback ?? null;
}
