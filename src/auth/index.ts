import type { AuthConfig, AuthContext } from '../types.js';
import { verifyBearerToken } from './bearer.js';
import { oauthWwwAuthenticate, verifyOAuthAccessToken } from './oauth.js';

export type AuthenticateResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 401; wwwAuthenticate: string; body: string; contentType?: string };

export type AuthenticateOptions = {
  auth: AuthConfig;
  realm: string;
  authorizationHeader: string | null | undefined;
};

/**
 * Authenticate an HTTP request according to kit auth mode.
 * Callers should skip this for `/health` and well-known metadata routes.
 */
export async function authenticateRequest(options: AuthenticateOptions): Promise<AuthenticateResult> {
  const { auth, realm, authorizationHeader } = options;

  if (auth.mode === 'none') {
    return { ok: true, context: { mode: 'none', scopes: [] } };
  }

  if (auth.mode === 'bearer') {
    return verifyBearerToken(authorizationHeader, auth.tokens, realm);
  }

  const result = await verifyOAuthAccessToken(authorizationHeader, auth);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      wwwAuthenticate: result.wwwAuthenticate,
      body: result.body,
      contentType: 'application/json',
    };
  }
  return result;
}

export function unauthorizedWwwAuthenticate(auth: AuthConfig, realm: string): string {
  if (auth.mode === 'oauth') return oauthWwwAuthenticate(auth, 'invalid_token', 'Authentication required');
  return `Bearer realm="${realm}"`;
}

export {
  buildProtectedResourceMetadata,
  clearOAuthJwksCache,
  oauthWwwAuthenticate,
  resourceMetadataUrl,
  verifyOAuthAccessToken,
} from './oauth.js';
export { extractBearerToken, verifyBearerToken } from './bearer.js';
