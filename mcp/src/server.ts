/**
 * Orange Rails MCP — stdio server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readIdentity, type IdentityFile } from './identity.js';
import { booksPing } from './tools/books-ping.js';

const VERSION = '0.2.0';

export async function startStdioServer(): Promise<void> {
  const identity = await readIdentity();
  if (!identity) {
    throw new Error(
      'Not connected. Run "orangerails-mcp connect <invitation-token>" first.',
    );
  }

  if (isTokenExpired(identity)) {
    throw new Error(
      `Access token expired at ${identity.accessTokenExpiresAt}. Token refresh (via signed nonce challenge) is not yet implemented in v0.2 — for now, re-run connect with a fresh invitation token.`,
    );
  }

  const server = new Server(
    { name: '@orangerails/mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'books.ping',
        description:
          'Smoke check. Returns "pong" plus the agent member id and the server time. Verifies the stored access token is valid and the MCP wiring works end to end.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (name === 'books.ping') {
      const result = await booksPing(identity);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[orangerails-mcp ${VERSION}] connected as agent_member ${identity.agentMemberId}\n`,
  );
}

function isTokenExpired(identity: IdentityFile): boolean {
  const expires = Date.parse(identity.accessTokenExpiresAt);
  if (Number.isNaN(expires)) return true;
  return Date.now() > expires - 60_000;
}
