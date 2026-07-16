import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import posthog from "posthog-js";
import {
  initAnalytics,
  identifyUser,
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

      // Every public entry point that can emit, called as the app would call
      // it. capture() is not among them: with an empty event map there is no
      // event name that compiles.
      identifyUser("some-opaque-id");

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

    it("strips every named property while no event contract exists", () => {
      initAnalytics();

      const config = vi.mocked(posthog.init).mock.calls[0][1];
      const sanitize = config?.sanitize_properties;
      expect(typeof sanitize).toBe("function");

      const cleaned = sanitize?.(
        {
          // SDK internal we do want to keep.
          $lib: "web",
          // Nothing below survives. The allowlist is empty until a funnel
          // spec names a property, so a plausible-looking count is stripped
          // exactly like an email is. The URL matters most: a route can carry
          // an account id in the path.
          federation_count: 2,
          email: "someone@example.com",
          $current_url: "https://app.example.com/account/1234",
          $ip: "203.0.113.7",
          account_balance: 100000,
        },
        "some_event",
      );

      expect(cleaned).toEqual({ $lib: "web" });
    });
  });
});
