import type { McpHttpApp } from '../http/app.js';
import type { KitConfig } from '../types.js';

export type KitHttpTestClient = {
  baseUrl: string;
  health: () => Promise<Response>;
  mcp: (init?: RequestInit & { token?: string; host?: string; origin?: string }) => Promise<Response>;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

/** Parse a Streamable HTTP MCP response (JSON body or SSE `data:` frames). */
export async function readMcpJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('application/json') || text.trimStart().startsWith('{')) {
    return JSON.parse(text) as unknown;
  }
  // SSE: take the last JSON payload from data: lines
  const payloads: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // ignore non-JSON data frames
    }
  }
  if (payloads.length === 0) {
    throw new Error(`No JSON payload in MCP response (${contentType}): ${text.slice(0, 200)}`);
  }
  return payloads[payloads.length - 1];
}

/** In-process client against a kit `McpHttpApp.fetch` (no real listen required). */
export function createAppTestClient(app: McpHttpApp, config: KitConfig): KitHttpTestClient {
  const originHost = config.http.allowedHosts[0] ?? '127.0.0.1';
  const baseUrl = `http://${originHost}:${config.http.port}`;

  const fetch = (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('host')) headers.set('host', originHost);
    return app.fetch(new Request(`${baseUrl}${path}`, { ...init, headers }));
  };

  return {
    baseUrl,
    health: () => fetch(config.http.healthPath, { method: 'GET' }),
    mcp: (init = {}) => {
      const headers = new Headers(init.headers);
      if (init.token) headers.set('authorization', `Bearer ${init.token}`);
      if (init.host) headers.set('host', init.host);
      if (init.origin) headers.set('origin', init.origin);
      if (!headers.has('accept')) {
        headers.set('accept', 'application/json, text/event-stream');
      }
      if (!headers.has('content-type') && init.body) {
        headers.set('content-type', 'application/json');
      }
      const { token: _t, host: _h, origin: _o, ...rest } = init;
      return fetch(config.http.path, { method: 'POST', ...rest, headers });
    },
    fetch,
  };
}

export type KitContractAssertions = {
  /** GET /health without auth → 200 */
  healthUnauthenticated: () => Promise<void>;
  /** POST /mcp without token → 401 (+ WWW-Authenticate) */
  unauthorizedWithoutToken: () => Promise<void>;
  /** Bad Host → 403 (health stays 200 even with bad Host) */
  forbiddenOnBadHost: () => Promise<void>;
  /** Bad Origin → 403 on MCP path */
  forbiddenOnBadOrigin: () => Promise<void>;
  /** initialize + tools/list round-trip with a valid token */
  initializeAndListTools: (token: string) => Promise<{ tools: unknown[] }>;
};

/**
 * Reusable HTTP contract checks servers can call from their own vitest suites.
 */
export function createKitContractAssertions(
  client: KitHttpTestClient,
  config: KitConfig,
): KitContractAssertions {
  return {
    async healthUnauthenticated() {
      const response = await client.health();
      if (response.status !== 200) {
        throw new Error(`Expected /health 200, got ${response.status}`);
      }
      const body = (await response.json()) as { status?: string };
      if (body.status !== 'ok') {
        throw new Error(`Expected health status ok, got ${JSON.stringify(body)}`);
      }

      // Health must ignore Host allowlist (Railway probes).
      const evil = await client.fetch(config.http.healthPath, {
        method: 'GET',
        headers: { host: 'evil.example' },
      });
      if (evil.status !== 200) {
        throw new Error(`Expected /health 200 with bad Host, got ${evil.status}`);
      }
    },

    async unauthorizedWithoutToken() {
      if (config.auth.mode === 'none') return;
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
      if (response.status !== 401) {
        throw new Error(`Expected 401 without token, got ${response.status}`);
      }
      if (!response.headers.get('www-authenticate')) {
        throw new Error('Expected WWW-Authenticate header on 401');
      }
    },

    async forbiddenOnBadHost() {
      const token = config.auth.mode === 'bearer' ? config.auth.tokens[0] : 'dummy';
      const response = await client.mcp({
        host: 'evil.example',
        ...(token ? { token } : {}),
        body: '{}',
      });
      if (response.status !== 403) {
        throw new Error(`Expected 403 for bad Host, got ${response.status}`);
      }
    },

    async forbiddenOnBadOrigin() {
      const token = config.auth.mode === 'bearer' ? config.auth.tokens[0] : 'dummy';
      const response = await client.mcp({
        ...(token ? { token } : {}),
        origin: 'https://evil.example',
        body: '{}',
      });
      if (response.status !== 403) {
        throw new Error(`Expected 403 for bad Origin, got ${response.status}`);
      }
    },

    async initializeAndListTools(token: string) {
      const initBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'kit-test', version: '0' },
        },
      };
      const initResponse = await client.mcp({
        token,
        body: JSON.stringify(initBody),
      });
      if (!initResponse.ok) {
        throw new Error(
          `initialize failed: ${initResponse.status} ${await initResponse.text()}`,
        );
      }
      await readMcpJsonResponse(initResponse);

      const listBody = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      };
      const listResponse = await client.mcp({
        token,
        headers: {
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify(listBody),
      });
      if (!listResponse.ok) {
        throw new Error(`tools/list failed: ${listResponse.status} ${await listResponse.text()}`);
      }
      const payload = (await readMcpJsonResponse(listResponse)) as {
        result?: { tools?: unknown[] };
        tools?: unknown[];
      };
      const tools = payload.result?.tools ?? payload.tools ?? [];
      return { tools };
    },
  };
}
