import { McpServer } from '@modelcontextprotocol/server';
import type * as OtelApi from '@opentelemetry/api';

type Api = typeof OtelApi;

const TRACER_NAME = '@kieksme/mcp-http-kit';
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_PAYLOAD_ATTRIBUTE_LENGTH = 4096;

export type TelemetrySettings = {
  /**
   * Use `params._meta.traceparent` / `tracestate` as the parent of the tool span.
   * Off for unauthenticated HTTP: any client could otherwise inject trace IDs.
   */
  trustIncomingContext: boolean;
  /** Record tool arguments, results and error messages on spans (privacy: opt-in). */
  recordPayloads: boolean;
};

export type InstallTelemetryOptions = {
  env?: NodeJS.ProcessEnv;
  trustIncomingContext: boolean;
};

type ToolCallback = (...args: unknown[]) => unknown;
type RegisterTool = (name: string, config: unknown, cb: unknown) => unknown;

let settings: TelemetrySettings = { trustIncomingContext: false, recordPayloads: false };
let originalRegisterTool: RegisterTool | undefined;
let apiPromise: Promise<Api | undefined> | undefined;

/**
 * Tracing is off unless an OTLP endpoint is configured (and the SDK is not disabled).
 * The kit only emits spans through `@opentelemetry/api`; exporting is up to the app.
 */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  return Boolean(
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim(),
  );
}

/** Payload recording (tool arguments / results / error messages) is opt-in. */
export function isPayloadRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_OTEL_RECORD_PAYLOADS?.trim().toLowerCase() === 'true';
}

/**
 * Wrap `McpServer.prototype.registerTool` so every tool call runs in a server span.
 * Must run before `createServer` registers tools. No-op (returns false) when tracing is off.
 * Idempotent; a later call only updates the settings.
 */
export function installTelemetry(options: InstallTelemetryOptions): boolean {
  const env = options.env ?? process.env;
  if (!isTelemetryEnabled(env)) return false;

  settings = {
    trustIncomingContext: options.trustIncomingContext,
    recordPayloads: isPayloadRecordingEnabled(env),
  };

  if (!originalRegisterTool) {
    const proto = McpServer.prototype as unknown as { registerTool: RegisterTool };
    const original = proto.registerTool;
    originalRegisterTool = original;
    proto.registerTool = function (this: McpServer, name, config, cb) {
      const wrapped = typeof cb === 'function' ? wrapToolCallback(name, cb as ToolCallback) : cb;
      return original.call(this, name, config, wrapped);
    };
  }
  return true;
}

/** Restore the original `registerTool` (tests). */
export function uninstallTelemetry(): void {
  if (!originalRegisterTool) return;
  (McpServer.prototype as unknown as { registerTool: RegisterTool }).registerTool =
    originalRegisterTool;
  originalRegisterTool = undefined;
  apiPromise = undefined;
}

function loadApi(): Promise<Api | undefined> {
  apiPromise ??= import('@opentelemetry/api').then(
    api => api,
    () => {
      console.warn(
        '[mcp-http-kit] Tracing is enabled but @opentelemetry/api is not installed; tracing skipped',
      );
      return undefined;
    },
  );
  return apiPromise;
}

/** Parse `traceparent` (version 00 only) and optional `tracestate` from request `_meta`. */
function remoteSpanContext(api: Api, meta: unknown): OtelApi.SpanContext | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const { traceparent, tracestate } = meta as Record<string, unknown>;
  if (typeof traceparent !== 'string') return undefined;
  const match = TRACEPARENT_RE.exec(traceparent);
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16) & api.TraceFlags.SAMPLED,
    isRemote: true,
    ...(typeof tracestate === 'string' && tracestate.length <= MAX_TRACESTATE_LENGTH
      ? { traceState: api.createTraceState(tracestate) }
      : {}),
  };
}

function truncate(value: string): string {
  return value.length > MAX_PAYLOAD_ATTRIBUTE_LENGTH
    ? `${value.slice(0, MAX_PAYLOAD_ATTRIBUTE_LENGTH)}…`
    : value;
}

function toJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? 'undefined');
  } catch {
    return '[unserializable]';
  }
}

function wrapToolCallback(name: string, cb: ToolCallback): ToolCallback {
  return async (...cbArgs: unknown[]) => {
    const api = await loadApi();
    if (!api) return cb(...cbArgs);

    // Tool callbacks are `(args, ctx)` or, without an input schema, `(ctx)`.
    const ctx = cbArgs[cbArgs.length - 1] as { mcpReq?: { _meta?: unknown } } | undefined;
    const toolArgs = cbArgs.length > 1 ? cbArgs[0] : undefined;

    let parent = api.context.active();
    if (settings.trustIncomingContext) {
      const remote = remoteSpanContext(api, ctx?.mcpReq?._meta);
      if (remote) parent = api.trace.setSpanContext(parent, remote);
    }

    const { recordPayloads } = settings;
    return api.trace.getTracer(TRACER_NAME).startActiveSpan(
      `tools/call ${name}`,
      {
        kind: api.SpanKind.SERVER,
        attributes: {
          'mcp.method.name': 'tools/call',
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': name,
        },
      },
      parent,
      async span => {
        try {
          if (recordPayloads && toolArgs !== undefined) {
            span.setAttribute('mcp.tool.arguments', toJson(toolArgs));
          }
          const result = await cb(...cbArgs);
          if ((result as { isError?: unknown } | null)?.isError === true) {
            span.setAttribute('error.type', 'tool_error');
            span.setStatus({ code: api.SpanStatusCode.ERROR });
          }
          if (recordPayloads) span.setAttribute('mcp.tool.result', toJson(result));
          return result;
        } catch (error) {
          // Message and stack may contain user input; keep only the error class by default.
          span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
          span.setStatus({ code: api.SpanStatusCode.ERROR });
          if (recordPayloads && error instanceof Error) span.recordException(error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  };
}
