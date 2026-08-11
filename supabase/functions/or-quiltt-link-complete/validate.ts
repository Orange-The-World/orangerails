/**
 * Pure validation helpers for or-quiltt-link-complete.
 *
 * Extracted from index.ts so both index.ts and validate.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 */

export const ENCRYPTED_LABEL_MAX = 4096;

export interface SourceWalletInput {
  external_wallet_id?: unknown;
  is_synced?: unknown;
  encrypted_metadata?: unknown;
}

export interface LinkCompleteBody {
  platform_slug?: unknown;
  app_user_id?: unknown;
  widget_token?: unknown;
  encrypted_label?: unknown;
  quiltt_connection_id?: unknown;
  accounts?: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export function validateBody(body: LinkCompleteBody): ValidationResult {
  if (!body.platform_slug || typeof body.platform_slug !== 'string') {
    return { ok: false, status: 400, error: 'platform_slug required' };
  }
  if (
    !body.app_user_id ||
    typeof body.app_user_id !== 'string' ||
    (body.app_user_id as string).length > 256
  ) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  // widget_token absence is an auth failure (401), not a bad-request (400).
  if (!body.widget_token || typeof body.widget_token !== 'string') {
    return { ok: false, status: 401, error: 'widget_token required' };
  }
  if (body.encrypted_label !== undefined) {
    if (
      typeof body.encrypted_label !== 'string' ||
      (body.encrypted_label as string).length > ENCRYPTED_LABEL_MAX
    ) {
      return { ok: false, status: 400, error: 'encrypted_label must be base64 ciphertext <=4 KB' };
    }
  }
  if (body.quiltt_connection_id !== undefined) {
    if (
      typeof body.quiltt_connection_id !== 'string' ||
      (body.quiltt_connection_id as string).length > 256
    ) {
      return { ok: false, status: 400, error: 'quiltt_connection_id must be a string <=256 chars' };
    }
  }
  if (body.accounts !== undefined) {
    if (!Array.isArray(body.accounts)) {
      return { ok: false, status: 400, error: 'accounts must be an array' };
    }
    if ((body.accounts as unknown[]).length > 50) {
      return { ok: false, status: 400, error: 'accounts: max 50 entries per connection' };
    }
    for (const acc of body.accounts as SourceWalletInput[]) {
      if (
        !acc.external_wallet_id ||
        typeof acc.external_wallet_id !== 'string' ||
        (acc.external_wallet_id as string).length > 256
      ) {
        return {
          ok: false,
          status: 400,
          error: 'accounts[].external_wallet_id required (string, <=256 chars)',
        };
      }
      if (typeof acc.is_synced !== 'boolean') {
        return { ok: false, status: 400, error: 'accounts[].is_synced required (boolean)' };
      }
      if (
        !acc.encrypted_metadata ||
        typeof acc.encrypted_metadata !== 'string' ||
        (acc.encrypted_metadata as string).length > 65536
      ) {
        return {
          ok: false,
          status: 400,
          error: 'accounts[].encrypted_metadata required (base64 ciphertext, <=64 KB)',
        };
      }
    }
  }
  return { ok: true };
}
