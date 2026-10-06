import { createAzureClients, createCredential } from './azureClients.js';
import { loadConfig } from './config.js';
import { EvidenceSearchService } from './evidenceSearch.js';
import { PpbfResearchClient } from './ppbfClient.js';
import { CachedResearchSource } from './researchCache.js';
import { createBridgeApp } from './server.js';
import { initializeTelemetry, trackSafeEvent } from './telemetry.js';

const config = loadConfig();
initializeTelemetry(config.applicationInsightsConnectionString);
const credential = createCredential(config);
const clients = createAzureClients(config, credential);
const app = createBridgeApp(config, {
  // One export fetch serves MCP tool calls for a minute (CL-C22).
  research: new CachedResearchSource(new PpbfResearchClient(config, credential), { ttlMs: 60_000 }),
  evidence: new EvidenceSearchService(clients.searchClient, { maxAgeHours: config.evidenceMaxAgeHours }),
});

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  trackSafeEvent('bridge.started', { port: config.port, platform_auth_required: config.requirePlatformAuth });
});

function shutdown(signal: string): void {
  trackSafeEvent('bridge.stopping', { signal });
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
