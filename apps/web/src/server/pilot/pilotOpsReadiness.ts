// pilotOpsReadiness.ts -- answers "why didn't X run?" for the production
// flags that silently gate SHADOW, video, and rate-limit behavior.
//
// PPBF_SHADOW_WORKER_ENABLED, PPBF_VIDEO_MALWARE_SCAN / PPBF_VIDEO_CONTENT_SCAN,
// PPBF_INTAKE_PROMOTION_ENABLED, and PPBF_DURABLE_RATE_LIMIT all default OFF,
// and every one of them DEGRADES rather than errors when off -- a queued job
// sits pending, a quarantined video stays quarantined, a rate limiter falls
// back to in-memory. That is the correct behavior for each of them
// individually, and it is also exactly why an operator has no way to notice
// without reading source or a database. This module is that one place: pure,
// synchronous, no I/O, and it echoes back booleans and one-line reasons only
// -- never a connection string, a key, or any other secret.

import { isShadowWorkerEnabled } from './shadowJobWorker';
import { enabledScanGates, isVideoScanConfigured, resolveVideoScanConfig } from './videoScanPolicy';

export interface OpsReadinessFlag {
  enabled: boolean;
  reason: string;
}

export interface PilotOpsReadinessReport {
  shadowWorker: OpsReadinessFlag;
  videoScan: OpsReadinessFlag & { gates: string[] };
  intakePromotion: OpsReadinessFlag;
  durableRateLimit: OpsReadinessFlag;
}

export function buildPilotOpsReadinessReport(
  env: Record<string, string | undefined> = process.env,
): PilotOpsReadinessReport {
  const workerEnabled = isShadowWorkerEnabled(env);

  const scanConfig = resolveVideoScanConfig(env);
  const scanConfigured = isVideoScanConfigured(scanConfig);
  const gates = enabledScanGates(scanConfig);

  const promotionEnabled = env.PPBF_INTAKE_PROMOTION_ENABLED === 'true';

  // Mirrors rateLimit.ts's own withDurableClient guard exactly: durable rate
  // limiting is only really active when BOTH the flag is on AND a connection
  // string is present. Reporting the flag alone would say "durable" for an
  // environment that is silently falling back for the second reason.
  const durableFlagSet = env.PPBF_DURABLE_RATE_LIMIT === 'true';
  const hasPostgresConnection = Boolean(env.AZURE_POSTGRES_CONNECTION_STRING?.trim());
  const durableActive = durableFlagSet && hasPostgresConnection;

  return {
    shadowWorker: {
      enabled: workerEnabled,
      reason: workerEnabled
        ? 'PPBF_SHADOW_WORKER_ENABLED=true -- background jobs, the video scan sweep, and retention housekeeping run on a tick.'
        : 'PPBF_SHADOW_WORKER_ENABLED is not "true" -- queued async jobs (Film Study, etc.) will never drain, and the video scan sweep never runs.',
    },
    videoScan: {
      enabled: scanConfigured,
      gates,
      reason: scanConfigured
        ? `Configured gate(s): ${gates.join(', ')}. A quarantined video promotes once every enabled gate passes and the worker is running.`
        : 'Neither PPBF_VIDEO_MALWARE_SCAN nor PPBF_VIDEO_CONTENT_SCAN is set -- quarantined videos can never promote.',
    },
    intakePromotion: {
      enabled: promotionEnabled,
      reason: promotionEnabled
        ? 'PPBF_INTAKE_PROMOTION_ENABLED=true -- approved intake cases can be promoted.'
        : 'PPBF_INTAKE_PROMOTION_ENABLED is not "true" -- approve and reject work, but promote returns 403.',
    },
    durableRateLimit: {
      enabled: durableActive,
      reason: !durableFlagSet
        ? 'PPBF_DURABLE_RATE_LIMIT is not "true" -- rate limiting is in-memory only: per-instance, and reset by every restart.'
        : !hasPostgresConnection
          ? 'PPBF_DURABLE_RATE_LIMIT=true but AZURE_POSTGRES_CONNECTION_STRING is unset -- falls back to in-memory.'
          : 'Durable, cross-instance rate limiting is active.',
    },
  };
}
