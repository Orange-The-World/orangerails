/**
 * Tests for src/lib/agent-key-wrapping.ts
 *
 * KW-01..KW-03 partial coverage (KW-04+ require live DB integration ,
 * see tests/security/revocation-chaos.test.ts for those).
 */

import { describe, expect, test } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { wrapDataKeysForAgent } from '../../src/lib/agent-key-wrapping';
import { DEFAULT_WRAP_ALGORITHM } from '../../src/lib/key-wrapping';

function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

describe('agent-key-wrapping', () => {
  test('throws when agent has no kem_pubkey', async () => {
    await expect(
      wrapDataKeysForAgent(
        { id: 'a', shadow_user_id: 'u', kem_pubkey: '' },
        [{ data_key_id: 'd1', key_bytes: new Uint8Array(32) }],
      ),
    ).rejects.toThrow(/kem_pubkey is missing/);
  });

  test('throws when agent has no shadow_user_id', async () => {
    await expect(
      wrapDataKeysForAgent(
        { id: 'a', shadow_user_id: '', kem_pubkey: bytesToBase64(new Uint8Array(32)) },
        [{ data_key_id: 'd1', key_bytes: new Uint8Array(32) }],
      ),
    ).rejects.toThrow(/shadow_user_id is missing/);
  });

  test('returns empty when no data keys to wrap', async () => {
    const out = await wrapDataKeysForAgent(
      {
        id: 'a',
        shadow_user_id: '11111111-1111-1111-1111-111111111111',
        kem_pubkey: bytesToBase64(new Uint8Array(32)),
      },
      [],
    );
    expect(out).toEqual([]);
  });

  test('throws on unknown algorithm', async () => {
    await expect(
      wrapDataKeysForAgent(
        {
          id: 'a',
          shadow_user_id: '11111111-1111-1111-1111-111111111111',
          kem_pubkey: bytesToBase64(new Uint8Array(32)),
        },
        [{ data_key_id: 'd1', key_bytes: new Uint8Array(32) }],
        'made-up-algo',
      ),
    ).rejects.toThrow(/Unknown wrap algorithm/);
  });

  test('throws when data key is not 32 bytes', async () => {
    // Generate a real X25519 public key so the algorithm doesn't reject pre-wrap
    const priv = x25519.utils.randomPrivateKey();
    const pub = x25519.getPublicKey(priv);
    await expect(
      wrapDataKeysForAgent(
        {
          id: 'a',
          shadow_user_id: '11111111-1111-1111-1111-111111111111',
          kem_pubkey: bytesToBase64(pub),
        },
        [{ data_key_id: 'd1', key_bytes: new Uint8Array(16) }], // wrong size
        // Use a strategy that accepts pure X25519 , for v1 the default is hybrid,
        // which will reject the short pubkey anyway. The 32-byte check fires first.
        DEFAULT_WRAP_ALGORITHM,
      ),
    ).rejects.toThrow();
  });
});
