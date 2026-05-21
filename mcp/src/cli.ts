#!/usr/bin/env node
/**
 * Orange Rails MCP — CLI entrypoint.
 *
 * Usage:
 *   orangerails-mcp connect <invitation-token>
 *   orangerails-mcp status
 *   orangerails-mcp start
 *
 * Identity is stored at $HOME/.orange-rails/identity.json (mode 0600).
 */

import { connect } from './connect.js';
import { readIdentity } from './identity.js';
import { startStdioServer } from './server.js';

const SUBCOMMANDS = ['connect', 'status', 'start'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function printHelp(): void {
  console.log(
    [
      'Orange Rails MCP — connect AI agents to your private data.',
      '',
      'Usage:',
      '  orangerails-mcp connect <invitation-token> [--api-url <url>] [--client <name>]',
      '  orangerails-mcp status',
      '  orangerails-mcp start',
      '',
      'Options for connect:',
      '  --api-url <url>     Override Orange Rails API base URL.',
      '                      Defaults to https://api.orangerails.com',
      '  --client <name>     Which local MCP client to configure (claude_code,',
      '                      claude_desktop, cursor, continue, cline, custom).',
      '                      Defaults to claude_code.',
      '  --name <text>       Display name for this agent.',
      '',
      'Identity is stored at $HOME/.orange-rails/identity.json (mode 0600).',
    ].join('\n'),
  );
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

async function main(): Promise<number> {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    printHelp();
    return 0;
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}`);
    printHelp();
    return 2;
  }

  switch (subcommand as Subcommand) {
    case 'connect': {
      const invitationToken = rest[0];
      if (!invitationToken || invitationToken.startsWith('--')) {
        console.error('connect requires an invitation token as the first argument');
        return 2;
      }
      const flags = parseFlags(rest.slice(1));
      try {
        const result = await connect({
          invitationToken,
          apiBaseUrl: flags['api-url'] ?? 'https://api.orangerails.com',
          clientName: flags['client'] ?? 'claude_code',
          agentName: flags['name'],
        });
        console.log('');
        console.log('✓ Connected as agent member', result.agentMemberId);
        console.log('  Owner user id:', result.ownerUserId);
        console.log('  Access token expires at:', result.expiresAt);
        console.log('  Identity saved to:', result.identityPath);
        console.log('');
        console.log('Next step: run "orangerails-mcp start" to expose tools to your MCP client.');
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('connect failed:', msg);
        return 1;
      }
    }
    case 'status': {
      try {
        const identity = await readIdentity();
        if (!identity) {
          console.log('Not connected. Run "orangerails-mcp connect <token>" first.');
          return 0;
        }
        console.log('Agent member id:', identity.agentMemberId);
        console.log('Owner user id:  ', identity.ownerUserId);
        console.log('Access token expires:', identity.accessTokenExpiresAt);
        console.log('API base url:   ', identity.apiBaseUrl);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('status failed:', msg);
        return 1;
      }
    }
    case 'start': {
      try {
        await startStdioServer();
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`start failed: ${msg}\n`);
        return 1;
      }
    }
  }
}

main().then((code) => process.exit(code));
