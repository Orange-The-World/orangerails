import { createClient } from "@supabase/supabase-js";

// Primary Supabase client: the Orange Rails signup project (NOT orbi-prod).
// This is the project that owns real user sessions for the beta gate.
// We use email magic-link auth here. The anon key is public by design.
const PRIMARY_URL = import.meta.env.VITE_ORANGERAILS_SUPABASE_URL as string;
const PRIMARY_ANON_KEY = import.meta.env
  .VITE_ORANGERAILS_SUPABASE_ANON_KEY as string;

export const auth = createClient(PRIMARY_URL, PRIMARY_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export type BetaStatus =
  | { state: "loading" }
  | { state: "anonymous" }
  | { state: "pending"; email: string }
  | { state: "approved"; email: string };

// Check the logged in user's own beta_approved_users row. RLS only lets a
// user read their own row, so this returns at most one row.
export async function fetchBetaStatus(): Promise<BetaStatus> {
  const {
    data: { session },
  } = await auth.auth.getSession();
  if (!session?.user?.email) return { state: "anonymous" };

  const email = session.user.email;
  const { data, error } = await auth
    .from("beta_approved_users")
    .select("approved")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    // A read error or missing row means not yet approved, never access.
    return { state: "pending", email };
  }
  if (data?.approved === true) return { state: "approved", email };
  return { state: "pending", email };
}
