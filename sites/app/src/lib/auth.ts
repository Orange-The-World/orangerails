import { createContext, useContext, useEffect, useState, ReactNode, createElement } from "react";
import { createClient, Session, User } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_ORANGERAILS_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_ORANGERAILS_SUPABASE_ANON_KEY as string;

const ENV_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabase: ReturnType<typeof createClient>;
if (ENV_CONFIGURED) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
} else {
  // Stub so callers that import supabase at module level don't crash.
  // All actual auth calls are guarded by ENV_CONFIGURED checks.
  supabase = createClient("https://placeholder.supabase.co", "placeholder-key", {
    auth: { persistSession: false },
  });
}
export { supabase };

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  configured: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ENV_CONFIGURED) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthContextValue = {
    user: session?.user ?? null,
    session,
    loading,
    configured: ENV_CONFIGURED,
    signOut: async () => {
      if (ENV_CONFIGURED) await supabase.auth.signOut();
    },
  };
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
