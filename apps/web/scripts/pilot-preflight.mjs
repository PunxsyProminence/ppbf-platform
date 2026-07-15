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
    ssl: { rejectUnauthorized: false },
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

async function run() {
  const postgres = required('AZURE_POSTGRES_CONNECTION_STRING');
  const storage = required('AZURE_STORAGE_CONNECTION_STRING');
  const container = process.env.PPBF_PILOT_SHADOW_CONTAINER?.trim() || 'ppbf-pilot-shadow';

  console.log('Checking Azure PostgreSQL connectivity...');
  await checkPostgres(postgres);
  console.log('PostgreSQL connectivity OK');

  console.log('Checking Azure Blob connectivity...');
  await checkBlob(storage, container);
  console.log(`Blob connectivity OK (container: ${container})`);

  console.log('PILOT PREFLIGHT PASS');
}

try {
  await run();
} catch (error) {
  console.error('PILOT PREFLIGHT FAIL');
  console.error(String(error));
  process.exit(1);
}
