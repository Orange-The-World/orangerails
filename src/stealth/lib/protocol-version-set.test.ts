import { describe, expect, it } from "vitest";
import {
  STEALTH_PROTOCOL_VERSION,
  STEALTH_SUPPORTED_PROTOCOL_VERSIONS,
} from "@/stealth/lib/postmessage";

// Widen the literal tuple type so the checks compare plain numbers.
const supported: readonly number[] = STEALTH_SUPPORTED_PROTOCOL_VERSIONS;

const BUMP_CHECKLIST_MESSAGE = [
  "The supported protocol version set now has more than one member.",
  "A second version must not ship without the rest of this checklist, in the same change:",
  "(a) The protocol version and the app are recorded, where a person can query them,",
  "at the point the widget accepts an INIT.",
  "(b) The helper and the docs sample choose a version from the advertised set",
  "instead of sending a hard-coded one.",
  "(c) Any intended difference in behaviour between the two versions is declared",
  "explicitly in the compatibility battery (tests/e2e/connect-protocol-compat.spec.ts),",
  "never by editing the battery until it goes green.",
  "When all three are done, update this test to match the new state.",
].join(" ");

describe("stealth protocol version set", () => {
  it("has at most two members and contains the current version", () => {
    expect(supported.length).toBeGreaterThanOrEqual(1);
    expect(supported.length).toBeLessThanOrEqual(2);
    expect(supported).toContain(STEALTH_PROTOCOL_VERSION);
  });

  it("has exactly one member until the bump checklist is satisfied", () => {
    expect(supported.length, BUMP_CHECKLIST_MESSAGE).toBe(1);
  });
});
