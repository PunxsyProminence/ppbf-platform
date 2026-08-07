import assert from 'node:assert/strict';
import test from 'node:test';

process.env.RESEARCH_BRIDGE_SKIP_MAIN = 'true';

const { runBridgeJob } = await import('./sync.js');
const type = await import('./config.js');

type BridgeConfig = typeof type extends never ? never : import('./config.js').BridgeConfig;

/**
 * The bug these pin: the bootstrap job failed against staging with
 * StagingExportHttp403.
 *
 * Both jobs share one entrypoint, and it fetched the PPBF export before doing
 * anything else -- so a run whose only task is creating an empty index still
 * had to authenticate against an export it has no right to read. The bootstrap
 * identity holds neither the Research.Export app role nor a place in
 * researchBridgeAuth's caller allowlist, and giving it either would have been
 * the wrong fix in exactly the direction the two-identity split exists to
 * avoid: granting sanitized-athlete-data access to an identity that never
 * touches a document.
 *
 * So the assertion that matters is a negative one -- the bootstrap path must
 * not even CONSTRUCT the export client. The dependency is injected as a factory
 * so that "was it constructed" is observable.
 */

function makeConfig(indexBootstrapMode: boolean): BridgeConfig {
  return {
    port: 3000,
    stagingAppOrigin: 'https://staging.example.org',
    mcpAudience: 'api://example',
    searchEndpoint: 'https://srch.search.windows.net',
    searchIndexName: 'ppbf-research-evidence-v1',
    storageAccountUrl: 'https://example.blob.core.windows.net',
    researchContainerName: 'research',
    evidenceContainerName: 'evidence',
    indexBootstrapMode,
    requirePlatformAuth: true,
    allowedHosts: ['localhost'],
  };
}

function makeDependencies() {
  let exportClientsCreated = 0;
  let createIndexCalls = 0;
  const containerClient = { getBlockBlobClient: () => ({ uploadData: async () => undefined }) };

  const dependencies = {
    createCredential: () => ({ getToken: async () => ({ token: 't', expiresOnTimestamp: 0 }) }),
    createClients: () => ({
      searchIndexClient: { createOrUpdateIndex: async () => { createIndexCalls += 1; } },
      searchClient: {
        mergeOrUploadDocuments: async () => undefined,
        search: async () => ({ results: [] as never[] }),
        deleteDocuments: async () => undefined,
      },
      blobServiceClient: { getContainerClient: () => containerClient },
    }),
    createExportClient: () => {
      exportClientsCreated += 1;
      return {
        fetchExport: async () => ({
          schema_version: '1' as const,
          classification: 'sanitized-staging-only' as const,
          generated_at: '2026-08-07T00:00:00.000Z',
          research_needs: [],
          approved_evidence: [],
        }),
      };
    },
  };

  return {
    dependencies,
    exportClientsCreated: () => exportClientsCreated,
    createIndexCalls: () => createIndexCalls,
  };
}

test('an index-bootstrap run never constructs the export client', async () => {
  const harness = makeDependencies();

  const outcome = await runBridgeJob(
    makeConfig(true),
    harness.dependencies as unknown as Parameters<typeof runBridgeJob>[1],
  );

  assert.equal(outcome.mode, 'index-bootstrap');
  assert.equal(outcome.ok, true);
  assert.equal(harness.createIndexCalls(), 1);
  // The whole point: no export client, so no token request for an audience this
  // identity is not authorized against, so no 403.
  assert.equal(harness.exportClientsCreated(), 0);
});

test('a sync run does fetch the export and does not touch the index definition', async () => {
  const harness = makeDependencies();

  const outcome = await runBridgeJob(
    makeConfig(false),
    harness.dependencies as unknown as Parameters<typeof runBridgeJob>[1],
  );

  assert.equal(outcome.mode, 'sync');
  assert.equal(outcome.ok, true);
  assert.equal(harness.exportClientsCreated(), 1);
  // Search Index Data Contributor cannot modify object definitions.
  assert.equal(harness.createIndexCalls(), 0);
});

test('a failing bootstrap reports failure rather than exiting zero', async () => {
  const harness = makeDependencies();
  const failing = {
    ...harness.dependencies,
    createClients: () => ({
      ...harness.dependencies.createClients(),
      searchIndexClient: {
        createOrUpdateIndex: async () => { throw new Error('RestError'); },
      },
    }),
  };

  const outcome = await runBridgeJob(
    makeConfig(true),
    failing as unknown as Parameters<typeof runBridgeJob>[1],
  );

  assert.equal(outcome.ok, false);
  assert.equal(harness.exportClientsCreated(), 0);
});
