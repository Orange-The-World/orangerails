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
