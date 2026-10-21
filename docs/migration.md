# Migrating existing kieksme MCP servers to `@kieksme/mcp-http-kit`

This guide covers moving servers off hand-rolled HTTP/auth helpers onto the shared kit.

## SDK decision

The kit targets **MCP TypeScript SDK v2**:

- `@modelcontextprotocol/server`
- `@modelcontextprotocol/node`

v2 is the current stable release line (spec 2026-07-28). The monolithic
`@modelcontextprotocol/sdk` (v1) is legacy. New and migrated kieksme servers
should use v2; do not keep a v1 adapter in the kit.

| Before | After |
| --- | --- |
| `mcp-enhancv`, `mcp-balena` | Already on v2 — swap local `http.ts` for the kit |
| `mcp-contabo`, `mcp-listmonk`, `mcp-swetrix`, `mcp-hashnode` | On v1 `@modelcontextprotocol/sdk` — upgrade packages + imports, then adopt the kit |

## Env var rename map

| Legacy | Canonical |
| --- | --- |
| `MCP_HTTP_AUTH_TOKEN` / `MCP_SERVER_AUTH_TOKEN` | `MCP_AUTH_TOKEN` (comma list OK) |
| `MCP_HTTP_PORT` (as primary) | `PORT` (fallback still reads `MCP_HTTP_PORT`) |
| `MCP_HTTP_ALLOWED_HOSTS` | `MCP_ALLOWED_HOSTS` |
| `MCP_HTTP_ALLOWED_ORIGINS` | `MCP_ALLOWED_ORIGINS` |
| `MCP_HTTP_ENDPOINT` | `MCP_HTTP_PATH` (default `/mcp`) |
| `HEALTH_ENDPOINT` | `MCP_HEALTH_PATH` (default `/health`) |

Legacy names still work and emit a one-line warning.

New knobs:

- `MCP_AUTH_MODE=bearer|oauth|none`
- `MCP_AUTH_ALLOW_NONE=true` (only for public read-only demos off localhost)
- OAuth: `MCP_OAUTH_RESOURCE`, `MCP_OAUTH_AUTHORIZATION_SERVERS`, `MCP_OAUTH_AUDIENCES`, `MCP_OAUTH_JWKS_URL`, `MCP_OAUTH_REQUIRED_SCOPES`, `MCP_OAUTH_SCOPES_SUPPORTED`

## Code shape

**Before (enhancv-style):** local `parseHttpConfig` + `createHttpServer` + Host check before `/health`.

**After:**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig, startMcpServer } from '@kieksme/mcp-http-kit';

function createServer(ctx) {
  const server = new McpServer({ name: 'my-mcp', version: '1.0.0' });
  // register tools; ctx.auth.scopes available under oauth
  return server;
}

await startMcpServer({ createServer, config: loadConfig(process.env, { realm: 'my-mcp' }) });
```

Important behavior change: **`/health` is served before Host/Origin checks** so Railway (and similar) healthchecks keep working when `MCP_ALLOWED_HOSTS` is tight.

If you previously exposed `/healthz` (listmonk) or custom health JSON, use:

```ts
const config = loadConfig(process.env, {
  realm: 'my-mcp',
  healthPathAliases: ['/healthz'], // or MCP_HEALTH_ALIASES=/healthz
});

await startMcpServer({
  createServer,
  config,
  getHealthInfo: () => ({ version: VERSION, tools: TOOL_COUNT }),
});
```

## Per-request upstream credentials

```ts
import { resolveUpstreamCredential } from '@kieksme/mcp-http-kit';

const cred = resolveUpstreamCredential(ctx.headers, {
  mode: process.env.UPSTREAM_CREDENTIAL_MODE === 'header' ? 'header' : 'env',
  envVar: 'CONTABO_API_KEY',
  headerName: 'X-Contabo-Api-Key',
  authMode: ctx.auth.mode,
});
```

Header mode is rejected when `MCP_AUTH_MODE=none`.

## Deploy templates

Copy from this repo’s `templates/`:

- `Dockerfile` — multi-stage, non-root, `HEALTHCHECK` on `/health`
- `railway.json` — `healthcheckPath: /health`
- `server.json` — npm + OCI + `remotes` streamable-http for the official registry
- `smithery.yaml` — container runtime, HTTP start command

## Contract tests

```ts
import { createMcpHttpApp } from '@kieksme/mcp-http-kit';
import { createAppTestClient, createKitContractAssertions } from '@kieksme/mcp-http-kit/test';

const config = loadConfig({ /* test env */ });
const app = createMcpHttpApp({ createServer, config });
const client = createAppTestClient(app, config);
const assertions = createKitContractAssertions(client, config);

await assertions.healthUnauthenticated();
await assertions.unauthorizedWithoutToken();
await assertions.forbiddenOnBadHost();
await assertions.initializeAndListTools(token);
```

## Checklist

1. Bump to `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (drop v1 sdk).
2. Add `@kieksme/mcp-http-kit` dependency.
3. Replace local HTTP/auth modules with `loadConfig` + `startMcpServer`.
4. Rename Railway/Docker env vars (or keep aliases temporarily).
5. Ensure `/health` is what Railway probes (kit default).
6. Copy deploy templates; publish `server.json` via `mcp-publisher` if applicable.
7. Import kit contract assertions in CI.
