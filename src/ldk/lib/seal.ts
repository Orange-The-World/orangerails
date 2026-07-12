/**
 * ZKA boundary for the LDK connector.
 *
 * We do NOT fork the crypto. The sealed-envelope surface is reused verbatim
 * from Stealth Sync (AES-256-GCM, fresh IV per envelope, client-supplied
 * 32-byte key, HMAC-SHA-256 blind index, zero server-side key handling).
 * Re-exporting keeps a single audited implementation so the Sr. Developer
 * reconciliation diff against or-stealth-v1 is trivial.
 */

export {
  sealEnvelope,
  unsealEnvelope,
  blindIndex,
  type SealedEnvelope,
} from "../../stealth/lib/seal";
