/**
 * Orange Rails MCP , connect subcommand.
 *
 * Generates the agent's keypair locally (Ed25519 for signing + X25519 for
 * key wrapping), redeems the invitation via or-agent-invite-redeem, and
 * persists the identity to ~/.orange-rails/identity.json (mode 0600).
 *
 * For v0.1 we use Ed25519 + X25519 only. The hybrid X25519+ML-KEM-768
 * format that the main app uses for users will land in v0.2 once we
 * add the ML-KEM-768 keypair generation here. The server side accepts
 * the X25519-only format for now because the kem_pubkey column does
 * not enforce a specific algorithm at the schema layer.
 *
 * NOTE: this is a security-critical surface. Keep it small. Code review
 * carefully before changing.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { writeIdentity, IdentityFile } from './identity.js';
import { hostname } from 'node:os';

export interface ConnectOptions {
  invitationToken: string;
  apiBaseUrl: string;
  clientName: string;
  agentName?: string;
}

export interface ConnectResult {
  agentMemberId: string;
  ownerUserId: string;
  expiresAt: string;
  identityPath: string;
}

function toBase64(bytes: Uint8Array): string {
  // Standard base64; the server validates either url-safe or standard.
  return Buffer.from(bytes).toString('base64');
}

function isHex64(s: string): boolean {
  return /^[a-f0-9]{64}$/.test(s);
}

export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  if (!isHex64(opts.invitationToken)) {
    throw new Error('Invitation token must be 64 lowercase hex characters');
  }

  // 1. Generate identity keypair (Ed25519).
  const identityPriv = ed25519.utils.randomPrivateKey();
  const identityPub = ed25519.getPublicKey(identityPriv);

  // 2. Generate KEM keypair (X25519). The server stores this in
  //    agent_members.kem_pubkey; the owner's browser will wrap the org
  //    data keys for it.
  const kemPriv = x25519.utils.randomPrivateKey();
  const kemPub = x25519.getPublicKey(kemPriv);

  const identityPubB64 = toBase64(identityPub);
  const kemPubB64 = toBase64(kemPub);

  // 3. Redeem the invitation against the Orange Rails API.
  const redeemUrl = `${opts.apiBaseUrl}/functions/v1/or-agent-invite-redeem`;
  const response = await fetch(redeemUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invitation_token: opts.invitationToken,
      identity_pubkey: identityPubB64,
      kem_pubkey: kemPubB64,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error ?? JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`Redeem failed (HTTP ${response.status}): ${detail}`);
  }

  const redeemBody = (await response.json()) as {
    agent_member_id: string;
    owner_user_id: string;
    access_token: string;
    expires_at: string;
    token_type: string;
  };

  // 4. Persist identity locally (encrypted at rest is a v0.2 goal; for
  //    now we rely on file mode 0600 and the OS user boundary).
  const identity: IdentityFile = {
    version: 1,
    apiBaseUrl: opts.apiBaseUrl,
    agentMemberId: redeemBody.agent_member_id,
    ownerUserId: redeemBody.owner_user_id,
    clientName: opts.clientName,
    displayName: opts.agentName ?? `${opts.clientName} on ${hostname()}`,
    identityPrivateKey: toBase64(identityPriv),
    identityPublicKey: identityPubB64,
    kemPrivateKey: toBase64(kemPriv),
    kemPublicKey: kemPubB64,
    accessToken: redeemBody.access_token,
    accessTokenExpiresAt: redeemBody.expires_at,
    connectedAt: new Date().toISOString(),
  };

  const identityPath = await writeIdentity(identity);

  return {
    agentMemberId: redeemBody.agent_member_id,
    ownerUserId: redeemBody.owner_user_id,
    expiresAt: redeemBody.expires_at,
    identityPath,
  };
}
