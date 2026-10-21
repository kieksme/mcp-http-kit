import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to stdio with none auth', () => {
    const config = loadConfig({});
    expect(config.transport).toBe('stdio');
    expect(config.auth.mode).toBe('none');
  });

  it('prefers PORT over MCP_HTTP_PORT', () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      PORT: '8080',
      MCP_HTTP_PORT: '3000',
      MCP_AUTH_TOKEN: 'secret',
      MCP_HTTP_HOST: '127.0.0.1',
    });
    expect(config.http.port).toBe(8080);
  });

  it('accepts legacy token env with a warning', () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_HTTP_AUTH_TOKEN: 'legacy-secret',
      MCP_HTTP_HOST: '127.0.0.1',
    });
    expect(config.auth).toEqual({ mode: 'bearer', tokens: ['legacy-secret'] });
    expect(config.warnings.some(w => w.includes('MCP_HTTP_AUTH_TOKEN'))).toBe(true);
  });

  it('parses comma-separated bearer tokens for rotation', () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: 'a, b, c',
      MCP_HTTP_HOST: '127.0.0.1',
    });
    expect(config.auth).toEqual({ mode: 'bearer', tokens: ['a', 'b', 'c'] });
  });

  it('requires allowlist when binding beyond localhost', () => {
    expect(() =>
      loadConfig({
        MCP_TRANSPORT: 'http',
        MCP_AUTH_TOKEN: 'secret',
        MCP_HTTP_HOST: '0.0.0.0',
      }),
    ).toThrow(/MCP_ALLOWED_HOSTS/);
  });

  it('refuses auth none off localhost without opt-in', () => {
    expect(() =>
      loadConfig({
        MCP_TRANSPORT: 'http',
        MCP_AUTH_MODE: 'none',
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_ALLOWED_HOSTS: 'example.com',
      }),
    ).toThrow(/MCP_AUTH_ALLOW_NONE/);
  });

  it('allows auth none with explicit public opt-in', () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_MODE: 'none',
      MCP_AUTH_ALLOW_NONE: 'true',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'example.com',
    });
    expect(config.auth).toEqual({ mode: 'none', allowPublic: true });
  });

  it('loads oauth settings', () => {
    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_MODE: 'oauth',
      MCP_OAUTH_RESOURCE: 'https://mcp.example.com/mcp',
      MCP_OAUTH_AUTHORIZATION_SERVERS: 'https://auth.example.com',
      MCP_OAUTH_REQUIRED_SCOPES: 'mcp:read,mcp:write',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'mcp.example.com',
    });
    expect(config.auth.mode).toBe('oauth');
    if (config.auth.mode === 'oauth') {
      expect(config.auth.resource).toBe('https://mcp.example.com/mcp');
      expect(config.auth.requiredScopes).toEqual(['mcp:read', 'mcp:write']);
      expect(config.auth.audiences).toEqual(['https://mcp.example.com/mcp']);
    }
  });
});
