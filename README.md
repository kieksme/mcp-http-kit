# `@kieksme/mcp-http-kit`

Shared **Streamable HTTP** transport, **auth** (bearer + OAuth 2.1 resource server), and **deploy templates** for kieksme MCP servers.

Use this so every server speaks the same env scheme, passes Railway healthchecks, and can be listed on MCP registries without copy-pasting HTTP glue.

## SDK decision (v2 only)

This kit targets the **MCP TypeScript SDK v2** packages:

| Package | Role |
| --- | --- |
| `@modelcontextprotocol/server` | `McpServer`, `createMcpHandler` |
| `@modelcontextprotocol/node` | `toNodeHandler`, Node Streamable HTTP |

**Why not v1 / dual adapters?** Upstream marked v2 as the stable release line implementing the **2026-07-28** spec; `@modelcontextprotocol/sdk` is the legacy monolith. Newer kieksme servers (`mcp-enhancv`, `mcp-balena`) already use v2. Older ones (`mcp-contabo`, `mcp-listmonk`, `mcp-swetrix`, `mcp-hashnode`) should migrate to v2 rather than the kit carrying a forever-v1 adapter. See [`docs/migration.md`](./docs/migration.md).

Peer dependencies: install `@modelcontextprotocol/server` and `@modelcontextprotocol/node` in each server.

## Install

```bash
pnpm add @kieksme/mcp-http-kit
pnpm add @modelcontextprotocol/server @modelcontextprotocol/node
```

Node **22.14+**, ESM only, MIT.

## Quick start

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig, startMcpServer } from '@kieksme/mcp-http-kit';

function createServer(ctx) {
  const server = new McpServer({ name: 'demo-mcp', version: '1.0.0' });
  // ctx.auth.mode / ctx.auth.scopes available to tool handlers
  return server;
}

const config = loadConfig(process.env, { realm: 'demo-mcp' });
await startMcpServer({ createServer, config });
```

- `MCP_TRANSPORT=stdio` → stdio (default)
- `MCP_TRANSPORT=http` → stateless Streamable HTTP (`POST /mcp`)

Example: [`examples/echo-server`](./examples/echo-server).

```bash
MCP_TRANSPORT=stdio pnpm example:echo
MCP_TRANSPORT=http MCP_AUTH_TOKEN=dev MCP_HTTP_HOST=127.0.0.1 pnpm example:echo
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` \| `http` |
| `PORT` | `3000` | Preferred listen port (Railway). Fallback: `MCP_HTTP_PORT` |
| `MCP_HTTP_HOST` | `127.0.0.1` | Use `0.0.0.0` in containers |
| `MCP_HTTP_PATH` | `/mcp` | MCP endpoint |
| `MCP_HEALTH_PATH` | `/health` | Primary unauthenticated health path |
| `MCP_HEALTH_ALIASES` | — | Extra health paths (comma-separated), e.g. `/healthz` |
| `MCP_ALLOWED_HOSTS` | localhost trio | Required when binding beyond localhost |
| `MCP_ALLOWED_ORIGINS` | _(derived)_ | Optional absolute origins; else Origin hostname must be in hosts |
| `MCP_AUTH_MODE` | `bearer` | `bearer` \| `oauth` \| `none` |
| `MCP_AUTH_TOKEN` | — | Bearer secrets; **comma-separated** for rotation |
| `MCP_AUTH_ALLOW_NONE` | `false` | Opt-in for `none` off localhost (public read-only) |
| `MCP_AUTH_REALM` | `mcp` | WWW-Authenticate realm (or pass `loadConfig(..., { realm })`) |
| `MCP_HTTP_ENABLE_SESSION_METHODS` | `false` | If true, GET/DELETE on MCP path are forwarded (else **405**) |
| `MCP_OAUTH_RESOURCE` | — | Canonical resource URL (oauth) |
| `MCP_OAUTH_AUTHORIZATION_SERVERS` | — | Comma-separated AS issuer URLs |
| `MCP_OAUTH_AUDIENCES` | resource | Expected JWT `aud` / resource |
| `MCP_OAUTH_JWKS_URL` | _(discovered)_ | Optional JWKS override |
| `MCP_OAUTH_REQUIRED_SCOPES` | _(none)_ | All must be present |
| `MCP_OAUTH_SCOPES_SUPPORTED` | required | Advertised in RFC 9728 metadata |

**Deprecated aliases** (still work, warn once): `MCP_HTTP_AUTH_TOKEN`, `MCP_SERVER_AUTH_TOKEN`, `MCP_HTTP_ALLOWED_HOSTS`, `MCP_HTTP_ALLOWED_ORIGINS`, `MCP_HTTP_ENDPOINT`, `HEALTH_ENDPOINT`.

## Auth modes

### `bearer`

Constant-time compare against `MCP_AUTH_TOKEN` list. Missing/invalid → **401** + `WWW-Authenticate: Bearer realm="…"`.

### `oauth`

MCP server acts as an **OAuth 2.1 resource server** only (never an authorization server):

1. Serves RFC 9728 metadata at `/.well-known/oauth-protected-resource` (+ path-aware variant for `/mcp`)
2. Validates JWT access tokens via JWKS (issuer, audience/resource, expiry, scopes)
3. 401 responses include `resource_metadata="…"` so clients can discover the AS
4. Scopes are available on `ctx.auth.scopes` and as SDK `authInfo` for `requireScopes`

### `none`

Allowed on **localhost** binds, or with `MCP_AUTH_ALLOW_NONE=true` for intentional public read-only endpoints. Header-based upstream credentials are **refused** in this mode.

## Request pipeline (HTTP)

1. **`GET` health paths** (`MCP_HEALTH_PATH` + `MCP_HEALTH_ALIASES`) — no auth, **before** Host/Origin checks (Railway-friendly)
2. **OAuth well-known** — no auth, before Host checks
3. Host / Origin allowlist → **403**
4. MCP path; non-POST → **405** (unless session methods enabled)
5. Auth → **401**
6. Stateless `createMcpHandler` (body size limit applied)

Graceful **SIGTERM** / **SIGINT** shutdown is wired by `startMcpServer`.

### Health body hook

Default body is `{ "status": "ok" }`. Pass `getHealthInfo` to add fields (version, tool count, …). `status: "ok"` always wins:

```ts
await startMcpServer({
  createServer,
  config,
  getHealthInfo: () => ({ version: '1.2.3', tools: 12 }),
});
// → { "version": "1.2.3", "tools": 12, "status": "ok" }
```

Aliases via env or `loadConfig(..., { healthPathAliases: ['/healthz'] })`.

## Framework-agnostic core

```ts
import { createMcpHttpApp, handleWithKitApp, createNodeHttpServer } from '@kieksme/mcp-http-kit';

const app = createMcpHttpApp({ createServer, config });
// Web Fetch API: app.fetch(request)
// Node: createNodeHttpServer({ app, config })
// Fastify/Express: handleWithKitApp(app, req.raw, reply.raw, config, req.body)
```

## Upstream credentials (per request)

```ts
import { resolveUpstreamCredential } from '@kieksme/mcp-http-kit';

const { value } = resolveUpstreamCredential(ctx.headers, {
  mode: 'header', // or 'env'
  envVar: 'CONTABO_API_KEY',
  headerName: 'X-Contabo-Api-Key',
  authMode: ctx.auth.mode,
});
```

## Test helpers

```ts
import { createAppTestClient, createKitContractAssertions } from '@kieksme/mcp-http-kit/test';
```

Covered contracts: 401 without token, 403 bad Host/Origin, `/health` without auth (incl. bad Host), initialize + `tools/list`.

## Railway deploy

1. Copy `templates/Dockerfile` and `templates/railway.json`
2. Set `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=0.0.0.0`, `MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS=<your-public-host>`
3. Railway sets `PORT`; the kit reads it first
4. Healthcheck path is `/health` (no auth, Host-agnostic)

## Registry / Smithery

- `templates/server.json` — official MCP registry (`io.github.kieksme/<name>`, npm + OCI + `remotes` streamable-http)
- `templates/smithery.yaml` — container runtime, HTTP start command

## Public API

| Export | Purpose |
| --- | --- |
| `loadConfig` / `resolveHealthPaths` | Env → `KitConfig` (+ legacy aliases) |
| `startMcpServer` | stdio or HTTP lifecycle (`getHealthInfo` supported) |
| `createMcpHttpApp` | Web-standard `{ fetch, close }` |
| `createNodeHttpServer` / `createNodeRequestListener` | `node:http` |
| `handleWithKitApp` | Fastify/Express bridge |
| `authenticateRequest` / bearer + oauth helpers | Auth primitives |
| `resolveUpstreamCredential` | env \| header upstream keys |
| `@kieksme/mcp-http-kit/test` | Contract test helpers |

### Git installs

`prepare` builds `dist/` when it is missing (typical for `github:` / git URL deps). Published npm tarballs already include `dist`, so prepare is a no-op there.

## Scripts

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT © kieks.me
