/**
 * Tests for src/lib/strike-error-copy.ts , strikeMarkerToCopy.
 *
 * The marker strings under test mirror strikeSubscriptionErrorMarker in
 * supabase/functions/_shared/providers/strike/queue.ts. If that function's
 * markers change, these tests (and the mapping) must change with them.
 */

import { describe, it, expect } from "vitest";
import { strikeMarkerToCopy } from "../strike-error-copy";

describe("strikeMarkerToCopy: customer-key failures give an action", () => {
  it("STRIKE_KEY_INVALID tells the customer to generate a new key", () => {
    const copy = strikeMarkerToCopy("STRIKE_KEY_INVALID");
    expect(copy).toBe(
      "Your Strike API key is invalid. Generate a new one at dashboard.strike.me.",
    );
  });

  it("the real suffixed scope marker maps to the scope message", () => {
    // queue.ts emits STRIKE_SCOPE_MISSING_partner.webhooks.manage, not the bare
    // prefix, so the mapping must match on the prefix.
    const copy = strikeMarkerToCopy("STRIKE_SCOPE_MISSING_partner.webhooks.manage");
    expect(copy).toBe(
      "Your Strike API key is missing the webhooks.manage scope. " +
        "Regenerate it with that scope enabled at dashboard.strike.me.",
    );
  });
});

describe("strikeMarkerToCopy: platform failures share one non-blaming message", () => {
  const platformMarkers = [
    "STRIKE_SUBSCRIPTION_REJECTED",
    "STRIKE_RATE_LIMITED",
    "STRIKE_SUBSCRIPTION_FAILED",
  ];

  for (const marker of platformMarkers) {
    it(`${marker} frames the failure as a platform issue`, () => {
      const copy = strikeMarkerToCopy(marker);
      expect(copy).toBe(
        "We could not connect to Strike. This is a platform issue on our end, " +
          "not your account settings. Please try reconnecting once the fix is live.",
      );
    });
  }

  it("all three platform markers return the exact same string", () => {
    const copies = platformMarkers.map(strikeMarkerToCopy);
    expect(new Set(copies).size).toBe(1);
  });
});

describe("strikeMarkerToCopy: non-markers fall through", () => {
  it("returns null for a value that is not a Strike marker", () => {
    // A genuine ORK ciphertext (base64-ish) must not be swallowed here; null
    // lets the caller run the normal decrypt path.
    expect(strikeMarkerToCopy("AQID.someBase64Ciphertext==")).toBeNull();
    expect(strikeMarkerToCopy("")).toBeNull();
    expect(strikeMarkerToCopy("SOME_OTHER_ERROR")).toBeNull();
  });
});
