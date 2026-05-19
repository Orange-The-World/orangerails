# @orangerails/mcp

The Orange Rails MCP server — connects AI agents to your private data with zero knowledge encryption.

Status: **v0.1 (scaffold)**. The `connect` command works end to end. The MCP server itself (`start` subcommand) is on the roadmap for v0.2.

## What this is

The npm package that runs on the user's machine and lets an AI agent (Claude Code, Claude Desktop, Cursor, etc.) act as a first-class member of the user's Orange Rails org.

The package:

1. Generates the agent's cryptographic identity locally (Ed25519 + X25519)
2. Redeems an invitation token issued by the org owner
3. Persists the agent identity to `~/.orange-rails/identity.json` (mode 0600)
4. (v0.2) Runs an MCP server that exposes Orange Rails tools to the local MCP client

Design refs:
- [02 Architecture — Agent as Employee](https://wiki.abascal.ca/doc/02-proposed-architecture-agent-as-employee-Ga7ngrjhkO)
- [05 MCP Tool Catalog](https://wiki.abascal.ca/doc/05-mcp-tool-catalog-v1-books-domain-rewexRn6Sb)

## Install

```
npm install -g @orangerails/mcp
```

Or run with no install:

```
npx @orangerails/mcp connect <invitation-token>
```

## Quick start

1. Owner clicks "Invite agent" in the Orange Rails dashboard → copies the one-time invitation token (64 hex characters).
2. On the agent's machine, the owner runs:

   ```
   npx @orangerails/mcp connect <invitation-token>
   ```

3. The CLI generates a keypair, redeems the invitation, and persists identity to `~/.orange-rails/identity.json`.
4. (v0.2) Run `orangerails-mcp start` to expose the MCP server over stdio. The MCP client (Claude Code, etc.) talks to it through pipes. No network involved on the local hop.

## Commands

### `connect <invitation-token>`

Redeem an invitation and persist the agent identity.

Options:
- `--api-url <url>` — Orange Rails API base URL. Defaults to `https://api.orangerails.com`.
- `--client <name>` — Local MCP client to configure. Defaults to `claude_code`. Options: `claude_code`, `claude_desktop`, `chatgpt`, `cursor`, `continue`, `cline`, `custom`.
- `--name <text>` — Display name for this agent. Defaults to `<client> on <hostname>`.

### `status`

Show the current identity (read only). Tells you which agent member you're connected as and when the access token expires.

### `start`

(Not yet implemented. v0.2.) Run the MCP server over stdio.

## Identity file

Stored at `~/.orange-rails/identity.json` with mode 0600 on Unix.

The file contains:
- `identityPrivateKey` (Ed25519 secret) and `identityPublicKey`
- `kemPrivateKey` (X25519 secret) and `kemPublicKey`
- `accessToken` (Supabase JWT, 1h TTL)
- `agentMemberId`, `ownerUserId`, `apiBaseUrl`, `displayName`

**Threat model**: defends against other OS users on the same machine reading the file (mode 0600). Does NOT defend against malware running as the same OS user. OS keychain integration (macOS Keychain / Windows DPAPI / Linux libsecret) is a v0.2 goal.

## License

Apache-2.0
