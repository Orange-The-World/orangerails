/**
 * Orange Rails MCP , identity persistence.
 *
 * Stores at $HOME/.orange-rails/identity.json with mode 0600.
 *
 * Threat model for v0.1:
 *   - Defends against: other users on the same machine reading the file
 *     (mode 0600), accidental backup of plaintext keys (mode 0600 is
 *     respected by most backup tools).
 *   - Does NOT defend against: malware running as the same OS user.
 *     Operating system keychain integration is a v0.2 goal (Keychain on
 *     macOS, DPAPI on Windows, libsecret on Linux). Until then, anyone
 *     who can read your home directory can decrypt the data the agent
 *     could decrypt.
 *   - Aligns with the founder's principle (Decision 8): credentials live
 *     on the user's laptop. Threat model documented honestly.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface IdentityFile {
  version: 1;
  apiBaseUrl: string;
  agentMemberId: string;
  ownerUserId: string;
  clientName: string;
  displayName: string;
  identityPrivateKey: string; // base64 Ed25519 secret
  identityPublicKey: string; // base64 Ed25519 public
  kemPrivateKey: string; // base64 X25519 secret
  kemPublicKey: string; // base64 X25519 public
  accessToken: string;
  accessTokenExpiresAt: string;
  connectedAt: string;
}

function identityDir(): string {
  return join(homedir(), '.orange-rails');
}

export function identityPath(): string {
  return join(identityDir(), 'identity.json');
}

export async function writeIdentity(identity: IdentityFile): Promise<string> {
  const dir = identityDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Ensure the directory itself is private (mkdir mode may be masked).
  await fs.chmod(dir, 0o700).catch(() => {});

  const path = identityPath();
  // Write to a temp file then rename for atomicity.
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600).catch(() => {});
  return path;
}

export async function readIdentity(): Promise<IdentityFile | null> {
  const path = identityPath();
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) {
      throw new Error(`Unknown identity file version: ${parsed?.version}`);
    }
    return parsed as IdentityFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

export async function deleteIdentity(): Promise<boolean> {
  try {
    await fs.unlink(identityPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}
