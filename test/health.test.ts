import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMcpHttpApp } from '../src/http/app.js';
import { createAppTestClient } from '../src/test/helpers.js';

describe('health paths and info hook', () => {
  it('serves aliases without auth and merges getHealthInfo', async () => {
    const config = loadConfig(
      {
        MCP_TRANSPORT: 'http',
        MCP_AUTH_TOKEN: 'secret',
        MCP_HTTP_HOST: '127.0.0.1',
        PORT: '3461',
        MCP_HEALTH_ALIASES: '/healthz',
      },
      { realm: 'health-test' },
    );

    const app = createMcpHttpApp({
      createServer: () => new McpServer({ name: 'health-test', version: '0' }),
      config,
      getHealthInfo: () => ({ version: '1.2.3', tools: 4 }),
    });
    const client = createAppTestClient(app, config);

    try {
      for (const path of ['/health', '/healthz']) {
        const response = await client.fetch(path, {
          method: 'GET',
          headers: { host: 'evil.example' },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toEqual({ version: '1.2.3', tools: 4, status: 'ok' });
      }

      // status: "ok" wins over a conflicting hook field
      const locked = createMcpHttpApp({
        createServer: () => new McpServer({ name: 'health-test', version: '0' }),
        config,
        getHealthInfo: () => ({ status: 'degraded', version: '9' }),
      });
      try {
        const response = await createAppTestClient(locked, config).health();
        expect(await response.json()).toEqual({ status: 'ok', version: '9' });
      } finally {
        await locked.close();
      }
    } finally {
      await app.close();
    }
  });
});
