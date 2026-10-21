import type { AuthMode, UpstreamCredentialMode, UpstreamCredentialOptions } from './types.js';

export type UpstreamCredentialResult = {
  mode: UpstreamCredentialMode;
  value: string;
  source: 'env' | 'header';
};

/**
 * Resolve per-request upstream credentials (e.g. `X-Contabo-Api-Key`).
 *
 * Header mode is refused when kit auth is `none` — otherwise anyone could
 * smuggle upstream keys through an open endpoint.
 */
export function resolveUpstreamCredential(
  headers: Headers | Record<string, string | string[] | undefined>,
  options: UpstreamCredentialOptions,
): UpstreamCredentialResult {
  const { mode, envVar, headerName, authMode, env = process.env } = options;

  if (mode === 'header' && authMode === 'none') {
    throw new Error(
      'Upstream credential mode "header" is not allowed when MCP_AUTH_MODE=none',
    );
  }

  if (mode === 'env') {
    const value = env[envVar]?.trim();
    if (!value) {
      throw new Error(`${envVar} is required when upstream credential mode is "env"`);
    }
    return { mode: 'env', value, source: 'env' };
  }

  const raw = getHeader(headers, headerName);
  if (!raw?.trim()) {
    throw new Error(`Missing required upstream credential header: ${headerName}`);
  }
  return { mode: 'header', value: raw.trim(), source: 'header' };
}

export function parseUpstreamCredentialMode(
  raw: string | undefined,
  fallback: UpstreamCredentialMode = 'env',
): UpstreamCredentialMode {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'env' || value === 'header') return value;
  throw new Error(`Upstream credential mode must be env|header (got ${JSON.stringify(raw)})`);
}

/** Guard used by servers that expose a documented `X-<Service>-*` header. */
export function assertHeaderModeAllowed(authMode: AuthMode): void {
  if (authMode === 'none') {
    throw new Error('Header-based upstream credentials require bearer or oauth auth');
  }
}

function getHeader(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}
