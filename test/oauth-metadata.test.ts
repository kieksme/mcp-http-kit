import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMcpHttpApp } from '../src/http/app.js';
import { McpServer } from '@modelcontextprotocol/server';
import { createAppTestClient } from '../src/test/helpers.js';

describe('oauth protected resource metadata', () => {
  it('serves RFC 9728 metadata without auth', async () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_RESOURCE: 'https://mcp.example.com/mcp',
      MCP_OAUTH_AUTHORIZATION_SERVERS: 'https://auth.example.com',
      MCP_OAUTH_SCOPES_SUPPORTED: 'mcp:read',
      MCP_HTTP_HOST: '127.0.0.1',
      PORT: '3460',
      MCP_ALLOWED_HOSTS: '127.0.0.1,mcp.example.com',
    });
    const app = createMcpHttpApp({
      createServer: () => new McpServer({ name: 'oauth-meta', version: '0' }),
      config,
    });
    const client = createAppTestClient(app, config);
    try {
      const response = await client.fetch('/.well-known/oauth-protected-resource/mcp');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported?: string[];
      };
      expect(body.resource).toBe('https://mcp.example.com/mcp');
      expect(body.authorization_servers).toEqual(['https://auth.example.com']);
      expect(body.scopes_supported).toEqual(['mcp:read']);

      const unauthorized = await client.mcp({ body: '{}' });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');
    } finally {
      await app.close();
    }
  });
});
