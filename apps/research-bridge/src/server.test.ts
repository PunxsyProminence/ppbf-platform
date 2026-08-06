import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { BridgeConfig } from './config.js';
import { createBridgeApp } from './server.js';

const config: BridgeConfig = {
  port: 3000,
  stagingAppOrigin: 'https://staging.example.test',
  mcpAudience: 'api://research-bridge',
  searchEndpoint: 'https://search.example.test',
  searchIndexName: 'research',
  storageAccountUrl: 'https://storage.example.test',
  researchContainerName: 'research-needs',
  evidenceContainerName: 'evidence-drafts',
  requirePlatformAuth: true,
  allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
};

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const app = createBridgeApp(config, {
    research: { fetchExport: async () => ({
      schema_version: '1',
      classification: 'sanitized-staging-only',
      generated_at: new Date(0).toISOString(),
      research_needs: [],
      approved_evidence: [],
    }) },
    evidence: { search: async () => [] },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('health is data-free and does not require authentication', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      service: 'ppbf-research-bridge',
      data_access: false,
    });
  });
});

test('MCP rejects requests when the platform principal header is absent', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(response.status, 401);
  });
});
