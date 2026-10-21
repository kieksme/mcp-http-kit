import { describe, expect, it } from 'vitest';
import { verifyBearerToken } from '../src/auth/bearer.js';

describe('verifyBearerToken', () => {
  it('accepts a matching token', () => {
    const result = verifyBearerToken('Bearer secret', ['secret'], 'demo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.mode).toBe('bearer');
      expect(result.context.token).toBe('secret');
    }
  });

  it('rejects wrong token with WWW-Authenticate', () => {
    const result = verifyBearerToken('Bearer nope', ['secret'], 'demo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toContain('realm="demo"');
    }
  });

  it('supports rotation across multiple tokens', () => {
    expect(verifyBearerToken('Bearer old', ['old', 'new'], 'demo').ok).toBe(true);
    expect(verifyBearerToken('Bearer new', ['old', 'new'], 'demo').ok).toBe(true);
  });
});
