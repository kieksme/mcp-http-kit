import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { context, propagation, trace } from '@opentelemetry/api';
import axios from 'axios';
import * as z from 'zod/v4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMcpHttpApp } from '../src/http/app.js';
import { shutdownTracing, startTracing, type TracingHandle } from '../src/otel.js';
import { sanitizeSpan, stripUrl } from '../src/otel-sanitize.js';
import { createAppTestClient, readMcpJsonResponse } from '../src/test/helpers.js';
import { uninstallTelemetry } from '../src/telemetry.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;
const TOKEN = 'otel-test-token';

type ExportedSpan = {
  scope: string;
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  serviceName: string | undefined;
};

type OtlpAttribute = { key: string; value: Record<string, unknown> };
type OtlpJson = {
  resourceSpans: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string };
      spans: Array<{
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        attributes?: OtlpAttribute[];
      }>;
    }>;
  }>;
};

type Servers = {
  otlpUrl: string;
  upstreamUrl: string;
  otlpBodies: string[];
  upstreamRequests: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** A local OTLP/HTTP receiver (stands in for Jaeger / Aspire) and a fake upstream API. */
async function startServers(): Promise<Servers> {
  const otlpBodies: string[] = [];
  const upstreamRequests: http.IncomingHttpHeaders[] = [];
  const otlp = await listen((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      if (req.url === '/v1/traces') otlpBodies.push(body);
      res.end('{}');
    });
  });
  const upstream = await listen((req, res) => {
    upstreamRequests.push({ ...req.headers, 'x-test-url': req.url ?? '' });
    res.end('{}');
  });
  const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const servers: Servers = {
    otlpUrl: url(otlp),
    upstreamUrl: url(upstream),
    otlpBodies,
    upstreamRequests,
    close: async () => {
      await Promise.all(
        [otlp, upstream].map(
          server => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))),
        ),
      );
    },
  };
  cleanups.push(servers.close);
  return servers;
}

function decode(bodies: string[]): ExportedSpan[] {
  return bodies.flatMap(body =>
    (JSON.parse(body) as OtlpJson).resourceSpans.flatMap(resourceSpan => {
      const serviceName = resourceSpan.resource?.attributes?.find(a => a.key === 'service.name')?.value
        .stringValue as string | undefined;
      return resourceSpan.scopeSpans.flatMap(scopeSpan =>
        scopeSpan.spans.map(span => ({
          scope: scopeSpan.scope.name,
          name: span.name,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId || undefined,
          attributes: Object.fromEntries(
            (span.attributes ?? []).map(a => [a.key, Object.values(a.value)[0]]),
          ),
          serviceName,
        })),
      );
    }),
  );
}

/** Calls the upstream API with node:http and fetch, like axios / fetch based tools do. */
function createLookupServer(upstreamUrl: string): McpServer {
  const server = new McpServer({ name: 'otel-test-server', version: '0.0.0' });
  server.registerTool(
    'lookup',
    { description: 'Calls an upstream API', inputSchema: z.object({ term: z.string() }) },
    async ({ term }) => {
      // The application puts baggage on the active context; it must still never reach the upstream.
      const withBaggage = propagation.setBaggage(
        context.active(),
        propagation.createBaggage({ userId: { value: 'alice' } }),
      );
      await context.with(
        withBaggage,
        () =>
          new Promise<void>((resolve, reject) =>
            http
              .get(`${upstreamUrl}/subscribers?query=email%3D%27a%40b.com%27&token=geheim`, res => {
                res.resume();
                res.on('end', resolve);
              })
              .on('error', reject),
          ),
      );
      await fetch(`${upstreamUrl}/v1/instances?name=${encodeURIComponent(term)}`).then(r => r.text());
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  // The call patterns of mcp-hashnode (maxRedirects: 0) and mcp-listmonk (axios.create + params).
  server.registerTool(
    'lookup-axios',
    { description: 'Calls an upstream API with axios', inputSchema: z.object({ term: z.string() }) },
    async () => {
      await axios.post(
        `${upstreamUrl}/graphql?token=geheim`,
        { query: '{ me { id } }' },
        { headers: { Authorization: 'secret-pat' }, timeout: 30_000, maxRedirects: 0 },
      );
      await axios
        .create({ baseURL: upstreamUrl })
        .get('/api/subscribers', { params: { query: "subscribers.email LIKE '%@x.com'" } });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  return server;
}

async function callLookup(
  servers: Servers,
  env: NodeJS.ProcessEnv,
  meta?: Record<string, unknown>,
  tool = 'lookup',
): Promise<void> {
  const config = loadConfig(
    {
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: TOKEN,
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '3458',
      MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
    },
    { realm: 'otel-test' },
  );
  const app = createMcpHttpApp({
    createServer: () => createLookupServer(servers.upstreamUrl),
    config,
    env,
  });
  cleanups.push(() => app.close());
  const client = createAppTestClient(app, config);
  const headers = { 'content-type': 'application/json' };
  await (
    await client.mcp({
      token: TOKEN,
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'otel-test', version: '0' },
        },
      }),
    })
  ).text();
  const response = await client.mcp({
    token: TOKEN,
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: tool,
        arguments: { term: 'sehr-geheimer-suchbegriff' },
        ...(meta ? { _meta: meta } : {}),
      },
    }),
  });
  expect(JSON.stringify(await readMcpJsonResponse(response))).toContain('ok');
}

let handle: TracingHandle | undefined;

afterEach(async () => {
  await shutdownTracing();
  handle = undefined;
  uninstallTelemetry();
  trace.disable();
  context.disable();
  propagation.disable();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

describe('startTracing (end to end against a local OTLP receiver)', () => {
  it('exports one trace: tool span under the caller, outgoing calls under the tool', async () => {
    const servers = await startServers();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl };
    handle = await startTracing({ env, serviceName: 'otel-test' });
    expect(handle).toBeDefined();

    await callLookup(servers, env, {
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
      baggage: 'userId=alice',
    });
    // Baggage that the application itself puts on the active context must not leave the process either.
    await handle!.forceFlush();

    const spans = decode(servers.otlpBodies);
    const tool = spans.find(s => s.name === 'tools/call lookup');
    expect(tool).toBeDefined();
    expect(tool!.traceId).toBe(TRACE_ID);
    expect(tool!.parentSpanId).toBe(PARENT_SPAN_ID);
    expect(tool!.serviceName).toBe('otel-test');

    const clients = spans.filter(s => s.scope.startsWith('@opentelemetry/instrumentation-'));
    expect(clients.map(s => s.scope).sort()).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-undici',
    ]);
    for (const clientSpan of clients) {
      expect(clientSpan.traceId).toBe(TRACE_ID);
      expect(clientSpan.parentSpanId).toBe(tool!.spanId);
    }

    // The upstream API sees the same trace, and never any baggage.
    expect(servers.upstreamRequests).toHaveLength(2);
    for (const headers of servers.upstreamRequests) {
      expect(String(headers.traceparent)).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
      expect(headers.baggage).toBeUndefined();
    }
  });

  it('traces axios calls under the tool span, with credentials and filters kept out', async () => {
    const servers = await startServers();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl };
    handle = await startTracing({ env, serviceName: 'otel-test' });

    await callLookup(servers, env, { traceparent: TRACEPARENT }, 'lookup-axios');
    await handle!.forceFlush();

    const spans = decode(servers.otlpBodies);
    const tool = spans.find(s => s.name === 'tools/call lookup-axios');
    expect(tool?.traceId).toBe(TRACE_ID);
    const outgoing = spans.filter(s => s.scope === '@opentelemetry/instrumentation-http');
    expect(outgoing.map(s => s.name).sort()).toEqual(['GET', 'POST']);
    for (const span of outgoing) {
      expect(span.traceId).toBe(TRACE_ID);
      expect(span.parentSpanId).toBe(tool!.spanId);
      expect(String(span.attributes['url.full'])).not.toContain('?');
    }
    expect(servers.upstreamRequests).toHaveLength(2);
    for (const headers of servers.upstreamRequests) {
      expect(String(headers.traceparent)).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    }
    const raw = servers.otlpBodies.join('\n');
    expect(raw).not.toContain('secret-pat');
    expect(raw).not.toContain('LIKE');
    expect(raw).not.toContain('geheim');
  });

  it('keeps tool arguments, query strings and credentials out of the exported spans', async () => {
    const servers = await startServers();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl };
    handle = await startTracing({ env, serviceName: 'otel-test' });

    await callLookup(servers, env, { traceparent: TRACEPARENT });
    await handle!.forceFlush();

    const raw = servers.otlpBodies.join('\n');
    expect(raw).not.toContain('sehr-geheimer-suchbegriff');
    expect(raw).not.toContain('geheim');
    expect(raw).not.toContain('email');
    const urls = decode(servers.otlpBodies)
      .map(s => s.attributes['url.full'])
      .filter(Boolean) as string[];
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).not.toContain('?');
    expect(urls.some(url => url.endsWith('/subscribers'))).toBe(true);
    for (const span of decode(servers.otlpBodies)) expect(span.attributes).not.toHaveProperty('url.query');
  });

  it('keeps full URLs only when payload recording is switched on', async () => {
    const servers = await startServers();
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl,
      MCP_OTEL_RECORD_PAYLOADS: 'true',
    };
    handle = await startTracing({ env, serviceName: 'otel-test' });

    await callLookup(servers, env, { traceparent: TRACEPARENT });
    await handle!.forceFlush();

    const urls = decode(servers.otlpBodies)
      .map(s => s.attributes['url.full'])
      .filter(Boolean) as string[];
    expect(urls.some(url => url.includes('token=geheim'))).toBe(true);
  });

  it('does not trace outgoing calls made outside a tool call', async () => {
    const servers = await startServers();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl };
    handle = await startTracing({ env, serviceName: 'otel-test' });

    await new Promise<void>(resolve =>
      http.get(`${servers.upstreamUrl}/jwks?x=1`, res => (res.resume(), res.on('end', resolve))),
    );
    await fetch(`${servers.upstreamUrl}/health`).then(r => r.text());
    await handle!.forceFlush();

    expect(decode(servers.otlpBodies)).toEqual([]);
    expect(servers.upstreamRequests.some(h => h.traceparent)).toBe(false);
  });

  it('does nothing without an OTLP endpoint', async () => {
    const servers = await startServers();
    expect(await startTracing({ env: {} })).toBeUndefined();
    await fetch(`${servers.upstreamUrl}/x`).then(r => r.text());
    expect(servers.otlpBodies).toEqual([]);
    const delegate = (trace.getTracerProvider() as unknown as { getDelegate: () => object }).getDelegate();
    expect(delegate.constructor.name).toBe('NoopTracerProvider');
  });

  it('keeps an SDK the application registered itself', async () => {
    const servers = await startServers();
    const own = { getTracer: () => trace.getTracer('x') } as never;
    trace.setGlobalTracerProvider(own);
    const info = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await startTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl } });

    expect(result).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('already registered'));
  });

  it('logs one line and carries on when the OpenTelemetry packages are missing', async () => {
    const servers = await startServers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await startTracing({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: servers.otlpUrl },
      load: name =>
        name === '@opentelemetry/exporter-trace-otlp-http'
          ? Promise.reject(new Error('not installed'))
          : import(name),
    });

    expect(result).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain('@opentelemetry/exporter-trace-otlp-http');
  });
});

describe('URL sanitizing', () => {
  it('strips query, fragment and credentials', () => {
    expect(stripUrl('http://user:pw@host:8080/a/b?x=1&y=2#frag')).toBe('http://host:8080/a/b');
    expect(stripUrl('/a/b?x=1')).toBe('/a/b');
    expect(stripUrl('http://host/a')).toBe('http://host/a');
  });

  it('returns the very same span when there is nothing to remove', () => {
    const span = { attributes: { 'url.full': 'http://host/a', 'http.request.method': 'GET' } } as never;
    expect(sanitizeSpan(span)).toBe(span);
  });

  it('copies the span instead of mutating it', () => {
    const attributes = {
      'url.full': 'http://host/a?token=1',
      'url.query': '?token=1',
      'http.target': '/a?token=1',
      'http.method': 'GET',
    };
    const span = { attributes, name: 'GET' } as never as { attributes: typeof attributes; name: string };
    const clean = sanitizeSpan(span as never) as unknown as { attributes: Record<string, unknown>; name: string };
    expect(clean.attributes).toEqual({
      'url.full': 'http://host/a',
      'http.target': '/a',
      'http.method': 'GET',
    });
    expect(clean.name).toBe('GET');
    expect(span.attributes['url.full']).toBe('http://host/a?token=1');
  });
});
