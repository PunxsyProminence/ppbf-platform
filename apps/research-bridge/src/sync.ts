import { createAzureClients, createCredential } from './azureClients.js';
import { loadConfig } from './config.js';
import { PpbfResearchClient } from './ppbfClient.js';
import { ensureResearchIndex, synchronizeResearchIndex } from './syncCore.js';
import { initializeTelemetry, trackSafeEvent, trackSafeException } from './telemetry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initializeTelemetry(config.applicationInsightsConnectionString);
  const credential = createCredential(config);
  const clients = createAzureClients(config, credential);

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
    } catch (error) {
      trackSafeException(error, bootstrapOperation);
      process.exitCode = 1;
    }
    return;
  }

  const ppbf = new PpbfResearchClient(config, credential);
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
  } catch (error) {
    trackSafeException(error, operation);
    process.exitCode = 1;
  }
}

await main();
