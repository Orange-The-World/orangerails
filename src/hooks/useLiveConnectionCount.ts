import { useEffect, useState } from "react";

/**
 * Live count of source providers exposed by the OR backend.
 *
 * Hits the public `or-providers` edge function (no auth) and returns
 * the number of `status: "live"` entries in the manifest. Falls back to
 * the hardcoded value if the fetch fails or hasn't resolved yet, so the
 * landing page never renders a loading state for a hero number.
 *
 * Why a hook over a top-level constant: the manifest grows as new
 * adapters land. We want the public site to reflect that without a
 * redeploy. Cached for the session — one fetch per page load.
 */
export function useLiveConnectionCount(fallback = 100): { count: number; isLive: boolean } {
  const [count, setCount] = useState(fallback);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const baseUrl = import.meta.env.VITE_SUPABASE_URL;
    if (!baseUrl) return;

    const controller = new AbortController();
    const url = baseUrl.replace(/\/$/, "") + "/functions/v1/or-providers";

    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.providers) return;
        const live = data.providers.filter((p: { status?: string }) => p.status === "live").length;
        if (live > 0) {
          setCount(live);
          setIsLive(true);
        }
      })
      .catch(() => {
        // Fail silently; fallback already rendered.
      });

    return () => controller.abort();
  }, []);

  return { count, isLive };
}

/**
 * Format a connection count for hero display. We round down to the
 * nearest 10 and append a plus, so 102 reads as "100+", 137 reads as
 * "130+". Keeps the headline stable as the count grows by ones.
 */
export function formatConnectionCount(count: number): string {
  if (count < 10) return String(count);
  const rounded = Math.floor(count / 10) * 10;
  return rounded + "+";
}
