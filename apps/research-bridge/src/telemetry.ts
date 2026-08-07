import { useAzureMonitor } from '@azure/monitor-opentelemetry';
import { SpanStatusCode, trace } from '@opentelemetry/api';

let initialized = false;
const tracerName = 'ppbf-research-bridge';

export function initializeTelemetry(connectionString?: string): void {
  if (!connectionString || initialized) {
    return;
  }
  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      disableOfflineStorage: true,
    },
    instrumentationOptions: {
      http: { enabled: false },
      azureSdk: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      postgreSql: { enabled: false },
      redis: { enabled: false },
      redis4: { enabled: false },
      console: { enabled: false },
    },
    enableLiveMetrics: false,
    enablePerformanceCounters: false,
  });
  initialized = true;
}

export function trackSafeEvent(name: string, properties: Record<string, string | number | boolean> = {}): void {
  if (initialized) {
    const span = trace.getTracer(tracerName).startSpan(name, { attributes: properties });
    span.end();
  }
  console.log(JSON.stringify({ event: name, ...properties }));
}

/**
 * Diagnostic fields that are safe to emit for any error.
 *
 * These come from the error's *shape*, never from a message body, so no
 * sanitized-export content and no athlete-identifying data can reach telemetry
 * through them. Reducing an error to `error.name` alone -- which is all this
 * used to emit -- made a real failure ('TypeError') undiagnosable: no class, no
 * code, no HTTP status, nothing to distinguish an SDK bug from a 403. An Azure
 * RestError's statusCode is exactly the fact needed to tell "the role is
 * missing" apart from "the client threw before it ever called the service".
 */
function safeDiagnostics(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) {
    return { error_type: 'UnknownError' };
  }

  const candidate = error as Error & {
    code?: unknown;
    statusCode?: unknown;
    cause?: unknown;
  };
  const diagnostics: Record<string, string | number> = { error_type: error.name };

  const className = Object.getPrototypeOf(error)?.constructor?.name;
  if (typeof className === 'string' && className !== error.name) {
    diagnostics.error_class = className;
  }
  if (typeof candidate.code === 'string' || typeof candidate.code === 'number') {
    diagnostics.error_code = candidate.code;
  }
  if (typeof candidate.statusCode === 'number') {
    diagnostics.status_code = candidate.statusCode;
  }

  // A `cause` carries the underlying transport failure (ENOTFOUND, ECONNREFUSED,
  // certificate errors). Only its code is taken -- never its message.
  const cause = candidate.cause;
  if (cause instanceof Error) {
    const causeCode = (cause as Error & { code?: unknown }).code;
    diagnostics.cause_type = cause.name;
    if (typeof causeCode === 'string' || typeof causeCode === 'number') {
      diagnostics.cause_code = causeCode;
    }
  }

  return diagnostics;
}

export function trackSafeException(error: unknown, operation: string): void {
  const safeMessage = error instanceof Error
    && /^(ManagedIdentityTokenUnavailable|StagingExportHttp\d{3})$/.test(error.message)
    ? error.message
    : error instanceof Error
      ? error.name
      : 'UnknownError';
  const diagnostics = safeDiagnostics(error);
  const safeError = new Error(safeMessage);
  if (initialized) {
    const span = trace.getTracer(tracerName).startSpan('bridge.error', {
      attributes: { operation, ...diagnostics },
    });
    span.recordException(safeError);
    span.setStatus({ code: SpanStatusCode.ERROR, message: safeError.message });
    span.end();
  }
  console.error(JSON.stringify({
    event: 'bridge.error',
    operation,
    ...diagnostics,
    error_type: safeError.message,
  }));
}
