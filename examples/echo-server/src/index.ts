#!/usr/bin/env node
/**
 * Minimal MCP server demonstrating `@kieksme/mcp-http-kit`.
 *
 * stdio:  MCP_TRANSPORT=stdio pnpm example:echo
 * HTTP:   MCP_TRANSPORT=http MCP_AUTH_TOKEN=dev MCP_HTTP_HOST=127.0.0.1 pnpm example:echo
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { loadConfig, startMcpServer, type RequestContext } from '../../../src/index.js';

function createEchoServer(ctx: RequestContext): McpServer {
  const server = new McpServer({
    name: 'echo-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'echo',
    {
      description: 'Echo a message back; includes auth mode/scopes in the response metadata.',
      inputSchema: z
        .object({
          message: z.string().describe('Text to echo'),
        })
        .strict(),
    },
    async ({ message }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              message,
              auth: {
                mode: ctx.auth.mode,
                scopes: ctx.auth.scopes,
                subject: ctx.auth.subject ?? null,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

const config = loadConfig(process.env, { realm: 'echo-mcp' });
const started = await startMcpServer({
  createServer: createEchoServer,
  config,
  onListening: ({ url }) => {
    console.error(`[echo-mcp] listening on ${url} (auth=${config.auth.mode})`);
  },
});

if (config.transport === 'stdio') {
  console.error('[echo-mcp] stdio transport ready');
}

void started;
