import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMcpHttpApp } from '../src/http/app.js';
import {
  createAppTestClient,
  createKitContractAssertions,
} from '../src/test/helpers.js';
import type { RequestContext } from '../src/types.js';

function createTestServer(ctx: RequestContext): McpServer {
  const server = new McpServer({ name: 'kit-test-server', version: '0.0.0' });
  server.registerTool(
    'ping',
    {
      description: 'Return pong plus auth mode',
      inputSchema: z.object({}).strict(),
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: `pong:${ctx.auth.mode}`,
        },
      ],
    }),
  );
  return server;
}

describe('HTTP contract', () => {
  const config = loadConfig(
    {
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: 'test-token',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '3456',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
    { realm: 'kit-test' },
  );

  const app = createMcpHttpApp({ createServer: createTestServer, config });
  const client = createAppTestClient(app, config);
  const assertions = createKitContractAssertions(client, config);

  afterAll(async () => {
    await app.close();
  });

  it('serves /health without auth even with a bad Host', async () => {
    await assertions.healthUnauthenticated();
  });

  it('returns 401 without a bearer token', async () => {
    await assertions.unauthorizedWithoutToken();
  });

  it('returns 403 on a bad Host', async () => {
    await assertions.forbiddenOnBadHost();
  });

  it('returns 403 on a bad Origin', async () => {
    await assertions.forbiddenOnBadOrigin();
  });

  it('completes initialize + tools/list', async () => {
    const { tools } = await assertions.initializeAndListTools('test-token');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some(tool => (tool as { name?: string }).name === 'ping')).toBe(true);
  });

  it('returns 405 for GET on the MCP path', async () => {
    const response = await client.fetch(config.http.path, { method: 'GET' });
    expect(response.status).toBe(405);
  });
});

describe('auth none localhost', () => {
  beforeAll(() => {
    // no-op — keeps suite structure clear
  });

  it('allows unauthenticated MCP on localhost when mode is none', async () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_MODE: 'none',
      MCP_HTTP_HOST: '127.0.0.1',
      PORT: '3457',
    });
    const app = createMcpHttpApp({ createServer: createTestServer, config });
    const client = createAppTestClient(app, config);
    try {
      const response = await client.mcp({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'kit-test', version: '0' },
          },
        }),
      });
      expect(response.ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
