/**
 * Shared platform-mode auth helpers.
 *
 * Two auth modes are supported across or-* edge functions:
 *
 * 1. Platform mode , `X-Platform-API-Key: <hex64>` header.
 *    Used by integrating apps (third-party platforms, future
 *    SaaS apps). Platform looks up its own subaccounts; subaccount_id
 *    is required in the request body.
 *
 * 2. Direct mode , standard Supabase JWT in `Authorization: Bearer`.
 *    Used by orangerails.com/app consumer users (Individual / Team /
 *    Business pricing tiers). Subaccount is auto-resolved via
 *    get_or_create_direct_subaccount() RPC.
 *
 * 3. Widget mode , `widget_token` in the request BODY, not a header.
 *    Used by browser code running inside a host app's connect session.
 *    See authenticateWidgetToken for why the other two modes cannot
 *    serve that caller and what this one does and does not prove.
 *
 * Helpers here resolve a request to one of these modes and return
 * a unified `AuthContext` that downstream edge functions consume.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';

export interface PlatformAuthContext {
  mode: 'platform';
  platformId: string;
  platformSlug: string;
  serviceClient: SupabaseClient;
}

export interface DirectAuthContext {
  mode: 'direct';
  userId: string;
  subaccountId: string;
  serviceClient: SupabaseClient;
}

/**
 * Widget mode. The caller is browser code inside a host app's connect
 * session, holding a widget_token its backend minted via or-link-mint-token.
 *
 * platformId and appUserId are read OFF THE TOKEN ROW, never off the request
 * body. A widget-mode caller therefore cannot name a platform or a user; it
 * can only be the one the token was minted for.
 */
export interface WidgetAuthContext {
  mode: 'widget';
  platformId: string;
  /** The app_user_id the token was minted for. Opaque host-app identifier. */
  appUserId: string;
  serviceClient: SupabaseClient;
}

export type AuthContext = PlatformAuthContext | DirectAuthContext | WidgetAuthContext;

export interface AuthError {
  status: number;
  message: string;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

/**
 * Resolve the request to either platform or direct mode.
 * Returns AuthError if neither succeeds.
 */
export async function authenticateRequest(req: Request): Promise<AuthContext | AuthError> {
  const platformKey = req.headers.get('X-Platform-API-Key');
  const authHeader = req.headers.get('Authorization');

  // Platform mode takes precedence , explicit header.
  if (platformKey) {
    const serviceClient = makeServiceClient();
    const keyHash = await sha256Hex(platformKey);
    const { data: platform, error } = await serviceClient
      .from('platforms')
      .select('id, slug')
      .eq('api_key_hash', keyHash)
      .maybeSingle();
    if (error || !platform) {
      return { status: 401, message: 'Invalid platform API key' };
    }
    return {
      mode: 'platform',
      platformId: platform.id as string,
      platformSlug: platform.slug as string,
      serviceClient,
    };
  }

  // Direct mode , Supabase JWT.
  if (authHeader) {
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 401, message: 'Invalid Supabase JWT' };
    }
    const serviceClient = makeServiceClient();
    // Resolve (creating if necessary) the user's direct subaccount.
    const { data: subaccountId, error: rpcErr } = await serviceClient.rpc('get_or_create_direct_subaccount', {});
    if (rpcErr) {
      // Fallback: do the lookup ourselves with service-role.
      const { data: directPlatform } = await serviceClient
        .from('platforms').select('id').eq('slug', 'direct').maybeSingle();
      if (!directPlatform) return { status: 500, message: 'Direct platform not configured' };

      const { data: existing } = await serviceClient
        .from('subaccounts').select('id')
        .eq('platform_id', directPlatform.id).eq('external_user_id', user.id)
        .maybeSingle();
      let resolvedId = existing?.id;
      if (!resolvedId) {
        const { data: created, error: insErr } = await serviceClient
          .from('subaccounts')
          .insert({ platform_id: directPlatform.id, external_user_id: user.id })
          .select('id').single();
        if (insErr || !created) return { status: 500, message: 'Could not create subaccount' };
        resolvedId = created.id;
      }
      return { mode: 'direct', userId: user.id, subaccountId: resolvedId, serviceClient };
    }
    return {
      mode: 'direct',
      userId: user.id,
      subaccountId: subaccountId as string,
      serviceClient,
    };
  }

  return { status: 401, message: 'Missing X-Platform-API-Key or Authorization header' };
}

/**
 * A widget_token is the primary key of a pending_widget_sessions row, which is
 * a uuid. Postgres raises 22P02 on a malformed uuid, which would surface as a
 * 500 and tell an attacker their input reached the database. Screen the shape
 * here so anything that is not a uuid is simply an invalid token.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a widget_token to the platform and host-app user it was minted for.
 *
 * WHY THIS MODE EXISTS. Neither existing mode can authenticate browser code
 * acting for a host app's user:
 *
 *   - Platform mode needs the platform API key. A browser must never hold it.
 *   - Direct mode needs an OrangeRails Supabase JWT. A host app's user has no
 *     OrangeRails account, so there is no such JWT, and the app_user_id could
 *     never equal an OrangeRails user id even if there were.
 *
 * The host app's backend already mints a widget_token server-to-server via
 * or-link-mint-token before opening the connect widget. That token is the
 * only credential the browser legitimately holds, and it is exactly the one
 * or-discover-wallets and or-link-complete already authenticate with today.
 *
 * WHAT IT PROVES: that a backend holding this platform's API key minted a
 * session for this app_user_id, within the last few minutes, and that the
 * session has not been marked used. Both identities come off the row, so the
 * caller cannot assert either one.
 *
 * WHAT IT DOES NOT PROVE: that the human in front of the browser is that user.
 * The token is a bearer credential. Anyone who obtains it before it expires
 * can act as that user on that platform. That is the same exposure
 * or-discover-wallets already accepts, and it is bounded by the mint TTL
 * (or-link-mint-token: 300s default, 900s maximum).
 *
 * NOT CONSUMED, deliberately. `used_at` is left null so one connect session
 * can make the several calls a single user action needs (create, then fetch,
 * store and cursor-update during the scan that follows). This mirrors
 * or-discover-wallets, which validates without consuming so the same token
 * still authenticates the or-link-complete that follows it, and leaves
 * single-use enforcement to the terminal call.
 *
 * The replay window is therefore the token's remaining TTL rather than one
 * request. Scoped as it is to a single platform and a single app_user_id, a
 * replay can only redo that user's own action on their own platform, and on
 * the stealth create path the blind-index dedup makes a repeat idempotent.
 *
 * @param token  Raw widget_token from the request body.
 */
export async function authenticateWidgetToken(
  token: unknown,
): Promise<WidgetAuthContext | AuthError> {
  if (typeof token !== 'string' || !UUID_RE.test(token)) {
    return { status: 401, message: 'Invalid widget token' };
  }
  const serviceClient = makeServiceClient();
  const { data: session, error } = await serviceClient
    .from('pending_widget_sessions')
    .select('id, platform_id, app_user_id')
    .eq('id', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  // One message for every failure. Expired, spent, forged and never-existed
  // must be indistinguishable, or the response tells an attacker which
  // tokens are real.
  if (error) {
    console.error('[platform-auth] widget token lookup error:', error.message);
    return { status: 401, message: 'Invalid widget token' };
  }
  if (!session) {
    return { status: 401, message: 'Invalid widget token' };
  }
  return {
    mode: 'widget',
    platformId: session.platform_id as string,
    appUserId: session.app_user_id as string,
    serviceClient,
  };
}

/**
 * Resolve a request that may authenticate by header OR by a body widget_token.
 *
 * Precedence is deliberate and preserves every existing caller:
 *
 *   1. `X-Platform-API-Key` present  -> platform mode. Server-to-server always
 *      wins, and a platform key is never weakened by anything in the body.
 *   2. no platform key, widget_token present -> widget mode.
 *   3. otherwise -> authenticateRequest, i.e. Supabase JWT or a 401.
 *
 * No caller sends widget_token to these endpoints today, so branch 2 is
 * unreachable for existing traffic and branches 1 and 3 are byte-for-byte the
 * behaviour that shipped before.
 *
 * There is no fallback from a FAILED header auth to the body token. A bad
 * platform key is an error worth surfacing, not a reason to retry as somebody
 * with fewer privileges.
 */
export async function authenticateRequestOrWidgetToken(
  req: Request,
  widgetToken: unknown,
): Promise<AuthContext | AuthError> {
  if (req.headers.get('X-Platform-API-Key')) {
    return await authenticateRequest(req);
  }
  if (widgetToken !== undefined && widgetToken !== null) {
    return await authenticateWidgetToken(widgetToken);
  }
  return await authenticateRequest(req);
}

/**
 * Assert that a widget-mode caller is acting on its own app_user_id.
 *
 * The stealth endpoints already lock direct mode this way. Widget mode needs
 * the same lock for the same reason: the token pins one app_user_id, so a body
 * naming a different one is an attempt to write to another user's records.
 *
 * Returns null when the request is allowed.
 */
export function enforceWidgetAppUser(
  ctx: AuthContext,
  bodyAppUserId: string | undefined,
): AuthError | null {
  if (ctx.mode !== 'widget') return null;
  if (bodyAppUserId !== ctx.appUserId) {
    return { status: 403, message: 'app_user_id must match the widget session' };
  }
  return null;
}

/**
 * Resolve the subaccount the request is acting on.
 *
 * - Direct mode: subaccount is fixed (the user's own); body's subaccount_id is ignored.
 * - Platform mode: subaccount_id MUST be in the body and MUST belong to the platform.
 * - Widget mode: REFUSED. Widget mode exists for the stealth endpoints, which
 *   key on (platform_id, app_user_id) and have no subaccount. A
 *   WidgetAuthContext also carries a platformId, so without this guard it
 *   would fall into the platform branch and silently resolve a subaccount
 *   against a caller that was never entitled to name one.
 */
export async function resolveSubaccount(
  ctx: AuthContext,
  bodySubaccountId: string | undefined,
): Promise<string | AuthError> {
  if (ctx.mode === 'direct') {
    return ctx.subaccountId;
  }
  if (ctx.mode === 'widget') {
    return {
      status: 403,
      message: 'Widget-token callers cannot act on a subaccount',
    };
  }
  if (!bodySubaccountId) {
    return { status: 400, message: 'subaccount_id required in platform mode' };
  }
  const { data: row, error } = await ctx.serviceClient
    .from('subaccounts')
    .select('id, platform_id')
    .eq('id', bodySubaccountId)
    .maybeSingle();
  if (error || !row) return { status: 404, message: 'Subaccount not found' };
  if (row.platform_id !== ctx.platformId) {
    // Don't leak existence , same 404 message.
    return { status: 404, message: 'Subaccount not found' };
  }
  return row.id as string;
}

export function isAuthError(x: AuthContext | AuthError | string): x is AuthError {
  return typeof x === 'object' && 'status' in x && 'message' in x;
}

/**
 * Resolve the platform id that owns the calling context.
 *
 * - Platform mode: returns ctx.platformId directly.
 * - Widget mode: returns the platform the token was minted for. That id came
 *   off the pending_widget_sessions row, so it is as verified as the platform
 *   key that minted it, and the caller never named it.
 * - Direct mode: returns the id of the 'direct' platform (looked up once).
 *
 * Used by the stealth edge functions (audit 2026-05-16 High #2) to bind
 * every stealth_connections read/write to a real, verified platform id
 * instead of the previously caller-supplied app_slug text field.
 */
export async function getCallerPlatformId(ctx: AuthContext): Promise<string | AuthError> {
  if (ctx.mode === 'platform') return ctx.platformId;
  if (ctx.mode === 'widget') return ctx.platformId;
  const { data, error } = await ctx.serviceClient
    .from('platforms')
    .select('id')
    .eq('slug', 'direct')
    .maybeSingle();
  if (error || !data) {
    return { status: 500, message: 'Direct platform not configured' };
  }
  return data.id as string;
}
