import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AuthContext, OAuthAuthConfig } from '../types.js';

export type OAuthAuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 401; wwwAuthenticate: string; body: string };

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported: string[];
};

type CachedJwks = { url: string; getKey: JWTVerifyGetKey };

const jwksCache = new Map<string, CachedJwks>();

function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  // RFC 9728 path-aware well-known: insert /.well-known/oauth-protected-resource before path
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

export function buildProtectedResourceMetadata(config: OAuthAuthConfig): ProtectedResourceMetadata {
  return {
    resource: config.resource,
    authorization_servers: config.authorizationServers,
    ...(config.scopesSupported.length > 0 ? { scopes_supported: config.scopesSupported } : {}),
    bearer_methods_supported: ['header'],
  };
}

export function oauthWwwAuthenticate(
  config: OAuthAuthConfig,
  error?: string,
  description?: string,
): string {
  const metadata = resourceMetadataUrl(config.resource);
  const parts = [`Bearer resource_metadata="${metadata}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(', ');
}

function parseScopes(payload: JWTPayload): string[] {
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === 'string') {
    return scopeClaim.split(/\s+/).filter(Boolean);
  }
  const scp = payload.scp;
  if (Array.isArray(scp)) {
    return scp.filter((s): s is string => typeof s === 'string');
  }
  return [];
}

function audiencesMatch(payload: JWTPayload, expected: string[]): boolean {
  const aud = payload.aud;
  const values = Array.isArray(aud) ? aud : aud ? [aud] : [];
  // Also accept `resource` / `rsc` style claims used by some AS implementations.
  const resourceClaim = payload.resource ?? payload.rsc;
  if (typeof resourceClaim === 'string') values.push(resourceClaim);
  if (Array.isArray(resourceClaim)) {
    for (const entry of resourceClaim) {
      if (typeof entry === 'string') values.push(entry);
    }
  }
  return expected.some(want => values.includes(want));
}

async function resolveJwks(config: OAuthAuthConfig): Promise<JWTVerifyGetKey> {
  if (config.jwksUrl) {
    const cached = jwksCache.get(config.jwksUrl);
    if (cached) return cached.getKey;
    const getKey = createRemoteJWKSet(new URL(config.jwksUrl));
    jwksCache.set(config.jwksUrl, { url: config.jwksUrl, getKey });
    return getKey;
  }

  const issuer = config.authorizationServers[0];
  if (!issuer) {
    throw new Error('OAuth config missing authorizationServers');
  }
  const issuerUrl = issuer.endsWith('/') ? issuer : `${issuer}/`;
  // Prefer OIDC discovery, then OAuth AS metadata.
  const candidates = [
    new URL('.well-known/openid-configuration', issuerUrl).href,
    new URL('.well-known/oauth-authorization-server', issuerUrl).href,
  ];

  for (const metadataUrl of candidates) {
    try {
      const response = await fetch(metadataUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { jwks_uri?: string; issuer?: string };
      if (!body.jwks_uri) continue;
      const cached = jwksCache.get(body.jwks_uri);
      if (cached) return cached.getKey;
      const getKey = createRemoteJWKSet(new URL(body.jwks_uri));
      jwksCache.set(body.jwks_uri, { url: body.jwks_uri, getKey });
      return getKey;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Unable to resolve JWKS for authorization server ${issuer}; set MCP_OAUTH_JWKS_URL`,
  );
}

function unauthorized(
  config: OAuthAuthConfig,
  error: string,
  description: string,
): OAuthAuthResult {
  return {
    ok: false,
    status: 401,
    wwwAuthenticate: oauthWwwAuthenticate(config, error, description),
    body: JSON.stringify({ error, error_description: description }),
  };
}

/** Validate a Bearer access token as an OAuth 2.1 resource server (JWT + JWKS). */
export async function verifyOAuthAccessToken(
  authorization: string | null | undefined,
  config: OAuthAuthConfig,
): Promise<OAuthAuthResult> {
  const header = authorization?.trim();
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return unauthorized(config, 'invalid_token', 'Authentication required');
  }
  const token = header.slice(7).trim();
  if (!token) {
    return unauthorized(config, 'invalid_token', 'Authentication required');
  }

  let payload: JWTPayload;
  try {
    const getKey = await resolveJwks(config);
    const verified = await jwtVerify(token, getKey, {
      issuer: config.authorizationServers,
      clockTolerance: 30,
    });
    payload = verified.payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token validation failed';
    return unauthorized(config, 'invalid_token', message);
  }

  if (!audiencesMatch(payload, config.audiences)) {
    return unauthorized(config, 'invalid_token', 'Token audience does not match this resource');
  }

  const scopes = parseScopes(payload);
  if (config.requiredScopes.length > 0) {
    const missing = config.requiredScopes.filter(scope => !scopes.includes(scope));
    if (missing.length > 0) {
      return {
        ok: false,
        status: 401,
        wwwAuthenticate: oauthWwwAuthenticate(
          config,
          'insufficient_scope',
          `Missing scopes: ${missing.join(' ')}`,
        ),
        body: JSON.stringify({
          error: 'insufficient_scope',
          error_description: `Missing scopes: ${missing.join(' ')}`,
        }),
      };
    }
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
  return {
    ok: true,
    context: {
      mode: 'oauth',
      token,
      scopes,
      claims: payload as Record<string, unknown>,
      ...(subject ? { subject } : {}),
    },
  };
}

/** Clear JWKS cache (tests). */
export function clearOAuthJwksCache(): void {
  jwksCache.clear();
}

export { resourceMetadataUrl };
