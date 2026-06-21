/**
 * or-platform-bootstrap , single endpoint that returns a consumer's full
 * config blob in one call.
 *
 * Consumers send their API key (either the legacy hex64 format, or the
 * new prefixed format <slug>_<env>_<random>) and get back:
 *
 *   {
 *     supabase_url:        the OR Supabase project this consumer talks to
 *     widget_url:          where the OR Link widget is hosted for them
 *     env:                 live | test | dev
 *     platform_slug:       bbv2 | bbv3 | owm | owb | etc.
 *     app_profile_slug:    which sink config OR uses for this consumer
 *     webhook_secret:      HMAC for verifying inbound webhooks
 *     quiltt:              { connector ids, catalog profile id, ... }
 *     rotated_at:          when the key was last rotated (informational)
 *     ttl_seconds:         how long to cache this response
 *   }
 *
 * The consumer caches the response for ttl_seconds. To flip a consumer
 * from OR DEV to OR PROD, an OR admin updates that consumer's row;
 * the consumer picks up the new config on the next refetch with no
 * code change or env-var edit.
 *
 * Auth: hash the inbound key with SHA-256, look up by api_key_hash.
 * Same algorithm platform-auth.ts uses for every other or-* function,
 * so existing keys (V2's hex64 included) work without rotation.
 *
 * verify_jwt = false in supabase/config.toml , this endpoint is the
 * first call a consumer makes, before it knows its own platform JWT.
 *
 * See also:
 *   supabase/functions/_shared/platform-auth.ts ,   the shared auth helper
 *                                                  every other or-* function uses;
 *                                                  same SHA-256 lookup against
 *                                                  the same api_key_hash column.
 *   supabase/migrations/20260620180000_platform_bootstrap_columns.sql ,
 *                                                  the migration that added the
 *                                                  bootstrap response columns.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-or-api-key, x-platform-api-key, content-type',
  'Access-Control-Max-Age':       '86400',
};

const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS };

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Try to parse the new prefixed format. Returns null for the legacy
// hex64 shape (or anything else); the caller then falls back to a
// pure-hash lookup.
function parsePrefixedKey(key: string): { slug: string; env: string } | null {
  const m = key.match(/^([a-z0-9]{2,8})_(live|test|dev)_[A-Za-z0-9]{24,64}$/);
  if (!m) return null;
  return { slug: m[1], env: m[2] };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: JSON_HEADERS,
    });
  }

  // Accept either header name. X-OR-Api-Key is the new canonical;
  // X-Platform-API-Key is the legacy header platform-auth.ts uses.
  const rawKey =
    req.headers.get('x-or-api-key') ??
    req.headers.get('x-platform-api-key');
  if (!rawKey) {
    return new Response(
      JSON.stringify({ error: 'Missing X-OR-Api-Key header.' }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: 'OR backend misconfigured (no service credentials).' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }

  const service = createClient(supabaseUrl, serviceKey);
  const keyHash = await sha256Hex(rawKey);

  const { data: row, error } = await service
    .from('platforms')
    .select(`
      id, slug, env, status, rotated_at, bootstrap_ttl_seconds,
      widget_url, webhook_secret, app_profile_slug,
      quiltt_api_key, quiltt_api_key_id,
      quiltt_connector_id_link, quiltt_connector_id_reconnect,
      quiltt_catalog_profile_id
    `)
    .eq('api_key_hash', keyHash)
    .maybeSingle();

  // Auth failures collapse to a single opaque envelope. Distinguishing
  // "no row" from "row exists but suspended" from "row exists but the
  // prefixed key segments do not match" would let an attacker enumerate
  // platform slugs and statuses. Keep one shape and one status.
  //
  // Server-side, log the real reason so SOC2 CC6.1 / CC7.2 access-denied
  // queries can still be answered from Supabase function logs. This log
  // line never reaches the client.
  if (error || !row || row.status !== 'active') {
    const reason = error ? 'db_error' : !row ? 'no_row' : 'inactive_status';
    console.log(JSON.stringify({
      event: 'bootstrap_auth_fail',
      reason,
      status: row?.status ?? null,
      slug_prefix: parsePrefixedKey(rawKey)?.slug ?? null,
    }));
    return new Response(
      JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: JSON_HEADERS },
    );
  }

  // Defense in depth: if the inbound key uses the new prefixed format,
  // the prefix slug and env MUST match the row. If they don't, reject;
  // someone is sending a key that decodes to a different platform than
  // the row it actually hashes to (would be a hash collision or a key
  // crafted to mislead routing). Old-format keys skip this check.
  const parsed = parsePrefixedKey(rawKey);
  if (parsed) {
    if (parsed.slug !== row.slug || parsed.env !== row.env) {
      console.log(JSON.stringify({
        event: 'bootstrap_auth_fail',
        reason: 'prefix_mismatch',
        slug: row.slug,
        env: row.env,
        slug_prefix: parsed.slug,
        env_prefix: parsed.env,
      }));
      return new Response(
        JSON.stringify({ error: 'unauthorized' }),
        { status: 401, headers: JSON_HEADERS },
      );
    }
  }

  return new Response(JSON.stringify({
    platform_slug:    row.slug,
    env:              row.env,
    supabase_url:     supabaseUrl,
    widget_url:       row.widget_url ?? 'https://connect.orangerails.com',
    app_profile_slug: row.app_profile_slug ?? row.slug,
    webhook_secret:   row.webhook_secret,
    quiltt: {
      api_key:                   row.quiltt_api_key,
      api_key_id:                row.quiltt_api_key_id,
      connector_id_link:         row.quiltt_connector_id_link,
      connector_id_reconnect:    row.quiltt_connector_id_reconnect,
      catalog_profile_id:        row.quiltt_catalog_profile_id,
    },
    rotated_at:       row.rotated_at,
    ttl_seconds:      row.bootstrap_ttl_seconds ?? 3600,
  }), { status: 200, headers: JSON_HEADERS });
});
