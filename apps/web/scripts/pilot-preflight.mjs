import { BlobServiceClient } from '@azure/storage-blob';
import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function checkPostgres(connectionString) {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: true },
  });

  await client.connect();
  try {
    await client.query('select 1 as ok');
  } finally {
    await client.end();
  }
}

async function checkBlob(connectionString, containerName) {
  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = serviceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists();
}

async function checkAzureAiRuntime(endpoint, apiKey, deploymentName, apiVersion) {
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Respond with OK' }],
      max_completion_tokens: 16,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Azure AI connectivity failed (${response.status}): ${detail}`);
  }
}

async function run() {
  const postgres = required('AZURE_POSTGRES_CONNECTION_STRING');
  const storage = required('AZURE_STORAGE_CONNECTION_STRING');
  const aiEndpoint = required('AZURE_AI_ENDPOINT');
  const aiKey = required('AZURE_AI_KEY');
  const aiDeployment = required('AZURE_AI_DEPLOYMENT_NAME');
  const aiApiVersion = process.env.AZURE_AI_API_VERSION?.trim() || '2024-12-01-preview';
  const container = process.env.PPBF_PILOT_SHADOW_CONTAINER?.trim() || 'ppbf-pilot-shadow';

  console.log('Checking Azure PostgreSQL connectivity...');
  await checkPostgres(postgres);
  console.log('PostgreSQL connectivity OK');

  console.log('Checking Azure Blob connectivity...');
  await checkBlob(storage, container);
  console.log(`Blob connectivity OK (container: ${container})`);

  console.log('Checking Azure AI runtime connectivity...');
  await checkAzureAiRuntime(aiEndpoint, aiKey, aiDeployment, aiApiVersion);
  console.log(`Azure AI connectivity OK (deployment: ${aiDeployment})`);

  console.log('PILOT PREFLIGHT PASS');
}

try {
  await run();
} catch (error) {
  console.error('PILOT PREFLIGHT FAIL');
  console.error(String(error));
  process.exit(1);
}
