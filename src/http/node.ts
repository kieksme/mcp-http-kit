import { createServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { KitConfig } from '../types.js';
import type { McpHttpApp } from './app.js';

export type NodeHttpServerOptions = {
  app: McpHttpApp;
  config: KitConfig;
};

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Adapt a kit HTTP app to a Node `http.Server` request listener.
 * Health/auth/host gates run in the web-standard app; this only bridges I/O.
 */
export function createNodeRequestListener(options: NodeHttpServerOptions): RequestListener {
  const { app, config } = options;
  const nodeHandler = toNodeHandler(
    {
      fetch: request => app.fetch(request),
    },
    { maxRequestBodySize: config.http.maxBodyBytes },
  );

  return (req, res) => {
    // For non-MCP paths (health, well-known, 403/404/401) we still go through
    // toWebRequest + app.fetch so Host/health ordering stays in one place.
    // toNodeHandler also works, but health probes with weird Host headers must
    // hit app.fetch before any Host rejection — app.fetch already does that.
    void (async () => {
      try {
        const urlPath = req.url ?? '/';
        const pathname = urlPath.split('?')[0] ?? '/';
        const isHealth =
          req.method === 'GET' && config.http.healthPaths.includes(pathname);
        const isWellKnown =
          req.method === 'GET' && pathname.startsWith('/.well-known/oauth-protected-resource');

        // Cast: Node's IncomingMessage is structurally compatible; EOPT disagrees on optionals.
        const nodeReq = req as Parameters<typeof toWebRequest>[0];
        if (isHealth || isWellKnown || pathname !== config.http.path) {
          const webRequest = await toWebRequest(nodeReq, undefined, {
            maxRequestBodySize: config.http.maxBodyBytes,
          });
          const response = await app.fetch(webRequest);
          res.writeHead(response.status, headersToRecord(response.headers));
          const buf = Buffer.from(await response.arrayBuffer());
          res.end(buf);
          return;
        }

        await nodeHandler(nodeReq, res);
      } catch (error) {
        console.error(
          'Node HTTP adapter failed:',
          error instanceof Error ? error.message : error,
        );
        if (!res.headersSent) {
          res.writeHead(500).end('Server error');
        }
      }
    })();
  };
}

/** Create a listening-ready `node:http` server for the kit app. */
export function createNodeHttpServer(options: NodeHttpServerOptions): HttpServer {
  return createServer(createNodeRequestListener(options));
}

/**
 * Fastify preHandler / raw hook helper: convert the Fastify request into a
 * web `Request`, run the kit app, and send the `Response` back.
 *
 * Example:
 * ```ts
 * fastify.all('/mcp', async (req, reply) => {
 *   await handleWithKitApp(app, req.raw, reply.raw, config);
 * });
 * ```
 */
export type KitNodeResponse = {
  writeHead: (statusCode: number, headers?: Record<string, string>) => unknown;
  write: (chunk: string | Uint8Array) => unknown;
  end: (chunk?: string | Uint8Array) => unknown;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  headersSent?: boolean;
  destroyed?: boolean;
};

export async function handleWithKitApp(
  app: McpHttpApp,
  req: Parameters<typeof toWebRequest>[0],
  res: KitNodeResponse,
  config: KitConfig,
  parsedBody?: unknown,
): Promise<void> {
  // Prefer streaming-capable Node adapter for the MCP path.
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === config.http.path) {
    const nodeHandler = toNodeHandler(
      { fetch: request => app.fetch(request) },
      { maxRequestBodySize: config.http.maxBodyBytes },
    );
    await nodeHandler(req, res, parsedBody);
    return;
  }
  const webRequest = await toWebRequest(req, parsedBody, {
    maxRequestBodySize: config.http.maxBodyBytes,
  });
  const response = await app.fetch(webRequest);
  if (res.headersSent) return;
  res.writeHead(response.status, headersToRecord(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
