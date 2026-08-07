import { createAzureClients, createCredential } from './azureClients.js';
import { loadConfig, type BridgeConfig } from './config.js';
import { PpbfResearchClient } from './ppbfClient.js';
import { ensureResearchIndex, synchronizeResearchIndex } from './syncCore.js';
import { initializeTelemetry, trackSafeEvent, trackSafeException } from './telemetry.js';

/**
 * Dependencies the job resolves for itself in production, injectable so the
 * two entrypoints can be tested apart.
 *
 * The export client is a FACTORY rather than an instance on purpose: an
 * index-bootstrap run must never construct it, and a test can only prove that
 * if constructing it is something the test can observe.
 */
export interface BridgeJobDependencies {
  createClients: typeof createAzureClients;
  createCredential: typeof createCredential;
  createExportClient: (config: BridgeConfig, credential: ReturnType<typeof createCredential>) => {
    fetchExport: PpbfResearchClient['fetchExport'];
  };
}

const productionDependencies: BridgeJobDependencies = {
  createClients: createAzureClients,
  createCredential,
  createExportClient: (config, credential) => new PpbfResearchClient(config, credential),
};

export async function runBridgeJob(
  config: BridgeConfig,
  dependencies: BridgeJobDependencies = productionDependencies,
): Promise<{ mode: 'index-bootstrap' | 'sync'; ok: boolean }> {
  const credential = dependencies.createCredential(config);
  const clients = dependencies.createClients(config, credential);

  // An index-bootstrap run returns before the export client is ever
  // constructed. Its identity is not authorized against the PPBF export (it
  // holds neither the Research.Export role nor a place in the caller
  // allowlist), and it should not be: creating an empty index needs no access
  // to sanitized athlete data. The first bootstrap run failed with
  // StagingExportHttp403 precisely because this branch did not exist and the
  // shared entrypoint fetched the export unconditionally.
  if (config.indexBootstrapMode) {
    let bootstrapOperation = 'research.search-create-index';
    try {
      await ensureResearchIndex({
        config,
        searchIndexClient: clients.searchIndexClient,
        onStage: (stage) => { bootstrapOperation = stage; },
      });
      trackSafeEvent('research.index.bootstrapped', { index: config.searchIndexName });
      return { mode: 'index-bootstrap', ok: true };
    } catch (error) {
      trackSafeException(error, bootstrapOperation);
      return { mode: 'index-bootstrap', ok: false };
    }
  }

  const ppbf = dependencies.createExportClient(config, credential);
  let operation = 'research.fetch-export';

  try {
    const snapshot = await ppbf.fetchExport();
    operation = 'research.index-and-store';
    const result = await synchronizeResearchIndex({
      config,
      snapshot,
      ...clients,
      onStage: (stage) => { operation = stage; },
    });
    trackSafeEvent('research.sync.completed', result);
    return { mode: 'sync', ok: true };
  } catch (error) {
    trackSafeException(error, operation);
    return { mode: 'sync', ok: false };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  initializeTelemetry(config.applicationInsightsConnectionString);
  const outcome = await runBridgeJob(config);
  if (!outcome.ok) {
    process.exitCode = 1;
  }
}

// Only when executed as the job entrypoint, so importing this module in a test
// does not run a sync.
if (process.env.RESEARCH_BRIDGE_SKIP_MAIN !== 'true') {
  await main();
}
