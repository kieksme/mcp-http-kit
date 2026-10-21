import type {
  AuthConfig,
  AuthMode,
  HttpListenConfig,
  KitConfig,
  TransportMode,
} from './types.js';

const DEFAULT_PATH = '/mcp';
const DEFAULT_HEALTH = '/health';
const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type LoadConfigOptions = {
  /** Default realm for WWW-Authenticate (server package name). */
  realm?: string;
  /** Override default MCP path. */
  defaultPath?: string;
  /** Override default health path. */
  defaultHealthPath?: string;
  /** Override max body size. */
  maxBodyBytes?: number;
};

function firstDefined(env: NodeJS.ProcessEnv, names: string[]): { value?: string; name?: string } {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return { value, name };
    }
  }
  return {};
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function parsePort(raw: string | undefined, label: string): number {
  const port = Number(raw ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} must be an integer 0..65535`);
  }
  return port;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function isLocalBind(host: string): boolean {
  return LOCAL_HOSTS.has(normalizeHost(host));
}

function parseTransport(raw: string | undefined): TransportMode {
  const value = (raw ?? 'stdio').trim().toLowerCase();
  if (value === 'stdio' || value === 'http') return value;
  throw new Error(`MCP_TRANSPORT must be "stdio" or "http" (got ${JSON.stringify(raw)})`);
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? 'bearer').trim().toLowerCase();
  if (value === 'bearer' || value === 'oauth' || value === 'none') return value;
  throw new Error(`MCP_AUTH_MODE must be bearer|oauth|none (got ${JSON.stringify(raw)})`);
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseBearerTokens(env: NodeJS.ProcessEnv, warnings: string[]): string[] {
  const primary = firstDefined(env, ['MCP_AUTH_TOKEN']);
  const legacy = firstDefined(env, ['MCP_HTTP_AUTH_TOKEN', 'MCP_SERVER_AUTH_TOKEN']);

  if (primary.value) {
    return splitList(primary.value);
  }
  if (legacy.value && legacy.name) {
    warnings.push(
      `${legacy.name} is deprecated; use MCP_AUTH_TOKEN (comma-separated list for rotation)`,
    );
    return splitList(legacy.value);
  }
  return [];
}

function parseOAuthConfig(env: NodeJS.ProcessEnv): Extract<AuthConfig, { mode: 'oauth' }> {
  const resource = env.MCP_OAUTH_RESOURCE?.trim();
  const authorizationServers = splitList(env.MCP_OAUTH_AUTHORIZATION_SERVERS);
  if (!resource) {
    throw new Error('MCP_OAUTH_RESOURCE is required when MCP_AUTH_MODE=oauth');
  }
  if (authorizationServers.length === 0) {
    throw new Error('MCP_OAUTH_AUTHORIZATION_SERVERS is required when MCP_AUTH_MODE=oauth');
  }
  const audiences = splitList(env.MCP_OAUTH_AUDIENCES);
  const requiredScopes = splitList(env.MCP_OAUTH_REQUIRED_SCOPES);
  const scopesSupported = splitList(env.MCP_OAUTH_SCOPES_SUPPORTED);
  const jwksUrl = env.MCP_OAUTH_JWKS_URL?.trim();
  return {
    mode: 'oauth',
    resource,
    authorizationServers,
    audiences: audiences.length > 0 ? audiences : [resource],
    requiredScopes,
    scopesSupported: scopesSupported.length > 0 ? scopesSupported : requiredScopes,
    ...(jwksUrl ? { jwksUrl } : {}),
  };
}

function parseAuth(env: NodeJS.ProcessEnv, http: HttpListenConfig, warnings: string[]): AuthConfig {
  const mode = parseAuthMode(env.MCP_AUTH_MODE);
  if (mode === 'bearer') {
    const tokens = parseBearerTokens(env, warnings);
    if (tokens.length === 0) {
      throw new Error(
        'MCP_AUTH_TOKEN is required when MCP_AUTH_MODE=bearer (generate with: openssl rand -hex 32)',
      );
    }
    return { mode: 'bearer', tokens };
  }
  if (mode === 'oauth') {
    return parseOAuthConfig(env);
  }
  const allowPublic = truthy(env.MCP_AUTH_ALLOW_NONE);
  if (!isLocalBind(http.host) && !allowPublic) {
    throw new Error(
      'MCP_AUTH_MODE=none is only allowed on localhost unless MCP_AUTH_ALLOW_NONE=true (public read-only opt-in)',
    );
  }
  return { mode: 'none', allowPublic };
}

function parseAllowlists(
  env: NodeJS.ProcessEnv,
  host: string,
  warnings: string[],
): { allowedHosts: string[]; allowedOrigins: string[] } {
  const hostsRaw = firstDefined(env, ['MCP_ALLOWED_HOSTS', 'MCP_HTTP_ALLOWED_HOSTS']);
  if (hostsRaw.name === 'MCP_HTTP_ALLOWED_HOSTS') {
    warnings.push('MCP_HTTP_ALLOWED_HOSTS is deprecated; use MCP_ALLOWED_HOSTS');
  }
  const originsRaw = firstDefined(env, ['MCP_ALLOWED_ORIGINS', 'MCP_HTTP_ALLOWED_ORIGINS']);
  if (originsRaw.name === 'MCP_HTTP_ALLOWED_ORIGINS') {
    warnings.push('MCP_HTTP_ALLOWED_ORIGINS is deprecated; use MCP_ALLOWED_ORIGINS');
  }

  let allowedHosts = splitList(hostsRaw.value).map(normalizeHost);
  if (allowedHosts.length === 0) {
    allowedHosts = ['127.0.0.1', 'localhost', '[::1]'];
  }

  if (!isLocalBind(host) && !hostsRaw.value) {
    throw new Error(
      'MCP_ALLOWED_HOSTS is required when binding beyond localhost (comma-separated hostnames clients use)',
    );
  }

  const allowedOrigins = splitList(originsRaw.value);
  return { allowedHosts, allowedOrigins };
}

/**
 * Load kit configuration from the environment.
 *
 * Canonical names: `MCP_TRANSPORT`, `PORT` / `MCP_HTTP_PORT`, `MCP_HTTP_HOST`,
 * `MCP_HTTP_PATH`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_AUTH_MODE`,
 * `MCP_AUTH_TOKEN`. Legacy aliases emit warnings but still work.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): KitConfig {
  const warnings: string[] = [];
  const transport = parseTransport(env.MCP_TRANSPORT);

  const portSource = firstDefined(env, ['PORT', 'MCP_HTTP_PORT']);
  if (portSource.name === 'MCP_HTTP_PORT' && !env.PORT) {
    warnings.push('MCP_HTTP_PORT is deprecated as the primary port; prefer PORT (Railway-friendly)');
  }

  const host = env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const path =
    env.MCP_HTTP_PATH?.trim() ||
    env.MCP_HTTP_ENDPOINT?.trim() ||
    options.defaultPath ||
    DEFAULT_PATH;
  if (env.MCP_HTTP_ENDPOINT && !env.MCP_HTTP_PATH) {
    warnings.push('MCP_HTTP_ENDPOINT is deprecated; use MCP_HTTP_PATH');
  }

  const healthPath =
    env.MCP_HEALTH_PATH?.trim() ||
    env.HEALTH_ENDPOINT?.trim() ||
    options.defaultHealthPath ||
    DEFAULT_HEALTH;
  if (env.HEALTH_ENDPOINT && !env.MCP_HEALTH_PATH) {
    warnings.push('HEALTH_ENDPOINT is deprecated; use MCP_HEALTH_PATH');
  }

  const { allowedHosts, allowedOrigins } = parseAllowlists(env, host, warnings);
  const port = parsePort(portSource.value, portSource.name ?? 'PORT');

  const http: HttpListenConfig = {
    host,
    port,
    path: path.startsWith('/') ? path : `/${path}`,
    healthPath: healthPath.startsWith('/') ? healthPath : `/${healthPath}`,
    allowedHosts,
    allowedOrigins,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY,
    enableSessionMethods: truthy(env.MCP_HTTP_ENABLE_SESSION_METHODS),
  };

  const auth = transport === 'http' ? parseAuth(env, http, warnings) : { mode: 'none' as const, allowPublic: true };

  return {
    transport,
    http,
    auth: transport === 'http' ? auth : { mode: 'none', allowPublic: true },
    realm: options.realm ?? env.MCP_AUTH_REALM?.trim() ?? 'mcp',
    warnings,
  };
}

export function isLocalhostHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(normalizeHost(hostname));
}

export { LOCAL_HOSTS };
