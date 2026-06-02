import { useState } from "react";

const API_BASE = import.meta.env.VITE_ORANGERAILS_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_ORANGERAILS_SUPABASE_ANON_KEY as string;

export default function Signup() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [building, setBuilding] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${API_BASE}/functions/v1/client-signup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify({ email, name, building }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || `signup failed (${resp.status})`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto px-6 py-24 text-center">
        <h2 className="text-2xl font-bold">Check your email</h2>
        <p className="mt-4 text-slate-600">
          We sent a confirmation link to <strong>{email}</strong>. Click it to activate your
          API key.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-6 py-24">
      <h1 className="text-3xl font-bold">Get your free API key</h1>
      <p className="mt-2 text-slate-600">
        Validate your email to access the Truth Data API. Free forever, rate-limited.
      </p>
      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Your name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            What are you building? (optional)
          </label>
          <textarea
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-slate-300 rounded-md"
            placeholder="A chart embedded in my blog, a research notebook, an LLM agent..."
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2 bg-orange text-white rounded-md hover:bg-orange-dark font-medium disabled:opacity-50"
        >
          {loading ? "Sending..." : "Send confirmation email"}
        </button>
      </form>
    </div>
  );
}
