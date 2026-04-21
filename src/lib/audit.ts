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
 * Non-fatal — a logging failure never breaks the calling flow.
 */
export async function logSecurityEvent(
  supabase: SupabaseClient | { from: (t: string) => unknown },
  userId: string,
  event: SecurityEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await (supabase as SupabaseClient)
      .from("vault_security_events")
      .insert({ user_id: userId, event, metadata: metadata ?? null });
  } catch {
    // Intentionally swallowed — audit log failures must not break auth flows.
  }
}
