/**
 * Tiny shared state so tool spans (telemetry.ts) can wait for the SDK bootstrap
 * (otel.ts) without the two modules importing each other.
 */
let ready: Promise<unknown> | undefined;

export function setTracingReady(promise: Promise<unknown> | undefined): void {
  ready = promise;
}

/** Resolves once `startTracing()` has finished (or immediately when it was never started). */
export async function awaitTracingReady(): Promise<void> {
  if (ready) await ready;
}
