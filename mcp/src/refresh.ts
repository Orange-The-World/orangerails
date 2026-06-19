/**
 * Token refresh , calls or-agent-token-refresh with a fresh signed payload
 * and updates the local identity file with the new access token.
 *
 * The MCP server calls this automatically when the stored access token is
 * within REFRESH_LEAD_SECONDS of expiry.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { readIdentity, writeIdentity, type IdentityFile } from './identity.js';

const REFRESH_LEAD_SECONDS = 120; // refresh if access token expires within 2 minutes

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

/**
 * Sign-and-post refresh against the live Orange Rails endpoint.
 * Returns the updated identity (also persisted to disk).
 */
export async function refreshAccessToken(identity: IdentityFile): Promise<IdentityFile> {
  const timestamp = new Date().toISOString();
  const payload = `or-agent-refresh|${identity.agentMemberId}|${timestamp}`;
  const messageBytes = new TextEncoder().encode(payload);
  const privateKey = base64ToBytes(identity.identityPrivateKey);

  if (privateKey.length !== 32) {
    throw new Error(
      `Stored identity private key is not 32 bytes (got ${privateKey.length}). Re-run connect with a fresh invitation.`,
    );
  }

  const signature = ed25519.sign(messageBytes, privateKey);

  const refreshUrl = `${identity.apiBaseUrl}/functions/v1/or-agent-token-refresh`;
  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_member_id: identity.agentMemberId,
      signed_payload: payload,
      signature: bytesToBase64(signature),
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json())?.error ?? '';
    } catch {
      detail = (await response.text().catch(() => '')) || '';
    }
    throw new Error(`Refresh failed (HTTP ${response.status}): ${detail}`);
  }

  const result = (await response.json()) as {
    access_token: string;
    expires_at: string;
    token_type: string;
  };

  const updated: IdentityFile = {
    ...identity,
    accessToken: result.access_token,
    accessTokenExpiresAt: result.expires_at,
  };
  await writeIdentity(updated);
  return updated;
}

/**
 * If the access token expires within REFRESH_LEAD_SECONDS, refresh it.
 * Otherwise return the identity as-is. Idempotent; safe to call frequently.
 */
export async function ensureFreshToken(identity: IdentityFile): Promise<IdentityFile> {
  const expiresAt = Date.parse(identity.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) {
    // Malformed , try a refresh and hope for the best.
    return refreshAccessToken(identity);
  }
  const msUntilExpiry = expiresAt - Date.now();
  if (msUntilExpiry > REFRESH_LEAD_SECONDS * 1000) {
    return identity;
  }
  return refreshAccessToken(identity);
}

/**
 * Reads identity from disk + refreshes if needed. Used by the CLI `refresh`
 * subcommand and by the MCP server before tool calls.
 */
export async function ensureFreshIdentity(): Promise<IdentityFile> {
  const identity = await readIdentity();
  if (!identity) {
    throw new Error('Not connected. Run "orangerails-mcp connect <invitation-token>" first.');
  }
  return ensureFreshToken(identity);
}
