/**
 * AES-256-GCM helpers for the edge functions. THIS IS THE CANONICAL COPY.
 *
 * WHY THIS MODULE EXISTS (DEV-0271)
 *
 * base64ToBytes / importAesKey / decryptAes were copied into three edge
 * functions, with a comment in one of them saying they would be shared "once a
 * util module lands". They had already diverged before that happened:
 * or-discover-wallets imported the user's unlock key with an `encrypt` usage it
 * never used, while or-connection-delete, doing the same job, asked for
 * `decrypt` only.
 *
 * That divergence was harmless in itself and the more important half is what it
 * showed: three copies with no statement of which one is canonical. This module
 * is that statement. Add a caller here, not a fourth copy.
 *
 * TWO PROPERTIES THIS MODULE HOLDS, AND WHY THEY ARE SEPARATE
 *
 *   extractable = false   the key BYTES can never be exported back out.
 *   usages = ['decrypt']  the key HANDLE cannot be used to encrypt.
 *
 * The first does not imply the second. A non extractable handle that still
 * carries `encrypt` can produce ciphertext that opens under the user's own
 * key, so least privilege on the handle is a separate control and it is cheap.
 * `usages` is a parameter rather than a constant because or-sync genuinely does
 * encrypt (encrypted_last_error), so that caller asks for it explicitly instead
 * of every caller inheriting it.
 *
 * MIGRATION STATE, stated so nobody assumes: or-discover-wallets and
 * or-connection-delete are on this module. or-sync still carries its own copy
 * and moving it is a separate change, because it needs the encrypt usage and it
 * is the live sync path.
 *
 * WIRE FORMAT: a ciphertext is base64 of `iv || ciphertext||tag`, with a 12
 * byte IV prefix. All three copies agreed on this and it is unchanged.
 */

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Import a base64 AES-256 key.
 *
 * Non extractable always: there is no caller in this codebase that may export a
 * user's unlock key back to plaintext, so that is not a parameter.
 *
 * Decrypt only unless a caller states otherwise. Pass ['encrypt', 'decrypt']
 * only from a function that actually encrypts, and say in the call site why.
 */
export async function importAesKey(
  base64Key: string,
  usages: KeyUsage[] = ['decrypt'],
): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    usages,
  );
}

/** Decrypt base64 `iv || ciphertext` produced with a 12 byte IV prefix. */
export async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
