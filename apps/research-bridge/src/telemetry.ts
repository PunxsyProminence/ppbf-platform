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

export function trackSafeException(error: unknown, operation: string): void {
  const safeError = error instanceof Error ? new Error(error.name) : new Error('UnknownError');
  if (initialized) {
    const span = trace.getTracer(tracerName).startSpan('bridge.error', { attributes: { operation } });
    span.recordException(safeError);
    span.setStatus({ code: SpanStatusCode.ERROR, message: safeError.message });
    span.end();
  }
  console.error(JSON.stringify({ event: 'bridge.error', operation, error_type: safeError.message }));
}
