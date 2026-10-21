export type HostGuardConfig = {
  allowedHosts: string[];
  /** Absolute origin allowlist (e.g. `https://app.example.com`). Empty = derive from hosts. */
  allowedOrigins: string[];
};

export type HostGuardResult = { ok: true } | { ok: false; reason: string };

function normalizeHostname(hostHeader: string | null | undefined): string | undefined {
  if (!hostHeader) return undefined;
  // Strip port; handle IPv6 "[::1]:3000"
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end !== -1) return trimmed.slice(0, end + 1);
  }
  return trimmed.replace(/:\d+$/, '');
}

function originAllowed(
  origin: string | null | undefined,
  allowedHosts: string[],
  allowedOrigins: string[],
): boolean {
  if (!origin) return true; // non-browser clients omit Origin
  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin);
  }
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const bracketed = hostname.includes(':') ? `[${hostname}]` : hostname;
    return allowedHosts.includes(hostname) || allowedHosts.includes(bracketed);
  } catch {
    return false;
  }
}

/**
 * DNS-rebinding protection: require Host in the allowlist and Origin (when present)
 * to match allowed hosts/origins.
 */
export function checkHostAndOrigin(
  headers: { host?: string | null; origin?: string | null },
  config: HostGuardConfig,
): HostGuardResult {
  const hostname = normalizeHostname(headers.host ?? null);
  if (!hostname) {
    return { ok: false, reason: 'missing Host header' };
  }
  if (!config.allowedHosts.includes(hostname)) {
    return { ok: false, reason: `Host ${hostname} is not allowed` };
  }
  if (!originAllowed(headers.origin ?? null, config.allowedHosts, config.allowedOrigins)) {
    return { ok: false, reason: 'Origin is not allowed' };
  }
  return { ok: true };
}

export { normalizeHostname };
