import { describe, expect, it } from 'vitest';
import { resolveUpstreamCredential } from '../src/upstream.js';

describe('resolveUpstreamCredential', () => {
  it('reads from env', () => {
    const result = resolveUpstreamCredential(new Headers(), {
      mode: 'env',
      envVar: 'SERVICE_API_KEY',
      headerName: 'X-Service-Api-Key',
      authMode: 'bearer',
      env: { SERVICE_API_KEY: 'from-env' },
    });
    expect(result).toEqual({ mode: 'env', value: 'from-env', source: 'env' });
  });

  it('reads from header', () => {
    const headers = new Headers({ 'x-service-api-key': 'from-header' });
    const result = resolveUpstreamCredential(headers, {
      mode: 'header',
      envVar: 'SERVICE_API_KEY',
      headerName: 'X-Service-Api-Key',
      authMode: 'bearer',
    });
    expect(result.value).toBe('from-header');
  });

  it('refuses header mode when auth is none', () => {
    expect(() =>
      resolveUpstreamCredential(new Headers({ 'x-service-api-key': 'x' }), {
        mode: 'header',
        envVar: 'SERVICE_API_KEY',
        headerName: 'X-Service-Api-Key',
        authMode: 'none',
      }),
    ).toThrow(/not allowed/);
  });
});
