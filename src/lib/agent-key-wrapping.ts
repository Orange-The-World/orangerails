/**
 * Agent key wrapping , owner-side helper to wrap org data keys for a
 * newly-activated AI agent member.
 *
 * Lifecycle:
 *   1. Owner mints invitation (or-agent-invite-mint)
 *   2. Agent CLI redeems (or-agent-invite-redeem) , agent_members row gains
 *      activated_at + shadow_user_id + identity_pubkey + kem_pubkey
 *   3. Owner's browser detects activation (polling or realtime subscription)
 *   4. THIS MODULE wraps each currently-unlocked org data key for the new
 *      agent's kem_pubkey and inserts new rows in wrapped_data_keys
 *   5. Agent can now decrypt server-returned ciphertext via the standard
 *      wrap-data-key lookup path used by humans
 *
 * The wrap mechanics are identical to the human co-admin flow in
 * `src/lib/co-admin.ts`. We share the underlying primitives in
 * `src/lib/key-wrapping.ts` and `src/lib/pqc.ts`.
 *
 * Threat model: server never sees the unwrapped data key. The owner's
 * browser is the only place where:
 *   - The plaintext data key bytes exist (in memory while vault is unlocked)
 *   - The agent's wrap is computed
 * The server stores only the wrap output (ciphertext) keyed by
 * recipient_user_id = agent.shadow_user_id.
 */

import {
  KEY_WRAP_STRATEGIES,
  DEFAULT_WRAP_ALGORITHM,
  base64ToBytes,
  bytesToBase64,
  type WrapRecipient,
} from "./key-wrapping";

export interface AgentMemberForWrap {
  /** agent_members.id */
  id: string;
  /** agent_members.shadow_user_id , recipient on wrapped_data_keys */
  shadow_user_id: string;
  /** agent_members.kem_pubkey , base64 of the hybrid X25519+ML-KEM-768 public key */
  kem_pubkey: string;
}

export interface DataKeyToWrap {
  /** The id we will use for wrapped_data_keys.data_key_id (UUID, shared across recipients of the same key) */
  data_key_id: string;
  /** The 32-byte raw data key currently in browser memory */
  key_bytes: Uint8Array;
}

export interface WrappedEnvelope {
  data_key_id: string;
  recipient_user_id: string;
  wrapped_ciphertext: string;
  algorithm: string;
}

export interface SupabaseLike {
  from: (table: string) => {
    insert: (
      rows: ReadonlyArray<{
        data_key_id: string;
        recipient_user_id: string;
        wrapped_ciphertext: string;
        algorithm: string;
      }>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
}

/**
 * Wraps each data key for the agent's kem_pubkey and returns the
 * envelopes (NOT yet persisted , caller decides when to insert).
 */
export async function wrapDataKeysForAgent(
  agent: AgentMemberForWrap,
  dataKeys: ReadonlyArray<DataKeyToWrap>,
  algorithm: string = DEFAULT_WRAP_ALGORITHM,
): Promise<WrappedEnvelope[]> {
  if (!agent.kem_pubkey || agent.kem_pubkey.length === 0) {
    throw new Error("agent kem_pubkey is missing , agent must be activated first");
  }
  if (!agent.shadow_user_id) {
    throw new Error("agent shadow_user_id is missing , agent must be activated first");
  }
  if (dataKeys.length === 0) return [];

  const strategy = KEY_WRAP_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`Unknown wrap algorithm: ${algorithm}`);
  }

  const recipientPubkey = base64ToBytes(agent.kem_pubkey);
  // WrapRecipient field names are userId / publicKey , not the snake_case
  // names this file used to use. The KeyWrapStrategy signature is
  //   wrapForRecipient(dataKey: Uint8Array, recipientPublicKey: Uint8Array)
  // so we pass the raw pubkey bytes, not the recipient object.
  const recipient: WrapRecipient = {
    userId: agent.shadow_user_id,
    publicKey: recipientPubkey,
  };

  const envelopes: WrappedEnvelope[] = [];
  for (const dk of dataKeys) {
    if (dk.key_bytes.length !== 32) {
      throw new Error(
        `Data key for ${dk.data_key_id} must be 32 bytes (got ${dk.key_bytes.length}). ` +
          `wrapDataKeysForAgent only supports 32-byte AES data keys.`,
      );
    }
    const wrapped = await strategy.wrapForRecipient(dk.key_bytes, recipient.publicKey);
    envelopes.push({
      data_key_id: dk.data_key_id,
      recipient_user_id: recipient.userId,
      wrapped_ciphertext: bytesToBase64(wrapped),
      algorithm,
    });
  }
  return envelopes;
}

/**
 * Convenience: wrap + persist in one call.
 */
export async function wrapAndStoreForAgent(
  supabase: SupabaseLike,
  agent: AgentMemberForWrap,
  dataKeys: ReadonlyArray<DataKeyToWrap>,
  algorithm: string = DEFAULT_WRAP_ALGORITHM,
): Promise<{ wrapped_count: number }> {
  const envelopes = await wrapDataKeysForAgent(agent, dataKeys, algorithm);
  if (envelopes.length === 0) return { wrapped_count: 0 };

  const { error } = await supabase.from("wrapped_data_keys").insert(
    envelopes.map((e) => ({
      data_key_id: e.data_key_id,
      recipient_user_id: e.recipient_user_id,
      wrapped_ciphertext: e.wrapped_ciphertext,
      algorithm: e.algorithm,
    })),
  );
  if (error) {
    throw new Error(`Failed to insert wrapped_data_keys: ${error.message}`);
  }
  return { wrapped_count: envelopes.length };
}
