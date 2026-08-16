// pilotOpsReadiness.ts -- answers "why didn't X run?" for the production
// flags that silently gate SHADOW, video, ingest, and rate-limit behavior.
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
//
// The `floors` block is read-only reporting of values defined elsewhere
// (BOARD_MINIMUM_COHORT_SIZE, SEMANTIC_SCORE_FLOOR, the two classifier
// thresholds). This module imports them rather than re-stating the numbers,
// so it cannot silently drift from the real constant, and it must never be
// used to change them -- an ops-readiness report is a mirror, not a dial.

import {
  describeDocumentIngestDestinations,
  type DocumentIngestDestinationReport,
} from '../document-intake/config';
import { BOARD_MINIMUM_COHORT_SIZE } from './boardSummary';
import { getAzureAiRuntimeConfig } from './azureAiRuntime';
import { HEAVY_BAG_COMPLEXITY_THRESHOLD, QUICK_ROUND_COMPLEXITY_THRESHOLD } from './shadowClassifier';
import { isSemanticLibrarySearchEnabled } from './shadowEmbeddings';
import { isShadowWorkerEnabled } from './shadowJobWorker';
import { SEMANTIC_SCORE_FLOOR } from './shadowLibrary';
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
  azureChatConfigured: OpsReadinessFlag;
  semanticLibrarySearch: OpsReadinessFlag;
  // `enabled` answers "will a real ingest request write a document
  // ANYWHERE" -- true when at least one destination is ready, or when mock
  // mode is on. `destinations` answers the question that actually matters
  // operationally, which the old single boolean could not: WHICH ones.
  ingest: OpsReadinessFlag & {
    mockMode: boolean;
    destinations: DocumentIngestDestinationReport;
  };
  postgresConnectionConfigured: OpsReadinessFlag;
  floors: {
    boardMinimumCohortSize: number;
    semanticScoreFloor: number;
    quickRoundComplexityThreshold: number;
    heavyBagComplexityThreshold: number;
  };
}

// This module used to keep its OWN copy of document-intake's required
// variable list, with a comment admitting the hazard: "if
// document-intake/config.ts adds a required variable, add it here too". That
// is a readiness report that can drift from the thing it reports on, and it
// had already drifted -- the list checked ten credentials and neither folder
// id, so it answered "document ingest: configured" for a pipeline whose Google
// Drive destination was blank and whose uploads would land in unreachable
// storage.
//
// It now asks document-intake/config.ts directly, through a pure function that
// takes the same env this report was handed. One list, in the file that owns
// it, used by both.

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

  const azureChatConfigured = getAzureAiRuntimeConfig(env).ok;
  const semanticEnabled = isSemanticLibrarySearchEnabled(env);

  // Mock mode is a deliberate override -- reported as its own boolean rather
  // than folded into `enabled`, so "mock mode is on" and "real pipeline is
  // configured" are never confused with each other in the same field.
  const ingestMockMode = env.PPBF_INGEST_MOCK_MODE === 'true';
  const ingestDestinations = describeDocumentIngestDestinations(env);
  const destinationEntries = Object.entries(ingestDestinations) as Array<
    [keyof DocumentIngestDestinationReport, DocumentIngestDestinationReport[keyof DocumentIngestDestinationReport]]
  >;
  const readyDestinations = destinationEntries.filter(([, value]) => value.ready).map(([name]) => name);
  // Enabled-but-not-ready is the state that used to be invisible and is the
  // one worth shouting about: somebody set a destination's variables and the
  // pipeline will refuse to start, rather than the destination merely being
  // off on purpose.
  const brokenDestinations = destinationEntries
    .filter(([, value]) => value.enabled && !value.ready)
    .map(([name]) => name);
  const ingestConfigured = ingestMockMode || readyDestinations.length > 0;

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
    azureChatConfigured: {
      enabled: azureChatConfigured,
      reason: azureChatConfigured
        ? 'AZURE_AI_ENDPOINT, AZURE_AI_KEY, and AZURE_AI_DEPLOYMENT_NAME are all present -- SHADOW chat can reach the model.'
        : 'One or more of AZURE_AI_ENDPOINT / AZURE_AI_KEY / AZURE_AI_DEPLOYMENT_NAME is missing -- SHADOW chat cannot reach the model.',
    },
    semanticLibrarySearch: {
      enabled: semanticEnabled,
      reason: semanticEnabled
        ? 'AZURE_AI_EMBEDDING_DEPLOYMENT_NAME and the Azure AI endpoint/key are present -- Library search ranks by embedding similarity.'
        : 'No embedding deployment configured -- Library search runs on keyword matching only.',
    },
    ingest: {
      enabled: ingestConfigured,
      mockMode: ingestMockMode,
      destinations: ingestDestinations,
      reason: ingestMockMode
        ? 'PPBF_INGEST_MOCK_MODE=true -- document ingest returns mock results and writes nothing to SharePoint, Dataverse, or Drive.'
        : brokenDestinations.length > 0
          ? `Document ingest will refuse to start: ${brokenDestinations.join(', ')} configured but incomplete. `
            + 'See destinations for the missing variable names.'
          : readyDestinations.length > 0
            ? `Document ingest writes to: ${readyDestinations.join(', ')}. Destinations not listed are off and receive nothing.`
            : 'No document ingest destination is configured -- every real ingest request will fail.',
    },
    postgresConnectionConfigured: {
      enabled: hasPostgresConnection,
      reason: hasPostgresConnection
        ? 'AZURE_POSTGRES_CONNECTION_STRING is present.'
        : 'AZURE_POSTGRES_CONNECTION_STRING is unset.',
    },
    floors: {
      boardMinimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
      semanticScoreFloor: SEMANTIC_SCORE_FLOOR,
      quickRoundComplexityThreshold: QUICK_ROUND_COMPLEXITY_THRESHOLD,
      heavyBagComplexityThreshold: HEAVY_BAG_COMPLEXITY_THRESHOLD,
    },
  };
}
