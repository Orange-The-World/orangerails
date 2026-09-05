/**
 * @orangerails/webhooks
 *
 * Typed signature verification for Orange Rails webhook deliveries.
 * One SDK consumed by third-party platforms and Orange Way
 * so all three receivers verify identically.
 */

export {
  constructEvent,
  type ConstructEventOptions,
  type WebhookHeaders,
} from "./construct-event";

export {
  SignatureVerificationError,
  TimestampToleranceExceededError,
  MissingSignatureError,
} from "./errors";

export type {
  Event,
  SyncCompletedEvent,
  ConnectionDataAvailableEvent,
  EventType,
} from "./types";

// Low-level primitives , exported for advanced use cases (e.g. signing
// in fixtures/tests). Most consumers should use `constructEvent`.
export { computeHmacSha256Hex, timingSafeEqualHex } from "./verify";
