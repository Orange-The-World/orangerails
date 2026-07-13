import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import posthog from "posthog-js";
import {
  initAnalytics,
  identifyUser,
  trackSignup,
  trackFirstSync,
  __isAnalyticsInitialized,
  __resetAnalyticsForTests,
} from "./analytics";

vi.mock("posthog-js", () => ({
  default: {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  },
}));

describe("analytics", () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("dark by default", () => {
    it("does not initialise the SDK when no key is set", () => {
      vi.stubEnv("VITE_POSTHOG_KEY", "");

      initAnalytics();

      expect(posthog.init).not.toHaveBeenCalled();
      expect(__isAnalyticsInitialized()).toBe(false);
    });

    it("emits nothing when the SDK was never initialised", () => {
      vi.stubEnv("VITE_POSTHOG_KEY", "");
      initAnalytics();

      // Every public entry point, called as the app would call it.
      identifyUser("some-opaque-id");
      trackSignup();
      trackFirstSync(3);

      expect(posthog.capture).not.toHaveBeenCalled();
      expect(posthog.identify).not.toHaveBeenCalled();
    });
  });

  describe("when a key is present", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_POSTHOG_KEY", "phc_test_key_not_a_real_project");
      vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.i.posthog.com");
    });

    it("initialises with observation turned off", () => {
      initAnalytics();

      expect(posthog.init).toHaveBeenCalledTimes(1);
      const config = vi.mocked(posthog.init).mock.calls[0][1];

      expect(config?.autocapture).toBe(false);
      expect(config?.capture_pageview).toBe(false);
      expect(config?.disable_session_recording).toBe(true);
      expect(config?.property_denylist).toContain("$ip");
      expect(config?.property_denylist).toContain("$current_url");
    });

    it("reads the api host from the environment rather than hardcoding it", () => {
      initAnalytics();

      const config = vi.mocked(posthog.init).mock.calls[0][1];
      expect(config?.api_host).toBe("https://eu.i.posthog.com");
    });

    it("strips any property that is not on the contract", () => {
      initAnalytics();

      const config = vi.mocked(posthog.init).mock.calls[0][1];
      const sanitize = config?.sanitize_properties;
      expect(typeof sanitize).toBe("function");

      const cleaned = sanitize?.(
        {
          federation_count: 2,
          // Nothing below is on the contract. None of it may survive.
          email: "someone@example.com",
          $current_url: "https://app.example.com/account/1234",
          account_balance: 100000,
        },
        "bb_first_sync",
      );

      expect(cleaned).toEqual({ federation_count: 2, $current_url: "https://app.example.com/account/1234" });
      expect(cleaned).not.toHaveProperty("email");
      expect(cleaned).not.toHaveProperty("account_balance");
    });

    it("emits only the contract properties on a signup", () => {
      initAnalytics();
      trackSignup();

      expect(posthog.capture).toHaveBeenCalledWith("bb_signup", {
        plan_type: "free",
      });
    });
  });
});
