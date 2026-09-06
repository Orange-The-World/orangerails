import type { SupabaseClient } from "@supabase/supabase-js";

export type SecurityEventType =
  | "vault_setup"
  | "vault_unlock"
  | "vault_unlock_failed"
  | "vault_recover"
  | "vault_password_changed"
  | "token_rotated"
  | "coadmin_granted"
  | "coadmin_revoked"
  // The owner removed a co-admin from their list WITHOUT removing access.
  // Written when a revocation stopped part way and the owner cleared the
  // leftover entry on its own. It is NOT coadmin_revoked and must never be
  // read as though access was removed: metadata.key_removed says which half
  // of the revocation landed, and false means it was never established
  // whether the stored key is still there.
  | "coadmin_list_entry_cleared";

/**
 * Append a security event to vault_security_events.
 * Non-fatal , a logging failure never breaks the calling flow.
 */
export async function logSecurityEvent(
  supabase: SupabaseClient | { from: (t: string) => unknown },
  userId: string,
  event: SecurityEventType,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { error } = await (supabase as SupabaseClient)
      .from("vault_security_events")
      .insert({ user_id: userId, event, metadata: metadata ?? null });
    if (error) {
      // Supabase returns HTTP errors in the response object, not as thrown
      // exceptions, so a bare catch would miss RLS rejections.
      console.warn("[VaultSecurityAudit] Insert rejected:", event, error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[VaultSecurityAudit] Failed to write event:", event, err);
    return false;
  }
}
