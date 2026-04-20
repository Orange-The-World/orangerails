/**
 * Temporary end-to-end validation panel for the PQC layer.
 *
 * Three checks:
 *   1. Pure in-browser KEM round-trip (generate → encapsulate → decapsulate).
 *   2. Pure in-browser ML-DSA-65 sign/verify + tamper rejection.
 *   3. Full lifecycle: ensurePqcKeypairs writes to user_vault_meta, then
 *      reads the row back and reports public-key base64 lengths.
 *
 * This panel is intentionally scrappy — it's a diagnostic for verifying the
 * PR #20 deployment end-to-end. It can be deleted once the role-scoped-keys
 * feature PR lands with its own integration tests.
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import {
  generateHybridKemKeyPair,
  hybridEncapsulate,
  hybridDecapsulate,
  generateSigKeyPair,
  sign,
  verify,
} from "@/lib/pqc";

type CheckStatus = "pending" | "running" | "ok" | "fail";

interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

const INITIAL_CHECKS: Check[] = [
  { id: "kem", label: "Hybrid KEM round-trip", status: "pending" },
  { id: "dsa", label: "ML-DSA-65 sign / verify / tamper", status: "pending" },
  { id: "ensure", label: "ensurePqcKeypairs writes to user_vault_meta", status: "pending" },
  { id: "verify", label: "DB row has non-null PQC public keys", status: "pending" },
];

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function PqcDebugPanel() {
  const vault = useVault();
  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS);
  const [running, setRunning] = useState(false);

  const setCheck = (id: string, status: CheckStatus, detail?: string) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, status, detail } : c)));
  };

  const run = async () => {
    setRunning(true);
    setChecks(INITIAL_CHECKS);

    // Check 1 — KEM round-trip.
    try {
      setCheck("kem", "running");
      const kp = generateHybridKemKeyPair();
      const { ciphertext, sharedSecret } = hybridEncapsulate(kp.publicKey);
      const recovered = hybridDecapsulate(kp.secretKey, ciphertext);
      if (!bytesEqual(recovered, sharedSecret)) throw new Error("shared-secret mismatch");
      setCheck(
        "kem",
        "ok",
        `pub=${kp.publicKey.length}B sec=${kp.secretKey.length}B ct=${ciphertext.length}B ss=${sharedSecret.length}B`,
      );
    } catch (e) {
      setCheck("kem", "fail", String(e));
      setRunning(false);
      return;
    }

    // Check 2 — DSA sign + verify + tamper.
    try {
      setCheck("dsa", "running");
      const kp = generateSigKeyPair();
      const msg = new TextEncoder().encode("pqc-debug-panel validation");
      const sig = sign(kp.secretKey, msg);
      if (!verify(kp.publicKey, msg, sig)) throw new Error("honest verify returned false");
      const tampered = new Uint8Array(msg);
      tampered[0] ^= 1;
      if (verify(kp.publicKey, tampered, sig)) throw new Error("tampered-message verify was true");
      setCheck("dsa", "ok", `sig=${sig.length}B, tamper rejected`);
    } catch (e) {
      setCheck("dsa", "fail", String(e));
      setRunning(false);
      return;
    }

    // Check 3 — ensurePqcKeypairs against Supabase.
    let userId: string | null = null;
    try {
      setCheck("ensure", "running");
      const {
        data: { session },
      } = await supabase.auth.getSession();
      userId = session?.user?.id ?? null;
      if (!userId) throw new Error("no authenticated session");

      const result = await vault.ensurePqcKeypairs(
        supabase as unknown as Parameters<typeof vault.ensurePqcKeypairs>[0],
        userId,
      );
      setCheck(
        "ensure",
        "ok",
        result.generated ? "generated + published" : "already present (idempotent no-op)",
      );
    } catch (e) {
      setCheck("ensure", "fail", String(e));
      setRunning(false);
      return;
    }

    // Check 4 — read back the row.
    try {
      setCheck("verify", "running");
      const { data, error } = await supabase
        .from("user_vault_meta")
        .select("kem_public_key,sig_public_key,pqc_key_version")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("no user_vault_meta row");
      const kemLen = data.kem_public_key?.length ?? 0;
      const sigLen = data.sig_public_key?.length ?? 0;
      if (kemLen === 0 || sigLen === 0) {
        throw new Error(`row missing keys: kem=${kemLen} sig=${sigLen}`);
      }
      setCheck(
        "verify",
        "ok",
        `kem_pk b64=${kemLen}ch sig_pk b64=${sigLen}ch v${data.pqc_key_version}`,
      );
    } catch (e) {
      setCheck("verify", "fail", String(e));
    }

    setRunning(false);
  };

  return (
    <details className="mt-6 rounded border border-amber-400 bg-amber-50 p-4">
      <summary className="cursor-pointer font-semibold text-amber-900">
        🧪 PQC self-test (temporary — delete after role-scoped-keys PR)
      </summary>
      <div className="mt-3 space-y-2 text-sm">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded bg-amber-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {running ? "Running…" : "Run all checks"}
        </button>
        <ul className="space-y-1 font-mono text-xs">
          {checks.map((c) => {
            const icon =
              c.status === "ok"
                ? "✓"
                : c.status === "fail"
                  ? "✗"
                  : c.status === "running"
                    ? "…"
                    : "·";
            const color =
              c.status === "ok"
                ? "text-green-700"
                : c.status === "fail"
                  ? "text-red-700"
                  : "text-amber-900";
            return (
              <li key={c.id} className={color}>
                <span className="inline-block w-4">{icon}</span> {c.label}
                {c.detail ? <span className="ml-2 opacity-70">— {c.detail}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
