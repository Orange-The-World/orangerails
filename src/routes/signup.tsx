import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import { MIN_PASSWORD_LENGTH } from "@/lib/vault";
import { formatError } from "@/lib/format-error";

// ─── Inline password strength scorer ─────────────────────────────────────────
// Entropy-based heuristic that scores passphrases fairly alongside
// character-class passwords. Returns 0-4 matching zxcvbn's scale.

function scoreVaultPassword(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password || password.length < 4) return 0;
  const len = password.length;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  const uniqueRatio = new Set(password).size / len;
  if (uniqueRatio < 0.4) return 0; // heavily repeated chars → floor at 0
  const alphabet =
    (hasLower ? 26 : 0) + (hasUpper ? 26 : 0) + (hasDigit ? 10 : 0) + (hasSymbol ? 20 : 0);
  const entropy = len * Math.log2(Math.max(alphabet, 10));
  if (entropy >= 80 && len >= 14) return 4;
  if (entropy >= 60 && len >= 12) return 3;
  if (entropy >= 40) return 2;
  if (len >= 8) return 1;
  return 0;
}

const SCORE_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;
const SCORE_COLORS = [
  "bg-red-500",
  "bg-orange-400",
  "bg-yellow-400",
  "bg-blue-500",
  "bg-green-500",
] as const;

// ─── Passphrase generator ─────────────────────────────────────────────────────
// Format: "Word-word-NN-word-word-word" — uppercase first letter, 2-digit number
// injected after position 1 so all four character classes are always present.
// 5 words from a 250-word pool + 90 possible numbers ≈ 46 bits of entropy.

const WORDLIST: readonly string[] = [
  "apple","arrow","atlas","badge","barn","beach","bench","blade","blaze","blend",
  "blind","bliss","block","bloom","board","boost","brace","brain","brand","brave",
  "break","brick","brine","brook","brush","cable","cairn","cedar","chalk","chase",
  "check","chord","civic","claim","clamp","clash","clean","clear","click","cliff",
  "clock","cloud","coach","coast","comet","coral","crest","crime","crisp","crown",
  "crypt","cycle","dance","delta","depth","digit","dodge","draft","drain","drama",
  "dream","dress","drift","drill","drink","dune","eagle","earth","elder","elect",
  "elite","ember","epoch","equip","exact","extra","fable","faith","fancy","fault",
  "field","fifth","final","flame","flank","flask","fleet","flesh","flick","flint",
  "flock","floor","flora","flute","force","forge","forum","frame","frank","fresh",
  "frost","fruit","gauge","girth","gland","glide","gloom","gloss","grain","grail",
  "graph","graze","greed","grief","grind","grove","guide","gusto","haven","hazel",
  "heart","hedge","heron","hinge","hoist","honor","horse","hotel","image","index",
  "infer","input","ivory","jewel","judge","juice","jumbo","kayak","kiosk","knife",
  "knoll","label","lance","laser","latch","layer","lease","ledge","lemon","level",
  "light","logic","lotus","lucid","lunar","lyric","magic","manor","maple","march",
  "marsh","mayor","melon","mercy","merit","metal","might","minor","moose","motto",
  "mount","mouse","mulch","mural","nerve","night","noble","north","ocean","ochre",
  "olive","opera","optic","orbit","order","otter","oxide","ozone","panel","party",
  "patch","pause","peace","pearl","perch","phase","pixel","plain","plank","plume",
  "polar","power","press","pride","prime","print","probe","pupil","purge","quail",
  "query","quick","quiet","quota","quote","radar","rally","ranch","range","rapid",
  "raven","reach","realm","rebel","relay","relic","ridge","rifle","rivet","robot",
  "rocky","rouge","round","route","rover","royal","rugby","ruler","saint","sauce",
] as const;

function generatePassphrase(): string {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  const words = Array.from({ length: 5 }, (_, i) => WORDLIST[buf[i] % WORDLIST.length]);
  const num = 10 + (buf[5] % 90); // 10–99
  const first = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return [first, words[1], String(num), words[2], words[3], words[4]].join("-");
}

// ─────────────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/signup")({
  component: SignupPage,
});

type Mode = "loading" | "fresh" | "resume" | "unknown";

function SignupPage() {
  const navigate = useNavigate();
  const { setupVault, ensurePqcKeypairs } = useVault();

  // Mode detection:
  // - 'fresh'   : no session yet. Show the full form (email + both passwords).
  // - 'resume'  : session exists but no user_vault_meta row. Show only vault fields.
  // - 'loading' : checking the session + vault-meta on mount.
  // - 'unknown' : edge case (session exists + vault exists). We redirect to /unlock.
  const [mode, setMode] = useState<Mode>("loading");
  const [resumeEmail, setResumeEmail] = useState<string>(""); // readonly display for resume mode

  const [email, setEmail] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState("");
  const [acknowledgedUnrecoverable, setAcknowledgedUnrecoverable] = useState(false);

  const [generatedPhrase, setGeneratedPhrase] = useState<string | null>(null);
  const [phraseCopied, setPhraseCopied] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce vault password for scoring — keeps UI responsive on fast typing.
  const [debouncedVaultPw, setDebouncedVaultPw] = useState(vaultPassword);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedVaultPw(vaultPassword), 150);
    return () => clearTimeout(t);
  }, [vaultPassword]);

  const vaultScore = useMemo(
    () => (debouncedVaultPw ? scoreVaultPassword(debouncedVaultPw) : null),
    [debouncedVaultPw],
  );

  // On mount: figure out which mode we're in.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setMode("fresh");
        return;
      }

      setResumeEmail(session.user.email ?? "");

      // Check if vault metadata already exists for this user.
      const { data: vaultMeta } = await supabase
        .from("user_vault_meta")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();

      if (vaultMeta) {
        // Already fully set up — send them to unlock.
        setMode("unknown");
        navigate({ to: "/unlock" });
        return;
      }

      // Session but no vault: came back from email verification. Finish vault setup.
      setMode("resume");
    })();
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Vault-password validations apply to both modes.
    if (vaultPassword !== vaultPasswordConfirm) {
      setError("Vault passwords do not match.");
      return;
    }
    if (mode === "fresh" && vaultPassword === accountPassword) {
      setError("Vault password must be different from your account password.");
      return;
    }
    if (vaultScore !== null && vaultScore < 4) {
      setError(
        "Vault password is not strong enough. Use the passphrase generator or combine uppercase, lowercase, numbers, and symbols.",
      );
      return;
    }
    if (!acknowledgedUnrecoverable) {
      setError("You must acknowledge that a lost vault password cannot be recovered.");
      return;
    }

    setSubmitting(true);
    try {
      let userId: string;

      if (mode === "fresh") {
        // Fresh signup path — create auth user + session.
        const { data: signupData, error: signupError } = await supabase.auth.signUp({
          email,
          password: accountPassword,
        });
        if (signupError) throw signupError;
        if (!signupData.session || !signupData.user) {
          throw new Error(
            "No active session after signup. Disable email-confirmation in your Supabase project settings, or contact support.",
          );
        }
        userId = signupData.user.id;
      } else {
        // Resume path — session already exists, just finish the vault.
        // Refresh the JWT first so RLS sees the most recent user state
        // (email confirmation, etc.) — stale JWT would fail auth.uid() checks.
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) throw refreshError;

        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.user?.id) {
          throw new Error("Session lost. Please sign in again.");
        }
        userId = session.user.id;
      }

      // Set up the vault regardless of path.
      const { saltB64, verifierCiphertext, keyVersion } = await setupVault(vaultPassword);

      const { error: metaError } = await supabase.from("user_vault_meta").insert({
        user_id: userId,
        vault_salt: saltB64,
        vault_verifier_ciphertext: verifierCiphertext,
        vault_key_version: keyVersion,
      });
      if (metaError) throw metaError;

      // Generate PQC keypairs (hybrid KEM + ML-DSA-65) on the fresh vault
      // meta row. Blocking here so every new user lands on /app with their
      // PQC material already provisioned — the forthcoming role-scoped keys
      // feature assumes this row is populated.
      await ensurePqcKeypairs(
        supabase as unknown as Parameters<typeof ensurePqcKeypairs>[0],
        userId,
      );

      navigate({ to: "/app" });
    } catch (err) {
      console.error("Signup submit error:", err);
      setError(formatError(err));
      setSubmitting(false);
    }
  }

  if (mode === "loading" || mode === "unknown") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const isResume = mode === "resume";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">
            {isResume ? "Finish setting up your vault" : "Create your OrangeRails account"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isResume
              ? "Your account is verified. Set your vault password to finish."
              : "Zero-knowledge from day one. Your vault password never leaves this browser."}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isResume ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="text-xs text-muted-foreground">Signed in as</div>
              <div className="font-medium">{resumeEmail}</div>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="account-password" className="text-sm font-medium">
                  Account password
                </label>
                <input
                  id="account-password"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Used for signing in. Recoverable via email.
                </p>
              </div>
            </>
          )}

          <div className="space-y-1">
            <label htmlFor="vault-password" className="text-sm font-medium">
              Vault password <span className="text-orange-500">*</span>
            </label>
            <input
              id="vault-password"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <div className="rounded-md border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">What makes a good vault password?</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>At least {MIN_PASSWORD_LENGTH} characters — longer is much stronger</li>
                <li>Mix of uppercase, lowercase, numbers, and symbols</li>
                <li>Or use the passphrase generator below — it's the easiest path to "Very strong"</li>
              </ul>
              <p className="text-orange-600 font-medium">
                We cannot recover this password — there is no reset.
              </p>
            </div>

            {/* Strength bar */}
            {vaultPassword.length > 0 && vaultScore !== null && (
              <div className="space-y-1 pt-1">
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((level) => (
                    <div
                      key={level}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        level <= vaultScore + 1 ? SCORE_COLORS[vaultScore] : "bg-muted"
                      }`}
                    />
                  ))}
                </div>
                <p
                  className={`text-xs font-medium ${
                    vaultScore < 4 ? "text-destructive" : "text-green-600"
                  }`}
                >
                  {SCORE_LABELS[vaultScore]}
                  {vaultScore < 4 && " — needs to reach Very strong"}
                </p>
              </div>
            )}

            {/* Passphrase generator */}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  const phrase = generatePassphrase();
                  setGeneratedPhrase(phrase);
                  setVaultPassword(phrase);
                  setVaultPasswordConfirm(phrase);
                  setPhraseCopied(false);
                }}
                className="text-xs text-primary hover:underline"
              >
                Generate strong passphrase
              </button>
              {generatedPhrase && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(generatedPhrase).then(() => {
                      setPhraseCopied(true);
                      setTimeout(() => setPhraseCopied(false), 2000);
                    });
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {phraseCopied ? "Copied!" : "Copy"}
                </button>
              )}
            </div>
            {generatedPhrase && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
                {generatedPhrase}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="vault-password-confirm" className="text-sm font-medium">
              Confirm vault password
            </label>
            <input
              id="vault-password-confirm"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={vaultPasswordConfirm}
              onChange={(e) => setVaultPasswordConfirm(e.target.value)}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-colors ${
                vaultPasswordConfirm.length === 0
                  ? "border-input"
                  : vaultPassword === vaultPasswordConfirm
                    ? "border-green-500"
                    : "border-destructive"
              }`}
            />
            {vaultPasswordConfirm.length > 0 && (
              <p
                className={`text-xs font-medium ${
                  vaultPassword === vaultPasswordConfirm ? "text-green-600" : "text-destructive"
                }`}
              >
                {vaultPassword === vaultPasswordConfirm ? "✓ Passwords match" : "Passwords do not match"}
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-md border border-orange-500/40 bg-orange-500/5 p-3">
            <input
              id="ack"
              type="checkbox"
              checked={acknowledgedUnrecoverable}
              onChange={(e) => setAcknowledgedUnrecoverable(e.target.checked)}
              className="mt-1"
            />
            <label htmlFor="ack" className="text-xs text-muted-foreground">
              I understand that if I lose my vault password, my encrypted credentials and
              transactions will be permanently unrecoverable. OrangeRails cannot reset a password it
              never stored.
            </label>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting
              ? isResume
                ? "Setting up vault..."
                : "Creating account..."
              : isResume
                ? "Finish setup"
                : "Create account"}
          </button>

          {!isResume && (
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          )}

          {isResume && (
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                setMode("fresh");
              }}
              className="w-full text-sm text-muted-foreground hover:underline"
            >
              Not you? Sign out and start over
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
