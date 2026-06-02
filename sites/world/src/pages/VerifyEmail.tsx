import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

const API_BASE = import.meta.env.VITE_ORANGERAILS_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_ORANGERAILS_SUPABASE_ANON_KEY as string;
const APP_URL = import.meta.env.VITE_APP_URL || "https://app.orangerails.com";

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    const token = params.get("token");
    if (!token) {
      setStatus("error");
      setErrorMsg("Missing token in verification link");
      return;
    }

    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/functions/v1/client-verify-email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${ANON_KEY}`,
          },
          body: JSON.stringify({ token }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `verify failed (${resp.status})`);
        }
        setApiKey(data.api_key);
        setStatus("success");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Verification failed");
        setStatus("error");
      }
    })();
  }, [params]);

  if (status === "pending") {
    return <div className="text-center py-24 text-slate-600">Verifying...</div>;
  }

  if (status === "error") {
    return (
      <div className="max-w-md mx-auto px-6 py-24 text-center">
        <h2 className="text-2xl font-bold text-red-700">Verification failed</h2>
        <p className="mt-4 text-slate-600">{errorMsg}</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-6 py-24">
      <h1 className="text-3xl font-bold">You're in.</h1>
      <p className="mt-2 text-slate-600">
        Save this API key now. We'll never show it again.
      </p>
      <pre className="mt-6 p-4 bg-slate-100 border border-slate-200 rounded-md text-sm break-all font-mono">
        {apiKey}
      </pre>
      <div className="mt-6 p-4 bg-orange/5 border border-orange/20 rounded-md text-sm">
        <p className="font-medium">Try it now:</p>
        <pre className="mt-2 overflow-x-auto text-xs">{`curl -H "Authorization: Bearer ${apiKey}" \\
  "${API_BASE}/functions/v1/world-gateway/bitcoin-network?limit=5"`}</pre>
      </div>
      <p className="mt-6 text-sm text-slate-500">
        Manage your account at{" "}
        <a href={APP_URL} className="text-orange underline">
          app.orangerails.com
        </a>
        . Use the same email to sign in.
      </p>
    </div>
  );
}
