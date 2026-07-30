/**
 * Map a plaintext Strike subscription-failure marker to the customer-facing
 * error copy shown in the app.
 *
 * Strike subscription-register failures are persisted into
 * connections.encrypted_last_error as PLAINTEXT markers by
 * supabase/functions/_shared/providers/strike/queue.ts
 * (strikeSubscriptionErrorMarker), not as ORK ciphertext. The client
 * last-error path runs the vault decrypt on that column, which throws on
 * plaintext, so without this mapping the customer sees a bare
 * "(could not decrypt error)" string instead of an actionable message.
 *
 * Returns the copy for a known marker, or null for anything else so the caller
 * falls through to the normal decrypt path for genuine ciphertext errors.
 *
 * The marker strings below MUST stay in exact sync with
 * strikeSubscriptionErrorMarker on the server. Copy locked by CX Champion
 * (DL-0320).
 */

// Platform-side failures (400 rejected, 429 rate limited, and the catch-all).
// One message, framed as our issue and not the customer's account settings, so
// we do not send the customer chasing a key change they do not need to make.
const STRIKE_PLATFORM_COPY =
  "We could not connect to Strike. This is a platform issue on our end, " +
  "not your account settings. Please try reconnecting once the fix is live.";

export function strikeMarkerToCopy(marker: string): string | null {
  // Scope marker carries a suffix (STRIKE_SCOPE_MISSING_partner.webhooks.manage),
  // so match on the prefix.
  if (marker.startsWith("STRIKE_SCOPE_MISSING")) {
    return (
      "Your Strike API key is missing the webhooks.manage scope. " +
      "Regenerate it with that scope enabled at dashboard.strike.me."
    );
  }
  if (marker === "STRIKE_KEY_INVALID") {
    return "Your Strike API key is invalid. Generate a new one at dashboard.strike.me.";
  }
  if (
    marker === "STRIKE_SUBSCRIPTION_REJECTED" ||
    marker === "STRIKE_RATE_LIMITED" ||
    marker === "STRIKE_SUBSCRIPTION_FAILED"
  ) {
    return STRIKE_PLATFORM_COPY;
  }
  return null;
}

/**
 * Customer-facing copy for the fixed upstream/adapter error taxonomy that
 * or-sync persists into connections.encrypted_last_error as an encrypted
 * `CODE:correlationId` pair (see supabase/functions/or-sync/index.ts and the
 * shared supabase/functions/_shared/error-catalog.ts, which is the source of
 * truth for tone and wording).
 *
 * This mirror exists because the edge catalog is a Deno module under
 * supabase/functions and is not importable into the Vite client build. Keep
 * these strings in sync with ERROR_CATALOG whenever that file changes.
 *
 * We never render the raw code name to the customer: an unmapped code falls
 * back to the generic message. The correlation id is kept visible as an
 * opaque support reference so a customer can quote it.
 */
const UPSTREAM_COPY: Record<string, string> = {
  UPSTREAM_AUTH_FAILED:
    "Your bank disconnected this account. This usually happens when your bank password changed or the connection expired. Reconnect this account to fix it.",
  UPSTREAM_RATE_LIMITED:
    "Your bank is briefly busy and asked us to slow down. This usually clears in 5 to 10 minutes.",
  UPSTREAM_UNAVAILABLE:
    "Your bank's service is temporarily unreachable. Try again in a few minutes.",
  UPSTREAM_BAD_REQUEST:
    "Your bank rejected the sync request. Reconnecting this account usually fixes it.",
  UPSTREAM_PARSE_FAILED:
    "Your bank sent data in a shape we did not expect. This is something we need to fix on our side.",
  ADAPTER_CONFIG_ERROR:
    "This connection is missing some setup. Reconnect it and complete every step of the setup flow.",
  UPSTREAM_OTHER:
    "We hit an unexpected error syncing this account. Try again in a few minutes. If it keeps happening, contact support and quote the reference below.",
};

const GENERIC_UPSTREAM_COPY = UPSTREAM_COPY.UPSTREAM_OTHER;

// Correlation ids are 8 random bytes rendered as lowercase hex (16 chars); see
// randomCorrelationId() in or-sync. We only treat the segment after the colon
// as a reference when it matches that shape, so stray text never becomes a
// fake reference.
const CORRELATION_RE = /^[0-9a-f]{6,}$/i;

/**
 * Map a decrypted upstream last-error (`CODE:correlationId`) to customer copy.
 * Returns a single friendly string; the raw taxonomy code is never shown.
 */
export function upstreamCodeToCopy(decrypted: string): string {
  const value = (decrypted ?? "").trim();
  if (!value) return GENERIC_UPSTREAM_COPY;

  const idx = value.indexOf(":");
  const code = idx >= 0 ? value.slice(0, idx) : value;
  const maybeRef = idx >= 0 ? value.slice(idx + 1).trim() : "";
  const reference = CORRELATION_RE.test(maybeRef) ? maybeRef : "";

  const copy = UPSTREAM_COPY[code] ?? GENERIC_UPSTREAM_COPY;
  return reference ? `${copy} (Reference: ${reference})` : copy;
}
