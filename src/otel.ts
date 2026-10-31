import { createRequire } from 'node:module';
import type * as OtelApi from '@opentelemetry/api';
import type * as ContextHooks from '@opentelemetry/context-async-hooks';
import type * as OtlpExporter from '@opentelemetry/exporter-trace-otlp-http';
import type * as HttpInstrumentationModule from '@opentelemetry/instrumentation-http';
import type * as UndiciInstrumentationModule from '@opentelemetry/instrumentation-undici';
import type * as Resources from '@opentelemetry/resources';
import type * as SdkTrace from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { sanitizeSpan } from './otel-sanitize.js';
import { setTracingReady } from './otel-state.js';
import { isPayloadRecordingEnabled, isTelemetryEnabled } from './telemetry.js';

type Api = typeof OtelApi;
type Loader = (name: string) => Promise<unknown>;

export type TracingHandle = {
  forceFlush: () => Promise<void>;
  /** Flush, stop the instrumentations and unregister the globals the kit set up. */
  shutdown: () => Promise<void>;
};

export type StartTracingOptions = {
  env?: NodeJS.ProcessEnv;
  /** `service.name` fallback; `OTEL_SERVICE_NAME` wins. */
  serviceName?: string;
  /** Replaces `import()` for the optional OpenTelemetry packages (tests). */
  load?: Loader;
};

type Instrumentation = {
  enable: () => void;
  disable: () => void;
  setTracerProvider: (provider: OtelApi.TracerProvider) => void;
};

const REQUIRED = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/context-async-hooks',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
] as const;

const defaultLoader: Loader = name => import(name);

let starting: Promise<TracingHandle | undefined> | undefined;
let instrumentation: { http?: Instrumentation; undici?: Instrumentation } | undefined;

async function createInstrumentations(
  want: (name: string) => Promise<unknown>,
): Promise<{ http?: Instrumentation; undici?: Instrumentation }> {
  const created: { http?: Instrumentation; undici?: Instrumentation } = {};
  const httpModule = (await want('@opentelemetry/instrumentation-http')) as
    | typeof HttpInstrumentationModule
    | undefined;
  if (httpModule) {
    created.http = new httpModule.HttpInstrumentation({
      // Only outgoing calls made inside a tool call: no health-check/JWKS noise, no server spans.
      ignoreIncomingRequestHook: () => true,
      requireParentforOutgoingSpans: true,
    }) as Instrumentation;
    created.http.enable();
    // The application usually imported `node:http` before this runs; a `require()` after enable()
    // makes the instrumentation patch the already loaded modules in place (axios keeps working).
    const require = createRequire(import.meta.url);
    require('node:http');
    require('node:https');
  }
  const undiciModule = (await want('@opentelemetry/instrumentation-undici')) as
    | typeof UndiciInstrumentationModule
    | undefined;
  if (undiciModule) {
    created.undici = new undiciModule.UndiciInstrumentation({
      requireParentforSpans: true,
    }) as Instrumentation;
    created.undici.enable();
  }
  return created;
}

/**
 * Start a minimal OpenTelemetry SDK for the process: OTLP/HTTP trace exporter, W3C trace
 * context propagation (never baggage) and instrumentation of outgoing `node:http(s)` (axios, ...)
 * and `fetch` calls. Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * The OpenTelemetry packages are optional peer dependencies; when one is missing this logs one
 * line and returns `undefined` (the server keeps working, only without exported spans).
 * An SDK the application registered itself is left alone. Idempotent.
 */
export function startTracing(options: StartTracingOptions = {}): Promise<TracingHandle | undefined> {
  const env = options.env ?? process.env;
  if (!isTelemetryEnabled(env)) return Promise.resolve(undefined);
  starting ??= bootstrap(options, env).catch(error => {
    console.error(
      `[mcp-http-kit] Tracing setup failed, continuing without exported spans: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  });
  setTracingReady(starting);
  return starting;
}

async function bootstrap(
  options: StartTracingOptions,
  env: NodeJS.ProcessEnv,
): Promise<TracingHandle | undefined> {
  const load = options.load ?? defaultLoader;
  const missing: string[] = [];
  const need = async (name: string): Promise<unknown> => {
    try {
      return await load(name);
    } catch {
      missing.push(name);
      return undefined;
    }
  };
  const want = async (name: string): Promise<unknown> => {
    try {
      return await load(name);
    } catch {
      return undefined;
    }
  };

  const [api, sdk, hooks, otlp, resources] = (await Promise.all(REQUIRED.map(need))) as [
    Api | undefined,
    typeof SdkTrace | undefined,
    typeof ContextHooks | undefined,
    typeof OtlpExporter | undefined,
    typeof Resources | undefined,
  ];
  if (!api || !sdk || !hooks || !otlp || !resources) {
    console.error(
      `[mcp-http-kit] OTEL_EXPORTER_OTLP_ENDPOINT is set but these packages are not installed: ${missing.join(', ')}. ` +
        'Install them next to the server (see the README, "Tracing") to export spans.',
    );
    return undefined;
  }

  // An application that registered its own SDK (e.g. NodeSDK) keeps full control.
  const delegate = (api.trace.getTracerProvider() as { getDelegate?: () => object }).getDelegate?.();
  if (delegate && delegate.constructor.name !== 'NoopTracerProvider') {
    console.error('[mcp-http-kit] A tracer provider is already registered; using it, not installing the kit SDK');
    return undefined;
  }

  const recordPayloads = isPayloadRecordingEnabled(env);
  const provider = new sdk.TracerProvider({
    resource: resources.resourceFromAttributes({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || options.serviceName || 'mcp-server',
    }),
    spanProcessors: [
      new sdk.BatchSpanProcessor({
        exporter: new UrlSanitizingExporter(new otlp.OTLPTraceExporter(exporterOptions(env)), !recordPayloads),
      }),
    ],
  });
  if (!api.trace.setGlobalTracerProvider(provider)) {
    await provider.shutdown();
    return undefined;
  }
  api.context.setGlobalContextManager(new hooks.AsyncLocalStorageContextManager().enable());
  api.propagation.setGlobalPropagator(new TraceContextOnlyPropagator(api));

  instrumentation ??= await createInstrumentations(want);
  // Cached instances keep the tracer of an earlier provider; point them at this one.
  instrumentation.http?.setTracerProvider(provider);
  instrumentation.undici?.setTracerProvider(provider);
  console.error(
    `[mcp-http-kit] Tracing enabled (OTLP/HTTP). Outgoing call instrumentation: ${
      [instrumentation.http && 'http', instrumentation.undici && 'fetch'].filter(Boolean).join(', ') || 'none installed'
    }${recordPayloads ? '; payload recording ON' : ''}`,
  );

  const flushAtExit = () => void provider.forceFlush().catch(() => undefined);
  process.once('beforeExit', flushAtExit);

  return {
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      process.removeListener('beforeExit', flushAtExit);
      // The instrumentations stay patched but inert (no provider, no propagator): re-enabling
      // `node:http` patching in the same process does not work with OpenTelemetry's require hook.
      await provider.shutdown();
      api.trace.disable();
      api.context.disable();
      api.propagation.disable();
      starting = undefined;
      setTracingReady(undefined);
    },
  };
}

/** Stop the SDK started by `startTracing()` and allow a fresh start (no-op when it never ran). */
export async function shutdownTracing(): Promise<void> {
  if (!starting) return;
  const handle = await starting;
  await handle?.shutdown();
  starting = undefined;
  setTracingReady(undefined);
}

/**
 * Endpoint and headers from the given env (`OTEL_EXPORTER_OTLP_[TRACES_]ENDPOINT` / `..._HEADERS`),
 * so `startTracing({ env })` behaves like the process environment. Everything else (timeout,
 * compression, certificates) still comes from the exporter's own `process.env` handling.
 * Header values can carry credentials: they are passed on, never logged.
 */
function exporterOptions(env: NodeJS.ProcessEnv): { url?: string; headers?: Record<string, string> } {
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = tracesEndpoint || (endpoint ? `${endpoint.replace(/\/+$/, '')}/v1/traces` : undefined);
  const rawHeaders =
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim() || env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  const headers: Record<string, string> = {};
  for (const pair of rawHeaders?.split(',') ?? []) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value.trim());
      } catch {
        return value.trim();
      }
    };
    headers[decode(pair.slice(0, index))] = decode(pair.slice(index + 1));
  }
  return {
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Sends only `traceparent` / `tracestate` to upstream services. The default W3C propagator of
 * the OpenTelemetry SDKs also forwards baggage, which would leak caller context to third parties.
 */
class TraceContextOnlyPropagator {
  constructor(private readonly api: Api) {}

  inject(
    context: OtelApi.Context,
    carrier: unknown,
    setter: OtelApi.TextMapSetter,
  ): void {
    const spanContext = this.api.trace.getSpanContext(context);
    if (!spanContext || !this.api.isSpanContextValid(spanContext)) return;
    const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
    setter.set(carrier, 'traceparent', `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`);
    const traceState = spanContext.traceState?.serialize();
    if (traceState) setter.set(carrier, 'tracestate', traceState);
  }

  extract(context: OtelApi.Context): OtelApi.Context {
    return context;
  }

  fields(): string[] {
    return ['traceparent', 'tracestate'];
  }
}

/**
 * Query strings carry filters, search terms and sometimes tokens (Listmonk sends SQL filters
 * there), so they never leave the process unless payload recording is switched on.
 */
class UrlSanitizingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly strip: boolean,
  ) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(this.strip ? spans.map(sanitizeSpan) : spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
