/**
 * Orange Rails, LDK connector type surface.
 *
 * SCAFFOLD, pre-audit. See DESIGN.md. Mirrors the Stealth Sync ZKA boundary
 * (`src/stealth/lib/seal.ts`): the server only ever stores a SealedEnvelope +
 * a blind index. No key material, balances, counterparties, or amounts cross
 * the client boundary in plaintext.
 */

/**
 * The only object the server ever persists for a channel-state backup or a
 * payment record. Same shape as Stealth Sync's SealedEnvelope: AES-256-GCM,
 * fresh IV per envelope, client-supplied 32-byte key. The server cannot
 * decrypt it — there is no decrypt path server-side.
 */
export type SealedEnvelope = {
  /** AES-256-GCM ciphertext (base64). */
  ct: string;
  /** Fresh 96-bit IV per envelope (base64). */
  iv: string;
  /** GCM auth tag (base64), if not appended to ct. */
  tag?: string;
  /** Envelope format version, e.g. 'or-ldk-v1'. */
  v: string;
};

/**
 * Deterministic, non-reversible index the server uses to locate a channel's
 * row without learning the funding outpoint. HMAC-SHA-256 over the stable
 * channel key (funding outpoint), keyed by a client-derived index key.
 *
 * TRADE-OFF (stated, gated): keying the index on the funding outpoint means
 * per-channel update cadence (timing + frequency) is observable to our
 * servers even though all payloads are sealed. Bounded and accepted; no
 * balances, counterparties, or amounts leak. (DESIGN.md §3.)
 */
export type BlindIndex = string;

/**
 * One row in the `channel_state` table. The server holds exactly these three
 * meaningful columns (+ updated_at). `sealedBlob` is opaque ciphertext.
 */
export type ChannelStateRecord = {
  /** Blind index of the funding outpoint. Primary key. */
  outpointBidx: BlindIndex;
  /** LDK ChannelMonitor monotonic update_id. The correctness watermark. */
  updateId: number;
  /** Client-sealed ChannelMonitor blob. Opaque to the server. */
  sealedBlob: SealedEnvelope;
};

/**
 * Result of a persist attempt, classified from the atomic upsert's RETURNING
 * result. See DESIGN.md §3 (Developer msg 921, Auditor msg 924).
 *
 *   ACCEPTED       row returned                -> new latest
 *   IDEMPOTENT_OK  no row + stored = :new_id    -> legit persist-before-ack retry
 *   REJECTED_STALE no row + stored > :new_id    -> rollback/restore race
 *
 * Only strictly-less-than is a reject. Equal is always success, so a
 * persist-before-ack retry after a crash never wedges the node.
 */
export type PersistOutcome =
  | { kind: 'ACCEPTED'; updateId: number }
  | { kind: 'IDEMPOTENT_OK'; updateId: number }
  | { kind: 'REJECTED_STALE'; storedUpdateId: number };
