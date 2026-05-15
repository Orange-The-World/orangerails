import { useEffect, useState } from "react";
import { fetchProviderCatalog, countLive } from "@/lib/providers";

const FALLBACK = "100+";
const DEADLINE_MS = 200;

function format(n: number): string {
  return n >= 100 ? `${n}+` : String(n);
}

/**
 * Renders the live count of `status: "live"` providers from `or-providers`.
 *
 * Strategy: render the fallback string immediately so there's no skeleton or
 * spinner. If the fetch resolves before DEADLINE_MS, swap in the live number.
 * If it takes longer, the fallback stays — we don't want layout shift after
 * the user has started reading. If the fetch fails, fallback stays.
 */
export function LiveConnectionCount() {
  const [label, setLabel] = useState<string>(FALLBACK);

  useEffect(() => {
    let canceled = false;
    let resolved = false;

    const deadline = window.setTimeout(() => {
      // After deadline, don't accept any later resolution.
      canceled = true;
    }, DEADLINE_MS);

    fetchProviderCatalog()
      .then((catalog) => {
        resolved = true;
        if (canceled) return;
        const n = countLive(catalog.providers);
        if (n > 0) setLabel(format(n));
      })
      .catch(() => {
        // Silent — fallback stays.
      })
      .finally(() => {
        if (!resolved) {
          // Fetch settled after deadline; do nothing.
        }
        window.clearTimeout(deadline);
      });

    return () => {
      canceled = true;
      window.clearTimeout(deadline);
    };
  }, []);

  // aria-live="off" so screen readers don't read the fallback then re-announce
  // a different number a moment later.
  return (
    <span aria-live="off" className="tabular-nums">
      {label}
    </span>
  );
}
