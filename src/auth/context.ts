import type { AuthInfo } from '@modelcontextprotocol/server';
import type { AuthContext, AuthMode, KitConfig } from '../types.js';
import { resourceMetadataUrl } from './oauth.js';

const KIT_AUTH_EXTRA_KEY = 'kieksme.auth';

/** Map kit auth into the SDK `AuthInfo` pass-through (scopes reach tool handlers). */
export function toAuthInfo(auth: AuthContext, config: KitConfig): AuthInfo | undefined {
  if (auth.mode === 'none') return undefined;
  const token = auth.token ?? '';
  const info: AuthInfo = {
    token,
    clientId: auth.subject ?? auth.mode,
    scopes: auth.scopes,
    extra: {
      [KIT_AUTH_EXTRA_KEY]: {
        mode: auth.mode,
        subject: auth.subject,
        claims: auth.claims,
      },
    },
  };
  if (config.auth.mode === 'oauth') {
    info.resource = new URL(config.auth.resource);
    info.resourceMetadataUrl = resourceMetadataUrl(config.auth.resource);
    const exp = auth.claims?.exp;
    if (typeof exp === 'number') info.expiresAt = exp;
  }
  return info;
}

/** Recover kit `AuthContext` from SDK `AuthInfo` (or fall back to none). */
export function fromAuthInfo(authInfo: AuthInfo | undefined): AuthContext {
  if (!authInfo) {
    return { mode: 'none', scopes: [] };
  }
  const stamped = authInfo.extra?.[KIT_AUTH_EXTRA_KEY] as
    | { mode?: AuthMode; subject?: string; claims?: Record<string, unknown> }
    | undefined;
  const subject =
    stamped?.subject ?? (authInfo.clientId !== 'bearer' && authInfo.clientId !== 'none'
      ? authInfo.clientId
      : undefined);
  return {
    mode: stamped?.mode ?? (authInfo.scopes.length > 0 ? 'oauth' : 'bearer'),
    token: authInfo.token,
    scopes: authInfo.scopes,
    ...(subject ? { subject } : {}),
    ...(stamped?.claims ? { claims: stamped.claims } : {}),
  };
}
