import type { SupabaseClient } from "@supabase/supabase-js";

export type SecurityEventType =
  | "vault_setup"
  | "vault_unlock"
  | "vault_unlock_failed"
  | "vault_recover"
  | "vault_password_changed"
  | "token_rotated"
  | "coadmin_granted"
  | "coadmin_revoked";

/**
 * Append a security event to vault_security_events.
 * Non-fatal , a logging failure never breaks the calling flow.
 */
export async function logSecurityEvent(
  supabase: SupabaseClient | { from: (t: string) => unknown },
  userId: string,
  event: SecurityEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await (supabase as SupabaseClient)
      .from("vault_security_events")
      .insert({ user_id: userId, event, metadata: metadata ?? null });
    if (error) {
      // Supabase returns HTTP errors in the response object, not as thrown
      // exceptions, so a bare catch would miss RLS rejections.
      console.warn("[VaultSecurityAudit] Insert rejected:", event, error);
    }
  } catch (err) {
    console.warn("[VaultSecurityAudit] Failed to write event:", event, err);
  }
}
