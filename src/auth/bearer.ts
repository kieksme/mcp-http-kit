import { timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../types.js';

export type BearerAuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 401; wwwAuthenticate: string; body: string };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still compare against something of equal length to reduce timing skew on length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function extractBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

/** Constant-time check of Authorization: Bearer against one or more tokens. */
export function verifyBearerToken(
  authorization: string | null | undefined,
  tokens: string[],
  realm: string,
): BearerAuthResult {
  const token = extractBearerToken(authorization);
  if (!token) {
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: `Bearer realm="${realm}"`,
      body: 'Unauthorized',
    };
  }
  const accepted = tokens.some(expected => safeEqual(token, expected));
  if (!accepted) {
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: `Bearer realm="${realm}", error="invalid_token"`,
      body: 'Unauthorized',
    };
  }
  return {
    ok: true,
    context: { mode: 'bearer', token, scopes: [] },
  };
}
