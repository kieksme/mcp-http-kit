import { McpServer } from '@modelcontextprotocol/server';
import {
  context,
  trace,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import * as z from 'zod/v4';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMcpHttpApp } from '../src/http/app.js';
import { createAppTestClient, readMcpJsonResponse } from '../src/test/helpers.js';
import {
  installTelemetry,
  isPayloadRecordingEnabled,
  isTelemetryEnabled,
  uninstallTelemetry,
} from '../src/telemetry.js';
import type { RequestContext } from '../src/types.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;
const ENABLED_ENV = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };

type RecordedSpan = {
  name: string;
  kind: number | undefined;
  attributes: Attributes;
  parent: SpanContext | undefined;
  status: { code: SpanStatusCode } | undefined;
  exceptions: unknown[];
  ended: boolean;
  /** Span context seen by code running inside the span (outgoing-call parenting). */
  activeInside: SpanContext | undefined;
};

/** Minimal in-memory tracer: no SDK needed to assert on what the kit emits. */
function createRecordingProvider(spans: RecordedSpan[]): TracerProvider {
  let counter = 0;
  const tracer: Tracer = {
    startSpan: () => {
      throw new Error('not used');
    },
    startActiveSpan: ((
      name: string,
      options: SpanOptions,
      parentCtx: Context,
      fn: (span: Span) => unknown,
    ) => {
      const parent = trace.getSpanContext(parentCtx);
      const spanContext: SpanContext = {
        traceId: parent?.traceId ?? 'a'.repeat(32),
        spanId: (++counter).toString(16).padStart(16, '0'),
        traceFlags: parent?.traceFlags ?? 1,
      };
      const record: RecordedSpan = {
        name,
        kind: options.kind,
        attributes: { ...options.attributes },
        parent,
        status: undefined,
        exceptions: [],
        ended: false,
        activeInside: undefined,
      };
      spans.push(record);
      const span = {
        spanContext: () => spanContext,
        setAttribute(key: string, value: never) {
          record.attributes[key] = value;
          return span;
        },
        setStatus(status: { code: SpanStatusCode }) {
          record.status = status;
          return span;
        },
        recordException(error: unknown) {
          record.exceptions.push(error);
        },
        end() {
          record.ended = true;
        },
      } as unknown as Span;
      return context.with(trace.setSpan(parentCtx, span), () => {
        record.activeInside = trace.getActiveSpan()?.spanContext();
        return fn(span);
      });
    }) as Tracer['startActiveSpan'],
  };
  return { getTracer: () => tracer };
}

function createTestServer(_ctx: RequestContext): McpServer {
  const server = new McpServer({ name: 'kit-test-server', version: '0.0.0' });
  server.registerTool(
    'greet',
    { description: 'Greet', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ content: [{ type: 'text' as const, text: `hi ${name}` }] }),
  );
  server.registerTool(
    'no-input',
    { description: 'Tool without input schema' },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  server.registerTool(
    'soft-fail',
    { description: 'Returns isError' },
    async () => ({ isError: true, content: [{ type: 'text' as const, text: 'secret detail' }] }),
  );
  server.registerTool('boom', { description: 'Throws' }, async () => {
    throw new TypeError('contains user@example.com');
  });
  return server;
}

async function callTool(
  client: ReturnType<typeof createAppTestClient>,
  name: string,
  args: unknown,
  meta?: Record<string, unknown>,
): Promise<unknown> {
  const headers = { 'content-type': 'application/json' };
  const init = await client.mcp({
    headers,
    token: 't',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'kit-test', version: '0' },
      },
    }),
  });
  await init.text();
  const response = await client.mcp({
    headers,
    token: 't',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  return readMcpJsonResponse(response);
}

describe('telemetry switches', () => {
  it('is off by default and for a disabled SDK', () => {
    expect(isTelemetryEnabled({})).toBe(false);
    expect(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false);
    expect(isTelemetryEnabled({ ...ENABLED_ENV, OTEL_SDK_DISABLED: 'true' })).toBe(false);
  });

  it('turns on with a traces or general OTLP endpoint', () => {
    expect(isTelemetryEnabled(ENABLED_ENV)).toBe(true);
    expect(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://x' })).toBe(true);
  });

  it('keeps payload recording off unless explicitly enabled', () => {
    expect(isPayloadRecordingEnabled({})).toBe(false);
    expect(isPayloadRecordingEnabled({ MCP_OTEL_RECORD_PAYLOADS: 'false' })).toBe(false);
    expect(isPayloadRecordingEnabled({ MCP_OTEL_RECORD_PAYLOADS: 'true' })).toBe(true);
  });

  it('does not touch registerTool when disabled', () => {
    const before = McpServer.prototype.registerTool;
    expect(installTelemetry({ env: {}, trustIncomingContext: true })).toBe(false);
    expect(McpServer.prototype.registerTool).toBe(before);
  });
});

describe('tool spans', () => {
  const spans: RecordedSpan[] = [];
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(createRecordingProvider(spans));
  });
  afterAll(() => {
    trace.disable();
    context.disable();
  });
  afterEach(() => {
    uninstallTelemetry();
    spans.length = 0;
  });

  function setup(env: NodeJS.ProcessEnv, authToken?: boolean) {
    const config = loadConfig(
      {
        MCP_TRANSPORT: 'http',
        ...(authToken === false ? { MCP_AUTH_MODE: 'none' } : { MCP_AUTH_TOKEN: 't' }),
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_HTTP_PORT: '3457',
        MCP_ALLOWED_HOSTS: '127.0.0.1,localhost',
      },
      { realm: 'kit-test' },
    );
    const app = createMcpHttpApp({ createServer: createTestServer, config, env });
    return { app, client: createAppTestClient(app, config) };
  }

  it('creates no spans when tracing is not enabled', async () => {
    const { app, client } = setup({});
    await callTool(client, 'greet', { name: 'Ada' });
    await app.close();
    expect(spans).toHaveLength(0);
  });

  it('creates a server span per tool call without recording content', async () => {
    const { app, client } = setup(ENABLED_ENV);
    const response = await callTool(client, 'greet', { name: 'Ada' });
    await app.close();

    expect(JSON.stringify(response)).toContain('hi Ada');
    expect(spans).toHaveLength(1);
    const [span] = spans as [RecordedSpan];
    expect(span.name).toBe('tools/call greet');
    expect(span.kind).toBe(1); // SpanKind.SERVER
    expect(span.attributes).toEqual({
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'greet',
    });
    expect(span.ended).toBe(true);
    expect(JSON.stringify(span)).not.toContain('Ada');
  });

  it('continues the trace from params._meta (tracestate kept, baggage ignored)', async () => {
    const { app, client } = setup(ENABLED_ENV);
    await callTool(client, 'greet', { name: 'Ada' }, {
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
      baggage: 'userId=alice',
    });
    await app.close();

    const [span] = spans as [RecordedSpan];
    expect(span.parent?.traceId).toBe(TRACE_ID);
    expect(span.parent?.spanId).toBe(PARENT_SPAN_ID);
    expect(span.parent?.isRemote).toBe(true);
    expect(span.parent?.traceState?.serialize()).toBe('vendor=value');
    // Code inside the tool (e.g. an outgoing axios call) sees the span as active.
    expect(span.activeInside?.traceId).toBe(TRACE_ID);
  });

  it('starts a new trace for a malformed traceparent', async () => {
    const { app, client } = setup(ENABLED_ENV);
    await callTool(client, 'greet', { name: 'Ada' }, { traceparent: 'garbage' });
    await callTool(client, 'greet', { name: 'Ada' }, {
      traceparent: `00-${'0'.repeat(32)}-${PARENT_SPAN_ID}-01`,
    });
    await app.close();
    expect(spans.map(s => s.parent)).toEqual([undefined, undefined]);
  });

  it('ignores incoming context when HTTP auth is none', async () => {
    const { app, client } = setup(ENABLED_ENV, false);
    await callTool(client, 'greet', { name: 'Ada' }, { traceparent: TRACEPARENT });
    await app.close();
    const [span] = spans as [RecordedSpan];
    expect(span.parent).toBeUndefined();
    expect(span.activeInside?.traceId).not.toBe(TRACE_ID);
  });

  it('also wraps tools registered without an input schema', async () => {
    const { app, client } = setup(ENABLED_ENV);
    await callTool(client, 'no-input', {}, { traceparent: TRACEPARENT });
    await app.close();
    const [span] = spans as [RecordedSpan];
    expect(span.name).toBe('tools/call no-input');
    expect(span.parent?.traceId).toBe(TRACE_ID);
  });

  it('marks isError results and thrown errors without leaking messages', async () => {
    const { app, client } = setup(ENABLED_ENV);
    await callTool(client, 'soft-fail', {});
    await callTool(client, 'boom', {});
    await app.close();

    const [soft, boom] = spans as [RecordedSpan, RecordedSpan];
    expect(soft.status?.code).toBe(SpanStatusCode.ERROR);
    expect(soft.attributes['error.type']).toBe('tool_error');
    expect(boom.status?.code).toBe(SpanStatusCode.ERROR);
    expect(boom.attributes['error.type']).toBe('TypeError');
    expect(boom.exceptions).toHaveLength(0);
    expect(JSON.stringify(spans)).not.toContain('user@example.com');
    expect(JSON.stringify(spans)).not.toContain('secret detail');
    expect(boom.ended).toBe(true);
  });

  it('records arguments, results and exceptions only when opted in', async () => {
    const { app, client } = setup({ ...ENABLED_ENV, MCP_OTEL_RECORD_PAYLOADS: 'true' });
    await callTool(client, 'greet', { name: 'Ada' });
    await callTool(client, 'boom', {});
    await app.close();

    const [greet, boom] = spans as [RecordedSpan, RecordedSpan];
    expect(greet.attributes['mcp.tool.arguments']).toBe('{"name":"Ada"}');
    expect(String(greet.attributes['mcp.tool.result'])).toContain('hi Ada');
    expect(boom.exceptions).toHaveLength(1);
  });
});
