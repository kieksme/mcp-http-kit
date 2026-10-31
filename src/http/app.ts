import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticateRequest } from '../auth/index.js';
import { fromAuthInfo, toAuthInfo } from '../auth/context.js';
import { buildProtectedResourceMetadata, resourceMetadataUrl } from '../auth/oauth.js';
import type {
  HealthInfoProvider,
  KitConfig,
  RequestContext,
  ServerFactory,
} from '../types.js';
import { startTracing } from '../otel.js';
import { installTelemetry } from '../telemetry.js';
import { checkHostAndOrigin } from './host-guard.js';

export type McpHttpAppOptions = {
  createServer: ServerFactory;
  config: KitConfig;
  /**
   * Optional extra fields for the health JSON body.
   * Merged with `status: "ok"` always winning (cannot be overridden).
   */
  getHealthInfo?: HealthInfoProvider;
  /** Env used for the tracing switch (`OTEL_EXPORTER_OTLP_ENDPOINT`); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export type McpHttpApp = {
  /** Web-standard fetch handler (framework-agnostic core). */
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, headers ? { status, headers } : { status });
}

function isWellKnownProtectedResource(pathname: string, mcpPath: string): boolean {
  if (pathname === '/.well-known/oauth-protected-resource') return true;
  const suffix = mcpPath === '/' ? '' : mcpPath.replace(/\/$/, '');
  return pathname === `/.well-known/oauth-protected-resource${suffix}`;
}

/**
 * Build a framework-agnostic Streamable HTTP app.
 *
 * Request order:
 * 1. GET health — no auth, **before** Host/Origin checks (Railway-friendly)
 * 2. OAuth protected-resource metadata — no auth, before Host checks
 * 3. Host/Origin allowlist → 403
 * 4. MCP path method gate (POST required unless session methods enabled)
 * 5. Auth → 401
 * 6. MCP handler (`createMcpHandler`) with `authInfo` pass-through
 */
export function createMcpHttpApp(options: McpHttpAppOptions): McpHttpApp {
  const { createServer, config, getHealthInfo } = options;
  const { http, auth, realm } = config;
  const healthPaths = new Set(http.healthPaths);

  // Opt-in tracing (no-op without OTEL_EXPORTER_OTLP_ENDPOINT). Idempotent, so this is harmless
  // when startMcpServer already started it; tool calls wait for it. Fire-and-forget: it never throws.
  void startTracing({
    ...(options.env ? { env: options.env } : {}),
    serviceName: config.realm,
  });
  // Unauthenticated clients must not choose our trace IDs.
  installTelemetry({
    ...(options.env ? { env: options.env } : {}),
    trustIncomingContext: auth.mode !== 'none',
  });

  const mcpHandler = createMcpHandler(
    sdkCtx => {
      const request = sdkCtx.requestInfo;
      const context: RequestContext = {
        auth: fromAuthInfo(sdkCtx.authInfo),
        headers: request?.headers ?? new Headers(),
        url: request ? new URL(request.url) : new URL(`http://localhost${http.path}`),
        era: sdkCtx.era,
        ...(sdkCtx.authInfo ? { authInfo: sdkCtx.authInfo } : {}),
      };
      return createServer(context);
    },
    { maxRequestBodySize: http.maxBodyBytes },
  );

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. Health — unauthenticated, no Host gate (load balancers / Railway probes)
    if (request.method === 'GET' && healthPaths.has(pathname)) {
      const extra = getHealthInfo ? await getHealthInfo() : {};
      return jsonResponse(200, { ...extra, status: 'ok' });
    }

    // 2. OAuth protected resource metadata (RFC 9728)
    if (
      auth.mode === 'oauth' &&
      request.method === 'GET' &&
      isWellKnownProtectedResource(pathname, http.path)
    ) {
      return jsonResponse(200, buildProtectedResourceMetadata(auth), {
        'cache-control': 'public, max-age=60',
      });
    }

    // 3. Host / Origin allowlist
    const hostCheck = checkHostAndOrigin(
      {
        host: request.headers.get('host'),
        origin: request.headers.get('origin'),
      },
      {
        allowedHosts: http.allowedHosts,
        allowedOrigins: http.allowedOrigins,
      },
    );
    if (!hostCheck.ok) {
      return textResponse(403, 'Forbidden');
    }

    // Non-MCP paths
    if (pathname !== http.path) {
      return textResponse(404, 'Not found');
    }

    // 4. Method gate — stateless Streamable HTTP is POST-only by default
    if (request.method !== 'POST') {
      if (
        http.enableSessionMethods &&
        (request.method === 'GET' || request.method === 'DELETE')
      ) {
        // fall through to MCP handler
      } else {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { allow: http.enableSessionMethods ? 'GET, POST, DELETE' : 'POST' },
        });
      }
    }

    // 5. Auth
    const authResult = await authenticateRequest({
      auth,
      realm,
      authorizationHeader: request.headers.get('authorization'),
    });
    if (!authResult.ok) {
      const headers: Record<string, string> = {
        'www-authenticate': authResult.wwwAuthenticate,
      };
      if (authResult.contentType) headers['content-type'] = authResult.contentType;
      return new Response(authResult.body, { status: authResult.status, headers });
    }

    const authInfo = toAuthInfo(authResult.context, config);

    try {
      return await mcpHandler.fetch(request, authInfo ? { authInfo } : undefined);
    } catch (error) {
      console.error(
        'MCP HTTP request failed:',
        error instanceof Error ? error.message : error,
      );
      return textResponse(500, 'Server error');
    }
  };

  return {
    fetch,
    close: async () => {
      await mcpHandler.close();
    },
  };
}

/** Absolute metadata path for OAuth WWW-Authenticate helpers in tests/docs. */
export function protectedResourceMetadataPath(mcpPath: string): string {
  const suffix = mcpPath === '/' ? '' : mcpPath.replace(/\/$/, '');
  return `/.well-known/oauth-protected-resource${suffix}`;
}

export { resourceMetadataUrl };
