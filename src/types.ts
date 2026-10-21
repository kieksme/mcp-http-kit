import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo, McpServer, Server } from '@modelcontextprotocol/server';

/** Transport selected by `MCP_TRANSPORT`. */
export type TransportMode = 'stdio' | 'http';

/** Authentication strategy for Streamable HTTP. */
export type AuthMode = 'bearer' | 'oauth' | 'none';

/** How upstream service credentials are resolved per request. */
export type UpstreamCredentialMode = 'env' | 'header';

export type BearerAuthConfig = {
  mode: 'bearer';
  /** Accepted bearer tokens (rotation-friendly). */
  tokens: string[];
};

export type OAuthAuthConfig = {
  mode: 'oauth';
  /** Canonical resource identifier (usually the public MCP URL). */
  resource: string;
  /** Authorization server issuer URLs (RFC 9728 `authorization_servers`). */
  authorizationServers: string[];
  /** Expected JWT audience values (resource indicator and/or explicit aud). */
  audiences: string[];
  /** Optional JWKS URL override; otherwise derived from AS metadata / well-known. */
  jwksUrl?: string;
  /** Required scopes (all must be present). Empty = any scope / no scope check. */
  requiredScopes: string[];
  /** Scopes advertised in protected-resource metadata. */
  scopesSupported: string[];
};

export type NoneAuthConfig = {
  mode: 'none';
  /** Must be true when binding beyond localhost. */
  allowPublic: boolean;
};

export type AuthConfig = BearerAuthConfig | OAuthAuthConfig | NoneAuthConfig;

export type HttpListenConfig = {
  host: string;
  port: number;
  /** MCP endpoint path (default `/mcp`). */
  path: string;
  /** Primary unauthenticated health path (default `/health`). */
  healthPath: string;
  /**
   * Extra health paths served like `healthPath` (e.g. `/healthz`).
   * Always includes `healthPath`; duplicates are removed.
   */
  healthPaths: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Max request body size in bytes. */
  maxBodyBytes: number;
  /** When true, GET/DELETE on the MCP path are forwarded (default: 405). */
  enableSessionMethods: boolean;
};

/** Extra fields merged into the JSON health response (alongside `status: "ok"`). */
export type HealthInfo = Record<string, unknown>;

/** Optional hook to enrich `/health` (and aliases) with version, tool counts, etc. */
export type HealthInfoProvider = () => HealthInfo | Promise<HealthInfo>;

export type KitConfig = {
  transport: TransportMode;
  http: HttpListenConfig;
  auth: AuthConfig;
  /** Realm used in WWW-Authenticate for bearer. */
  realm: string;
  /** Warnings emitted while loading (e.g. deprecated env aliases). */
  warnings: string[];
};

/** Auth context attached to an accepted HTTP request. */
export type AuthContext = {
  mode: AuthMode;
  /** Bearer token or access token string when present. */
  token?: string;
  /** JWT `sub` (oauth) when available. */
  subject?: string;
  /** Granted scopes (oauth) or empty for bearer/none. */
  scopes: string[];
  /** Raw JWT claims (oauth only). */
  claims?: Record<string, unknown>;
};

export type RequestContext = {
  auth: AuthContext;
  headers: Headers;
  /** Absolute request URL. */
  url: URL;
  /** Protocol era from the SDK factory (`modern` | `legacy`). */
  era: 'legacy' | 'modern';
  /** SDK pass-through auth info (scopes available to `requireScopes` / tool handlers). */
  authInfo?: AuthInfo;
};

export type ServerFactory = (
  context: RequestContext,
) => McpServer | Server | Promise<McpServer | Server>;

export type UpstreamCredentialOptions = {
  mode: UpstreamCredentialMode;
  /** Env var used when `mode === 'env'`. */
  envVar: string;
  /** Header name used when `mode === 'header'` (e.g. `X-Contabo-Api-Key`). */
  headerName: string;
  /** Current kit auth mode — header mode is refused when auth is `none`. */
  authMode: AuthMode;
  env?: NodeJS.ProcessEnv;
};

export type NodeHttpRequest = IncomingMessage;
export type NodeHttpResponse = ServerResponse;

export type StartMcpServerOptions = {
  createServer: ServerFactory;
  /** Pre-loaded config; defaults to `loadConfig()`. */
  config?: KitConfig;
  env?: NodeJS.ProcessEnv;
  /** Optional hook fired after the HTTP server starts listening. */
  onListening?: (info: { host: string; port: number; url: string }) => void;
  /** Optional extra fields for the health JSON body (merged under `status: "ok"`). */
  getHealthInfo?: HealthInfoProvider;
  signal?: AbortSignal;
};

export type StartedServer = {
  close: () => Promise<void>;
  /** Present in HTTP mode. */
  url?: string;
  config: KitConfig;
};
