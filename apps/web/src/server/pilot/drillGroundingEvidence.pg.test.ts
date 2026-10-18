// Real PostgreSQL proof of what a drill's grounding claim ids resolve to
// (audit 2026-10-17 item 11), against the full schema:
//   found        only under the Library's own retrieval filters, from the
//                gym's shelf or the shared __platform__ baseline, with the
//                claim chunk's labelled lines and metadata parsed out;
//   not_cleared  in the Library but pending, suppressed or retracted -- and
//                its text is not returned;
//   not_found    absent, another gym's, athlete-scoped or purge-held. The last
//                two must not even reveal that they exist.
//
// './db' is mocked to route into the embedded server (the pattern of
// heldLibraryDocuments.pg.test.ts). Spins up the disposable local-only
// embedded Postgres the other suites use. It NEVER connects to production or
// staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

let activeClient: Client | null = null;

function requireClient(): Client {
  if (!activeClient) throw new Error('test bug: no active embedded client');
  return activeClient;
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const result = await requireClient().query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const result = await requireClient().query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => fn(requireClient())),
}));

import { resolveDrillGroundingEvidence } from './drillGroundingEvidence';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-grounding-evidence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_drill_grounding_evidence';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-grounding-1';
const OTHER_ORG = 'org-grounding-2';
const PLATFORM = '__platform__';
const ADMIN = 'acct-grounding-admin';
const ATHLETE = 'ath-grounding-1';

const CLAIM_TEXT = [
  '[VERIFIED EVIDENCE] In seven national-level male boxers, rear straight reaction time lengthened after round three.',
  'Effect/estimate: 390 ms vs 310 ms',
  'Population: national-level male boxers | level: national amateur',
  'LIMITATIONS: n=7; no control condition.',
  'PPBF implication: Sparring markers change with training phase, so monitor them.',
  'Source: Effects of Sparring Load. J Strength Cond Res 2017.',
].join('\n');

const CLAIM_METADATA = {
  evidence_class: 'VERIFIED EVIDENCE',
  evidence_tier: 'EMERGING',
  confidence: 'low',
  population: 'national-level male boxers',
  competitive_level: 'national amateur',
  sex: 'male',
  age_range: '20.3 +/- 2.7 y',
  study_design: 'repeated-measures observational',
  sample_size: '7',
  limitations: 'n=7; no control condition.',
  transfer_status: 'direct - male national amateur',
  boxing_specificity: 'boxing_specific',
  doi_or_pmid: 'PMID 28538306',
};

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

interface SourceOptions {
  approved?: boolean;
  suppressed?: boolean;
  status?: 'active' | 'archived';
  url?: string;
  /** The document holding the claim chunk is still awaiting review. */
  documentPending?: boolean;
}

let nextOrdinal = 0;

async function source(sourceId: string, organizationId: string, options: SourceOptions = {}) {
  const approved = options.approved ?? true;
  await requireClient().query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, publisher, source_type, authority_tier, url, publication_date, status,
        rights_status, retrieval_suppressed, suppression_reason, suppressed_at, suppressed_by_account_id,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, 'Effects of Sparring Load', 'J Strength Cond Res', 'peer_reviewed', 3, $3, '2017-01-01', $4,
             'ppbf_owned', $5,
             case when $5 then 'Retracted by the journal (test).' end,
             case when $5 then now() end,
             case when $5 then $10 end,
             $6, $7, $8, $9, $8, $9)`,
    [
      sourceId,
      organizationId,
      // url is unique per organization, so each source gets its own.
      options.url ?? `https://example.org/${sourceId}`,
      options.status ?? 'active',
      options.suppressed ?? false,
      approved ? 'approved' : 'pending_review',
      approved ? 'verified' : 'unverified',
      approved ? ADMIN : null,
      approved ? new Date().toISOString() : null,
      ADMIN,
    ],
  );
}

async function document(
  documentId: string,
  sourceId: string,
  organizationId: string,
  options: { subjectId?: string | null; marked?: boolean; pending?: boolean } = {},
) {
  const approved = !options.pending;
  await requireClient().query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, subject_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at,
        metadata)
     values ($1, $2, $3, $4, $1, 'indexed', now(), $5, $6, $7, $8, $7, $8, $9::jsonb)`,
    [
      documentId,
      sourceId,
      organizationId,
      options.subjectId ?? null,
      approved ? 'approved' : 'pending_review',
      approved ? 'verified' : 'unverified',
      approved ? ADMIN : null,
      approved ? new Date().toISOString() : null,
      options.marked ? JSON.stringify({ subject_purged_at: '2026-10-15T00:00:00Z' }) : '{}',
    ],
  );
}

async function chunk(
  chunkId: string,
  documentId: string,
  sourceId: string,
  organizationId: string,
  claimId: string,
  options: { subjectId?: string | null; marked?: boolean; text?: string } = {},
) {
  const metadata = { ...CLAIM_METADATA, claim_id: claimId, ...(options.marked ? { subject_purged_at: '2026-10-15T00:00:00Z' } : {}) };
  await requireClient().query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, text_kind, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, 'full_text', $8::jsonb)`,
    [
      chunkId,
      documentId,
      sourceId,
      organizationId,
      options.subjectId ?? null,
      // unique (document_id, ordinal): every chunk gets its own.
      (nextOrdinal += 1),
      options.text ?? CLAIM_TEXT,
      JSON.stringify(metadata),
    ],
  );
}

/** One source, one document, one chunk carrying the claim id. */
async function claim(claimId: string, organizationId: string, options: SourceOptions = {}) {
  const key = `${claimId}-${organizationId}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await source(`src-${key}`, organizationId, options);
  await document(`doc-${key}`, `src-${key}`, organizationId, { pending: options.documentPending });
  await chunk(`chk-${key}`, `doc-${key}`, `src-${key}`, organizationId, claimId);
}

beforeAll(async () => {
  PG_PORT = await freePort();
  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (data) => {
    stderrOutput += String(data);
  });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  activeClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await activeClient.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(activeClient, {
    infraDir: INFRA_DIR,
  });

  const db = requireClient();
  for (const organizationId of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Gym', 'active')`,
      [organizationId],
    );
  }
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft')`,
    [ADMIN, ORG],
  );
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Athlete', '1995-05-05', 'open-70', 'active', 'Contact', true, $3, now(), now())`,
    [ORG, ATHLETE, ADMIN],
  );

  await claim('A3-032', PLATFORM, { url: 'https://doi.org/10.1519/JSC.0000000000001885' }); // the shared baseline
  await claim('B1-001', ORG, { url: 'javascript:alert(1)' }); // the gym's own shelf
  await claim('C1-001', PLATFORM, { approved: false }); // awaiting review
  await claim('D1-001', PLATFORM, { suppressed: true });
  await claim('E1-001', PLATFORM, { status: 'archived' });
  await claim('F1-001', PLATFORM, { documentPending: true }); // source cleared, document not
  await claim('G1-001', OTHER_ORG); // another gym's, approved
  // Pending on the baseline AND approved on the gym's shelf: the cleared one wins.
  await claim('J1-001', PLATFORM, { approved: false });
  await claim('J1-001', ORG);
  // Cleared on both shelves: the baseline's copy is the one shown.
  await claim('L1-001', PLATFORM, { url: 'https://doi.org/10.0000/baseline-copy' });
  await claim('L1-001', ORG);

  // Athlete-scoped: the chunk names a subject, then the document does.
  await source('src-subject', ORG);
  await document('doc-subject-chunk', 'src-subject', ORG);
  await chunk('chk-subject', 'doc-subject-chunk', 'src-subject', ORG, 'S1-001', { subjectId: ATHLETE });
  await document('doc-subject-doc', 'src-subject', ORG, { subjectId: ATHLETE });
  await chunk('chk-subject-doc', 'doc-subject-doc', 'src-subject', ORG, 'S2-001');
  // Held by the retention purge: on the chunk alone, then on the document alone.
  await chunk('chk-purged', 'doc-subject-chunk', 'src-subject', ORG, 'P1-001', { marked: true });
  await document('doc-purged', 'src-subject', ORG, { marked: true });
  await chunk('chk-purged-doc', 'doc-purged', 'src-subject', ORG, 'P2-001');
  // A chunk written without the labelled lines.
  await source('src-plain', ORG);
  await document('doc-plain', 'src-plain', ORG);
  await chunk('chk-plain', 'doc-plain', 'src-plain', ORG, 'K1-001', { text: 'A curator excerpt\nwith two lines.' });
  // A chunk on the gym's shelf citing ANOTHER gym's cleared source: the
  // source join is by organization, so it serves nothing.
  await source('src-other-gym', OTHER_ORG);
  await chunk('chk-cross-org', 'doc-plain', 'src-other-gym', ORG, 'X1-001');
});

afterAll(async () => {
  await activeClient?.end().catch(() => {});
  activeClient = null;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
});

describe('resolveDrillGroundingEvidence', () => {
  it('opens a baseline claim: the claim, what PPBF took from it, who was studied, its limitations and its source', async () => {
    const [entry] = await resolveDrillGroundingEvidence(ORG, ['A3-032']);
    expect(entry).toEqual({
      claimId: 'A3-032',
      status: 'found',
      record: {
        claim: 'In seven national-level male boxers, rear straight reaction time lengthened after round three.',
        effect: '390 ms vs 310 ms',
        ppbfImplication: 'Sparring markers change with training phase, so monitor them.',
        evidenceClass: 'VERIFIED EVIDENCE',
        evidenceTier: 'EMERGING',
        confidence: 'low',
        population: 'national-level male boxers',
        competitiveLevel: 'national amateur',
        sex: 'male',
        ageRange: '20.3 +/- 2.7 y',
        studyDesign: 'repeated-measures observational',
        sampleSize: '7',
        limitations: 'n=7; no control condition.',
        transferStatus: 'direct - male national amateur',
        boxingSpecificity: 'boxing_specific',
        doiOrPmid: 'PMID 28538306',
        sourceTitle: 'Effects of Sparring Load',
        sourcePublisher: 'J Strength Cond Res',
        sourceType: 'peer_reviewed',
        publicationDate: '2017-01-01',
        sourceUrl: 'https://doi.org/10.1519/JSC.0000000000001885',
        authorityTier: 3,
      },
    });
  });

  it("serves the gym's own shelf too, and never turns a non-https url into a link", async () => {
    const [entry] = await resolveDrillGroundingEvidence(ORG, ['B1-001']);
    expect(entry.status).toBe('found');
    expect(entry.status === 'found' && entry.record.sourceUrl).toBeNull();
  });

  it.each([
    ['C1-001', 'a source awaiting review'],
    ['D1-001', 'a source suppressed for retraction'],
    ['E1-001', 'an archived source'],
    ['F1-001', 'a cleared source in a document awaiting review'],
  ])('answers %s (%s) as not cleared, with no text', async (claimId) => {
    expect(await resolveDrillGroundingEvidence(ORG, [claimId])).toEqual([{ claimId, status: 'not_cleared' }]);
  });

  it.each([
    ['G1-001', "another gym's claim"],
    ['S1-001', 'an athlete-scoped chunk'],
    ['S2-001', 'a chunk under an athlete-scoped document'],
    ['P1-001', 'a chunk the purge held'],
    ['P2-001', 'a chunk under a document the purge held'],
    ['X1-001', "a gym chunk citing another gym's source"],
    ['Z9-999', 'an id no chunk carries'],
  ])('answers %s (%s) as not found', async (claimId) => {
    expect(await resolveDrillGroundingEvidence(ORG, [claimId])).toEqual([{ claimId, status: 'not_found' }]);
  });

  it('prefers a cleared copy over a pending one of the same claim', async () => {
    const [entry] = await resolveDrillGroundingEvidence(ORG, ['J1-001']);
    expect(entry.status).toBe('found');
  });

  it("shows the baseline's copy when both shelves hold the claim cleared", async () => {
    const [entry] = await resolveDrillGroundingEvidence(ORG, ['L1-001']);
    expect(entry.status === 'found' && entry.record.sourceUrl).toBe('https://doi.org/10.0000/baseline-copy');
  });

  it('keeps a chunk without labelled lines whole, as the claim', async () => {
    const [entry] = await resolveDrillGroundingEvidence(ORG, ['K1-001']);
    expect(entry.status === 'found' && entry.record).toMatchObject({
      claim: 'A curator excerpt with two lines.',
      effect: null,
      ppbfImplication: null,
    });
  });

  it("answers once per id, in the drill's order, and asks nothing for no ids", async () => {
    const answers = await resolveDrillGroundingEvidence(ORG, ['Z9-999', 'A3-032', 'A3-032', ' C1-001 ', '']);
    expect(answers.map((entry) => [entry.claimId, entry.status])).toEqual([
      ['Z9-999', 'not_found'],
      ['A3-032', 'found'],
      ['C1-001', 'not_cleared'],
    ]);
    expect(await resolveDrillGroundingEvidence(ORG, [])).toEqual([]);
  });

  it("reads another gym's claim from that gym, and the baseline from both", async () => {
    const answers = await resolveDrillGroundingEvidence(OTHER_ORG, ['G1-001', 'A3-032', 'B1-001']);
    expect(answers.map((entry) => entry.status)).toEqual(['found', 'found', 'not_found']);
  });
});
