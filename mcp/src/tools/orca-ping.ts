/**
 * orca.ping , smoke check tool.
 */

import type { IdentityFile } from '../identity.js';

export interface OrcaPingResult {
  pong: true;
  agent_member_id: string;
  owner_user_id: string;
  display_name: string;
  client_name: string;
  api_base_url: string;
  access_token_expires_at: string;
  server_time: string;
}

export async function orcaPing(identity: IdentityFile): Promise<OrcaPingResult> {
  const introspectionUrl = `${identity.apiBaseUrl}/auth/v1/user`;
  const response = await fetch(introspectionUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${identity.accessToken}`,
      apikey: identity.accessToken,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Token validation failed (HTTP ${response.status}). Token may be expired or revoked. Re-run connect with a fresh invitation token.`,
    );
  }

  return {
    pong: true,
    agent_member_id: identity.agentMemberId,
    owner_user_id: identity.ownerUserId,
    display_name: identity.displayName,
    client_name: identity.clientName,
    api_base_url: identity.apiBaseUrl,
    access_token_expires_at: identity.accessTokenExpiresAt,
    server_time: new Date().toISOString(),
  };
}
