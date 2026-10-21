import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createMcpHttpApp } from './http/app.js';
import { createNodeHttpServer } from './http/node.js';
import type { KitConfig, StartedServer, StartMcpServerOptions } from './types.js';

function publicUrl(config: KitConfig): string {
  const host = config.http.host === '0.0.0.0' ? '127.0.0.1' : config.http.host;
  return `http://${host}:${config.http.port}${config.http.path}`;
}

/**
 * Start an MCP server over stdio or stateless Streamable HTTP based on config.
 *
 * ```ts
 * await startMcpServer({
 *   createServer: (ctx) => {
 *     const server = new McpServer({ name: 'demo', version: '1.0.0' });
 *     // register tools; ctx.auth.scopes available for oauth
 *     return server;
 *   },
 * });
 * ```
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<StartedServer> {
  const config = options.config ?? loadConfig(options.env ?? process.env);
  for (const warning of config.warnings) {
    console.warn(`[mcp-http-kit] ${warning}`);
  }

  if (config.transport === 'stdio') {
    const handle = serveStdio(() =>
      options.createServer({
        auth: { mode: 'none', scopes: [] },
        headers: new Headers(),
        url: new URL('stdio://local'),
        era: 'modern',
      }),
    );

    const close = async () => {
      await handle.close();
    };

    if (options.signal) {
      if (options.signal.aborted) await close();
      else options.signal.addEventListener('abort', () => void close(), { once: true });
    }

    return { close, config };
  }

  const app = createMcpHttpApp({
    createServer: options.createServer,
    config,
  });
  const server = createNodeHttpServer({ app, config });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => resolve());
  });

  const url = publicUrl(config);
  options.onListening?.({ host: config.http.host, port: config.http.port, url });

  let closing: Promise<void> | undefined;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      await app.close();
    })();
    return closing;
  };

  const onSignal = () => {
    void close().finally(() => {
      // allow process to exit after graceful shutdown
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  if (options.signal) {
    if (options.signal.aborted) await close();
    else options.signal.addEventListener('abort', () => void close(), { once: true });
  }

  return { close, url, config };
}
