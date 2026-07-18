import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';
const adminAccountId = process.env.PILOT_ADMIN_ACCOUNT_ID || '';
const adminPin = process.env.PILOT_ADMIN_PIN || '';
const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY || '';
const organizationId = process.env.PILOT_ORG_A_ID || process.env.PPBF_PILOT_DEFAULT_ORG_ID || '';

let cookieHeader = '';

function printUsage() {
  console.log(`SHADOW Library seed

Required environment variables:
  PILOT_ADMIN_ACCOUNT_ID
  PILOT_ADMIN_PIN
Optional environment variables:
  PILOT_GATE_BASE_URL
  PPBF_PILOT_BOOTSTRAP_KEY
  PILOT_ORG_A_ID
  PPBF_PILOT_DEFAULT_ORG_ID

Example:
  PILOT_GATE_BASE_URL=https://www.punxsyprominence.org PILOT_ADMIN_ACCOUNT_ID=org_admin_shadow PILOT_ADMIN_PIN=<set> PPBF_PILOT_BOOTSTRAP_KEY=<set> npm --prefix apps/web run seed:shadow:library
`);
}

function chunkText(text, targetLength = 1000) {
  const normalized = text
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const line of normalized) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > targetLength && current) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = candidate;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function maybeBootstrapAdmin() {
  if (!bootstrapKey) {
    return;
  }

  console.log('0) Bootstrap admin account');
  const response = await fetch(`${baseUrl}/api/pilot/admin/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ppbf-bootstrap-key': bootstrapKey,
    },
    body: JSON.stringify({
      account_id: adminAccountId,
      pin: adminPin,
      organization_id: organizationId || undefined,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(`Bootstrap failed (${response.status}): ${JSON.stringify(payload)}`);
  }
}

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookieHeader = setCookie.split(';')[0];
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function login() {
  console.log('1) Admin login');
  await call('/api/pilot/auth/login', {
    method: 'POST',
    body: {
      account_id: adminAccountId,
      pin: adminPin,
    },
  });
}

async function registerDoctrineSource() {
  console.log('2) Register canonical doctrine source');
  const existing = await findCanonicalSource();
  if (existing) {
    console.log('2) Canonical doctrine source already exists; reusing existing source');
    return { source: existing, existing: true };
  }

  const payload = await call('/api/pilot/shadow/library/sources', {
    method: 'POST',
    body: {
      title: 'SHADOW Canonical Authority Model',
      publisher: 'Punxsy Prominence',
      source_type: 'internal_policy',
      authority_tier: 1,
      status: 'active',
      publication_date: '2026-07-15',
      metadata: {
        canonical: true,
        source_file: 'docs/SHADOW_AUTHORITY_MODEL.md',
        doctrine_kind: 'shadow-authority-model',
      },
    },
  });

  return { source: payload.source, existing: false };
}

async function findCanonicalSource() {
  const response = await call('/api/pilot/shadow/library/sources?source_type=internal_policy&status=active&limit=200');
  const items = Array.isArray(response?.items) ? response.items : [];
  return items.find((item) => {
    const metadata = item?.metadata || {};
    return (
      item?.title === 'SHADOW Canonical Authority Model'
      || metadata?.doctrine_kind === 'shadow-authority-model'
      || metadata?.canonical === true
    );
  }) || null;
}

async function registerDoctrineDocument(sourceId, content) {
  console.log('3) Register doctrine document');
  const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const payload = await call('/api/pilot/shadow/library/documents', {
    method: 'POST',
    body: {
      source_id: sourceId,
      document_name: 'SHADOW Canonical Authority Model',
      content_sha256: contentSha256,
      ingest_state: 'chunking',
      metadata: {
        canonical: true,
        body_length: content.length,
        content_sha256: contentSha256,
      },
    },
  });

  return payload.document;
}

async function registerDoctrineChunks(documentId, content) {
  console.log('4) Register doctrine chunks');
  const chunks = chunkText(content, 900);
  for (const [index, chunk] of chunks.entries()) {
    await call('/api/pilot/shadow/library/chunks', {
      method: 'POST',
      body: {
        document_id: documentId,
        ordinal: index,
        text_content: chunk,
        metadata: {
          canonical: true,
          chunk_type: 'doctrine',
        },
      },
    });
  }

  return chunks.length;
}

async function seedCapabilityCoverageRules() {
  console.log('5) Seed capability coverage rules');
  const capabilityRules = [
    {
      capability_key: 'shadow.doctrine.authority-boundary',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 1,
      minimum_source_count: 1,
    },
    {
      capability_key: 'shadow.doctrine.research-escalation',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 1,
      minimum_source_count: 1,
    },
    {
      capability_key: 'shadow.doctrine.organizational-memory',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 1,
      minimum_source_count: 1,
    },
    {
      capability_key: 'shadow.doctrine.capability-growth',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 1,
      minimum_source_count: 1,
    },
  ];

  for (const rule of capabilityRules) {
    await call('/api/pilot/shadow/library/capability-coverage', {
      method: 'POST',
      body: rule,
    });
  }

  const coverage = await call('/api/pilot/shadow/library/capability-coverage', {
    method: 'POST',
    body: {
      action: 'recompute',
    },
  });

  return coverage.items ?? [];
}

async function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  if (!adminAccountId || !adminPin) {
    printUsage();
    throw new Error('Missing PILOT_ADMIN_ACCOUNT_ID or PILOT_ADMIN_PIN.');
  }

  const doctrinePath = path.resolve(process.cwd(), '..', '..', 'docs', 'SHADOW_AUTHORITY_MODEL.md');
  const doctrineContent = await fs.readFile(doctrinePath, 'utf8');

  await maybeBootstrapAdmin();
  await login();

  const sourceResult = await registerDoctrineSource();
  let documentId = null;
  let chunkCount = 0;

  if (sourceResult.existing) {
    console.log('3) Skipping doctrine document/chunk registration for existing canonical source');
  } else {
    const document = await registerDoctrineDocument(sourceResult.source.source_id, doctrineContent);
    documentId = document.document_id;
    chunkCount = await registerDoctrineChunks(document.document_id, doctrineContent);
  }

  const coverageItems = await seedCapabilityCoverageRules();

  console.log('SHADOW Library seed complete');
  console.log(JSON.stringify({
    source_id: sourceResult.source.source_id,
    document_id: documentId,
    chunk_count: chunkCount,
    source_preexisting: sourceResult.existing,
    coverage_rules: coverageItems.length,
  }, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
