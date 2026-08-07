import { createAzureClients, createCredential } from './azureClients.js';
import { loadConfig } from './config.js';
import { PpbfResearchClient } from './ppbfClient.js';
import { synchronizeResearchIndex } from './syncCore.js';
import { initializeTelemetry, trackSafeEvent, trackSafeException } from './telemetry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initializeTelemetry(config.applicationInsightsConnectionString);
  const credential = createCredential(config);
  const clients = createAzureClients(config, credential);
  const ppbf = new PpbfResearchClient(config, credential);
  let operation = 'research.fetch-export';

  try {
    const snapshot = await ppbf.fetchExport();
    operation = 'research.index-and-store';
    const result = await synchronizeResearchIndex({ config, snapshot, ...clients });
    trackSafeEvent('research.sync.completed', result);
  } catch (error) {
    trackSafeException(error, operation);
    process.exitCode = 1;
  }
}

await main();
