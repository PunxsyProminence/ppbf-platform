import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const baseUrl = process.env.PILOT_GATE_BASE_URL || 'http://localhost:3000';
const sessionCookie = process.env.PILOT_SESSION_COOKIE || '';

const SESSION_COOKIE_NAME = 'ppbf_pilot_session';

// The session cookie is supplied by the operator rather than minted here.
//
// This script used to log in with an account id and PIN. That can no longer
// work for seeding, and not because of a misconfiguration: PIN sessions are
// athlete self-service only -- loginWithAccountIdAndPin returns null for any
// role other than 'athlete', explicitly so that privileged local sessions are
// never minted -- while writing to the Library requires organization_admin,
// admin or platform_owner. So a PIN login can only ever produce a session that
// is refused by every endpoint below.
//
// The bootstrap step that preceded it is gone for the same reason:
// /api/pilot/admin/bootstrap now refuses every request ("privileged accounts
// must be Microsoft-authenticated"), and the Microsoft bootstrap that replaced
// it issues an account with no PIN at all.
//
// Privileged accounts are Microsoft-authenticated, which is interactive and
// cannot be driven from a script. Rather than add a second privileged
// non-interactive path -- new attack surface for a seeding convenience -- this
// takes the session of an administrator who has already signed in normally.
function printUsage() {
  console.log(`SHADOW Library seed

Populates the SHADOW Library with the canonical doctrine source, its document
and chunks, and the capability coverage rules.

Authentication:
  Sign in to the platform as an organization_admin, admin or platform_owner,
  then copy the value of the '${SESSION_COOKIE_NAME}' cookie and pass it as
  PILOT_SESSION_COOKIE. The session must be Microsoft-authenticated; a PIN
  session is athlete-only and will be refused by every write below.

Required environment variables:
  PILOT_SESSION_COOKIE
Optional environment variables:
  PILOT_GATE_BASE_URL   (default http://localhost:3000)

Note:
  Seeding does not make anything citable. Sources and documents are written
  as 'pending_review' and stay invisible to SHADOW retrieval until they are
  approved through the evidence review queue at /admin/shadow.

Example:
  PILOT_GATE_BASE_URL=https://www.punxsyprominence.org PILOT_SESSION_COOKIE=<cookie> npm --prefix apps/web run seed:shadow:library
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

function cookieHeaderValue() {
  // Accept either the bare token or a full 'name=value' pair, since copying a
  // cookie out of devtools yields one or the other depending on where you copy
  // it from.
  return sessionCookie.includes('=') ? sessionCookie : `${SESSION_COOKIE_NAME}=${sessionCookie}`;
}

async function call(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeaderValue(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}\n\n`
        + `The session in PILOT_SESSION_COOKIE was rejected. A 401 means it is expired or not a\n`
        + `session at all; a 403 means it belongs to an account that cannot curate the Library --\n`
        + `that requires organization_admin, admin or platform_owner. Run with --help for details.`,
      );
    }
    throw new Error(`${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function verifySession() {
  console.log('1) Verify administrator session');
  // Fails fast against a cheap read rather than surfacing the first auth
  // problem partway through, once some rows are already written.
  await call('/api/pilot/shadow/library/sources?limit=1');
}

// The seed used to register exactly one hardcoded source (the authority
// model). Sources now come from shadow-library-seed-manifest.json, so growing
// the Library is a manifest edit rather than a script change. Dedupe is by
// doctrine_kind in source metadata: a source whose kind already exists in the
// organization is skipped entirely, which keeps re-runs cheap and means an
// edited file needs a new review pass, not a renamed kind.
async function loadManifest() {
  const manifestPath = process.env.PILOT_LIBRARY_MANIFEST
    ? path.resolve(process.cwd(), process.env.PILOT_LIBRARY_MANIFEST)
    : path.resolve(process.cwd(), 'scripts', 'shadow-library-seed-manifest.json');
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!Array.isArray(raw?.sources) || raw.sources.length === 0) {
    throw new Error(`Manifest at ${manifestPath} has no sources.`);
  }
  for (const entry of raw.sources) {
    for (const field of ['title', 'source_type', 'doctrine_kind', 'file']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`Manifest entry ${JSON.stringify(entry?.title ?? entry)} is missing "${field}".`);
      }
    }
  }
  return raw.sources;
}

async function listExistingSources() {
  const response = await call('/api/pilot/shadow/library/sources?status=active&limit=200');
  return Array.isArray(response?.items) ? response.items : [];
}

function findExistingSource(existing, entry) {
  return existing.find((item) => {
    const metadata = item?.metadata || {};
    return metadata?.doctrine_kind === entry.doctrine_kind || item?.title === entry.title;
  }) || null;
}

async function registerSource(entry) {
  const payload = await call('/api/pilot/shadow/library/sources', {
    method: 'POST',
    body: {
      title: entry.title,
      publisher: entry.publisher,
      source_type: entry.source_type,
      authority_tier: entry.authority_tier ?? 3,
      status: 'active',
      publication_date: entry.publication_date,
      metadata: {
        canonical: true,
        source_file: entry.file,
        doctrine_kind: entry.doctrine_kind,
      },
    },
  });
  return payload.source;
}

async function registerDocument(entry, sourceId, content) {
  const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const payload = await call('/api/pilot/shadow/library/documents', {
    method: 'POST',
    body: {
      source_id: sourceId,
      document_name: entry.title,
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

async function registerChunks(documentId, content) {
  const chunks = chunkText(content, 900);
  for (const [index, chunk] of chunks.entries()) {
    await call('/api/pilot/shadow/library/chunks', {
      method: 'POST',
      body: {
        document_id: documentId,
        ordinal: index,
        text_content: chunk,
        metadata: { canonical: true, chunk_type: 'doctrine' },
      },
    });
  }
  return chunks.length;
}

async function seedManifestSources() {
  const entries = await loadManifest();
  const existing = await listExistingSources();
  const results = [];

  for (const [index, entry] of entries.entries()) {
    const label = `${index + 1}/${entries.length} ${entry.doctrine_kind}`;
    const already = findExistingSource(existing, entry);
    if (already) {
      console.log(`2) ${label}: source already exists; skipping`);
      results.push({ doctrine_kind: entry.doctrine_kind, source_id: already.source_id, skipped: true, chunk_count: 0 });
      continue;
    }

    const filePath = path.resolve(process.cwd(), '..', '..', entry.file);
    const content = await fs.readFile(filePath, 'utf8');

    console.log(`2) ${label}: registering source, document, and chunks`);
    const source = await registerSource(entry);
    const document = await registerDocument(entry, source.source_id, content);
    const chunkCount = await registerChunks(document.document_id, content);
    results.push({ doctrine_kind: entry.doctrine_kind, source_id: source.source_id, skipped: false, chunk_count: chunkCount });
  }

  return results;
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

  if (!sessionCookie) {
    printUsage();
    throw new Error('Missing PILOT_SESSION_COOKIE.');
  }

  await verifySession();

  const results = await seedManifestSources();
  const coverageItems = await seedCapabilityCoverageRules();

  console.log('SHADOW Library seed complete');
  console.log(JSON.stringify({
    sources: results,
    registered: results.filter((entry) => !entry.skipped).length,
    skipped: results.filter((entry) => entry.skipped).length,
    total_chunks: results.reduce((sum, entry) => sum + entry.chunk_count, 0),
    coverage_rules: coverageItems.length,
  }, null, 2));
  console.log('Reminder: everything registered is pending_review. Approve it at /admin/shadow before SHADOW can cite it.');
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
