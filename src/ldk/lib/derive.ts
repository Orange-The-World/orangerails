/**
 * Client-side key derivation for the LDK connector.
 *
 * Mirrors Stealth Sync's derive.ts / deriveOrStealthKey pattern. All key
 * material is derived and held on the user's device; nothing here ever
 * runs server-side and no salt is ever issued by the server.
 *
 * Backup/seal key: HKDF-SHA256 from the client MEK with the fixed info
 * string 'or-ldk-v1', domain-separated from any signing key. Deterministic
 * for a given MEK so restore reproduces the same key with zero server input.
 */

const LDK_INFO = "or-ldk-v1" as const;
const KEY_LEN = 32; // bytes; AES-256 seal key

/**
 * Derive the 32-byte LDK seal key from the client master encryption key (MEK).
 * Returns standard base64 so it drops straight into seal.ts (sealEnvelope/blindIndex).
 *
 * @param mek 32-byte master encryption key, client-held, never transmitted.
 */
export async function deriveOrLdkKey(mek: Uint8Array): Promise<string> {
  if (mek.length !== KEY_LEN) {
    throw new Error(`MEK must be ${KEY_LEN} bytes, got ${mek.length}`);
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(mek),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0), // no server salt — client-only, deterministic
      info: new TextEncoder().encode(LDK_INFO),
    },
    baseKey,
    KEY_LEN * 8,
  );
  return b64encode(new Uint8Array(bits));
}

/**
 * TODO(scaffold): channel / keysend parameter parsing (the LDK analogue of
 * Stealth Sync's descriptor parsing). Not part of the ZKA persistence gate.
 */
export function parseChannelParams(_raw: string): never {
  throw new Error("parseChannelParams: not implemented (scaffold)");
}

// ─── Internals (shared shape with stealth/lib) ───────────────────────────

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
