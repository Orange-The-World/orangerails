/**
 * Base error thrown when a webhook signature cannot be verified for any
 * reason. Catch this to handle "the payload should not be trusted".
 */
export class SignatureVerificationError extends Error {
  public readonly code: string;

  constructor(message: string, code = "signature_verification_failed") {
    super(message);
    this.name = "SignatureVerificationError";
    this.code = code;
    // Restore prototype chain (needed when targeting older runtimes).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the v2 signature's timestamp is outside the configured
 * tolerance window. Indicates either a replay attempt or significant
 * clock skew between sender and receiver.
 */
export class TimestampToleranceExceededError extends SignatureVerificationError {
  constructor(message: string) {
    super(message, "timestamp_tolerance_exceeded");
    this.name = "TimestampToleranceExceededError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when neither `X-OR-Signature-V2` nor `X-OR-Signature` headers
 * are present, or when `X-OR-Event-Id` is missing.
 */
export class MissingSignatureError extends SignatureVerificationError {
  constructor(message: string) {
    super(message, "missing_signature");
    this.name = "MissingSignatureError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
