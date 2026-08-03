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
 * Helpers here resolve a request to one of these two modes and return
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

export type AuthContext = PlatformAuthContext | DirectAuthContext;

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
 * Resolve the subaccount the request is acting on.
 *
 * - Direct mode: subaccount is fixed (the user's own); body's subaccount_id is ignored.
 * - Platform mode: subaccount_id MUST be in the body and MUST belong to the platform.
 */
export async function resolveSubaccount(
  ctx: AuthContext,
  bodySubaccountId: string | undefined,
): Promise<string | AuthError> {
  if (ctx.mode === 'direct') {
    return ctx.subaccountId;
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
 * - Direct mode: returns the id of the 'direct' platform (looked up once).
 *
 * Used by the stealth edge functions (audit 2026-05-16 High #2) to bind
 * every stealth_connections read/write to a real, verified platform id
 * instead of the previously caller-supplied app_slug text field.
 */
export async function getCallerPlatformId(ctx: AuthContext): Promise<string | AuthError> {
  if (ctx.mode === 'platform') return ctx.platformId;
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
