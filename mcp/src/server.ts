/**
 * Orange Rails MCP — stdio server.
 *
 * Implements the MCP protocol over standard input/output. Calls
 * ensureFreshIdentity() before each tool invocation so the access token
 * is always within its valid window.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readIdentity, type IdentityFile } from './identity.js';
import { ensureFreshToken } from './refresh.js';
import { booksPing } from './tools/books-ping.js';

const VERSION = '0.3.0';

export async function startStdioServer(): Promise<void> {
  let identity = await readIdentity();
  if (!identity) {
    throw new Error(
      'Not connected. Run "orangerails-mcp connect <invitation-token>" first.',
    );
  }

  // Refresh once up front so the server starts with a fresh token.
  identity = await ensureFreshToken(identity).catch((e) => {
    throw new Error(
      `Initial token refresh failed: ${e instanceof Error ? e.message : String(e)}. ` +
        `If the agent has been revoked or the invitation TTL elapsed, re-run connect.`,
    );
  });

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
    // Refresh the token if it is near expiry before invoking the tool.
    identity = await ensureFreshToken(identity);

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
    `[orangerails-mcp ${VERSION}] connected as agent_member ${identity.agentMemberId} (token expires ${identity.accessTokenExpiresAt})\n`,
  );
}
