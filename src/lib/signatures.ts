/**
 * Post-quantum signature orchestration.
 *
 * Wraps pqc.ts's ML-DSA-65 primitives behind a strategy-map interface
 * so future algorithms (ML-DSA-87, SLH-DSA) can be added by appending
 * one entry to SIG_STRATEGIES , OCP. Consumers receive a SigStrategy
 * (DIP) rather than depending on a concrete algorithm.
 *
 * Base64 helpers are provided for the common case of reading/writing
 * signatures and public keys directly from Supabase columns.
 */

import { generateSigKeyPair, sign as pqcSign, verify as pqcVerify } from "./pqc";

// ------------------------------------------------------------------
// Strategy contract.
// ------------------------------------------------------------------

export interface SigStrategy {
  readonly algorithm: string;
  sign(secretKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

// ------------------------------------------------------------------
// ML-DSA-65 strategy.
// ------------------------------------------------------------------

const mlDsa65Strategy: SigStrategy = Object.freeze({
  algorithm: "ml-dsa-65",

  async sign(secretKey: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    return pqcSign(secretKey, message);
  },

  async verify(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    return pqcVerify(publicKey, message, signature);
  },
});

// ------------------------------------------------------------------
// Strategy registry , one map, add entries here for new algorithms.
// ------------------------------------------------------------------

export const SIG_STRATEGIES: Readonly<Record<string, SigStrategy>> = Object.freeze({
  "ml-dsa-65": mlDsa65Strategy,
});

export const DEFAULT_SIG_ALGORITHM = "ml-dsa-65";

// ------------------------------------------------------------------
// Re-export so callers that want the raw keygen surface don't have
// to reach into pqc.ts directly.
// ------------------------------------------------------------------

export { generateSigKeyPair } from "./pqc";

// ------------------------------------------------------------------
// Base64 convenience API , sigs and pubkeys live on rows as base64.
// ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SignedPayload {
  signature: string;
  algorithm: string;
}

/** Sign a UTF-8 string; return row-ready base64 + algorithm identifier. */
export async function signToBase64(
  secretKey: Uint8Array,
  messageUtf8: string,
  algorithm: string = DEFAULT_SIG_ALGORITHM,
): Promise<SignedPayload> {
  const strategy = SIG_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown signature algorithm: ${algorithm}`);
  }
  const sig = await strategy.sign(secretKey, new TextEncoder().encode(messageUtf8));
  return { signature: bytesToBase64(sig), algorithm: strategy.algorithm };
}

/** Verify a row-stored base64 public key + signature against a UTF-8 message. */
export async function verifyFromBase64(
  publicKeyB64: string,
  messageUtf8: string,
  signatureB64: string,
  algorithm: string = DEFAULT_SIG_ALGORITHM,
): Promise<boolean> {
  const strategy = SIG_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown signature algorithm: ${algorithm}`);
  }
  return strategy.verify(
    base64ToBytes(publicKeyB64),
    new TextEncoder().encode(messageUtf8),
    base64ToBytes(signatureB64),
  );
}

/** Sign raw bytes; return row-ready base64 + algorithm identifier. */
export async function signBytesToBase64(
  secretKey: Uint8Array,
  messageBytes: Uint8Array,
  algorithm: string = DEFAULT_SIG_ALGORITHM,
): Promise<SignedPayload> {
  const strategy = SIG_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown signature algorithm: ${algorithm}`);
  }
  const sig = await strategy.sign(secretKey, messageBytes);
  return { signature: bytesToBase64(sig), algorithm: strategy.algorithm };
}

/** Verify a row-stored base64 public key + signature against raw bytes. */
export async function verifyBytesFromBase64(
  publicKeyB64: string,
  messageBytes: Uint8Array,
  signatureB64: string,
  algorithm: string = DEFAULT_SIG_ALGORITHM,
): Promise<boolean> {
  const strategy = SIG_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown signature algorithm: ${algorithm}`);
  }
  return strategy.verify(
    base64ToBytes(publicKeyB64),
    messageBytes,
    base64ToBytes(signatureB64),
  );
}
