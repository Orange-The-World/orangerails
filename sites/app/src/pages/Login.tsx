import { useState } from "react";
import { supabase } from "@/lib/auth";

const ENV_CONFIGURED = Boolean(
  import.meta.env.VITE_ORANGERAILS_SUPABASE_URL &&
  import.meta.env.VITE_ORANGERAILS_SUPABASE_ANON_KEY
);

export default function Login() {
const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold">Check your email</h2>
          <p className="mt-2 text-slate-600">We sent a sign-in link to {email}.</p>
        </div>
      </div>
    );
  }

  if (!ENV_CONFIGURED) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-orange">Orange Rails</h1>
          <p className="mt-4 text-slate-600">Sign-in is temporarily unavailable, please try again later.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <h1 className="text-3xl font-bold text-orange">Orange Rails</h1>
        <p className="mt-2 text-slate-600">Sign in to your dashboard</p>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="mt-8 w-full px-3 py-2 border border-slate-300 rounded-md"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading || !email}
          className="mt-4 w-full px-4 py-2 bg-orange text-white rounded-md hover:bg-orange-dark font-medium disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send magic link"}
        </button>
      </form>
    </div>
  );
}
