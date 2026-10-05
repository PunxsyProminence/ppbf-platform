import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { BUILDING } from '@/components/buildingMap';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { promptDrills, workoutIntakePrompt } from '@/src/server/pilot/contentImport/aiPrompt';
import { applyImport } from '@/src/server/pilot/contentImport/apply';
import { emitContentImportAuditMirror } from '@/src/server/pilot/contentImport/auditRow';
import { type ImportPlan, packageInputs, planImport } from '@/src/server/pilot/contentImport/plan';
import { loadOfflineReferenceSets } from '@/src/server/pilot/contentImport/referenceSets';
import { ContentImportRefusal } from '@/src/server/pilot/contentImport/refusal';
import { CONTRACT_FILE_NAMES, isResearchFile, UPLOAD_LIMITS } from '@/src/server/pilot/contentImport/upload';
import { validatePackage } from '@/src/server/pilot/contentImport/validate';
import { withPoolClient, withTransaction } from '@/src/server/pilot/db';
import { type DrillLibraryRow, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import { requireMicrosoftAuthenticatedPrincipal, requireRole } from '@/src/server/pilot/http';

// POST /api/pilot/admin/content-import, with the database and the core's
// database half mocked. What is pinned here is the ROUTE's part: who may call
// it, that the gym is the session's, that checking writes nothing, that apply
// sends the hash of the plan shown and a refusal of the core reaches the page
// as a refusal, the caps, and research. The same route against a real
// migrated schema and the real core is contentImportUpload.pg.test.ts.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({ withTransaction: jest.fn(), withPoolClient: jest.fn() }));
jest.mock('@/src/server/pilot/contentImport/plan', () => {
  const actual = jest.requireActual('@/src/server/pilot/contentImport/plan');
  return { ...actual, planImport: jest.fn() };
});
jest.mock('@/src/server/pilot/contentImport/apply', () => ({ applyImport: jest.fn() }));
jest.mock('@/src/server/pilot/drillLibraryV3', () => ({ listDrillLibrary: jest.fn() }));
jest.mock('@/src/server/pilot/contentImport/auditRow', () => ({ emitContentImportAuditMirror: jest.fn() }));

const mockPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockTransaction = withTransaction as jest.Mock;
const mockPoolClient = withPoolClient as jest.Mock;
const mockPlan = planImport as jest.Mock;
const mockApply = applyImport as jest.Mock;
const mockMirror = emitContentImportAuditMirror as jest.Mock;
const mockDrills = listDrillLibrary as jest.Mock;

const WEB_DIR = path.resolve(__dirname, '../../../../..');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');
const HASH = 'a'.repeat(64);
const DISCIPLINES = 'organization_id,discipline,display_name\n{{PPBF_ORG_ID}},boxing,Boxing\n';

let client: { query: jest.Mock };

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  const counts = { new: 1, new_version: 0, unchanged: 0, absent: 0, reject: 0 };
  return {
    organizationId: 'org-1',
    actor: { accountId: 'admin-1', role: 'organization_admin', isPlatformOwner: false },
    datasets: ['disciplines'],
    units: [{ dataset: 'disciplines', key: 'boxing', outcome: 'new', toVersion: 1 }],
    counts: { disciplines: counts },
    totals: counts,
    blocking: [],
    warnings: [],
    changes: 1,
    planHash: HASH,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest('http://localhost/api/pilot/admin/content-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function files(entries: Record<string, string>) {
  return Object.entries(entries).map(([name, text]) => ({ name, text }));
}

/** A CSV of the given number of data rows, in a file the contract knows. */
function levelsWithRows(count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `,level_${index},${index},Level ${index},test,A`);
  return `organization_id,level_key,ordinal,display_name,observable_test,typical_scale\n${rows.join('\n')}\n`;
}

beforeEach(() => {
  jest.resetAllMocks();
  client = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
  mockPrincipal.mockResolvedValue(principal());
  mockTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  mockPoolClient.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  mockPlan.mockResolvedValue(plan());
  mockApply.mockResolvedValue({
    plan: plan(),
    importId: 'imp_1',
    auditId: '42',
    audit: { importId: 'imp_1', organizationId: 'org-1', actor: plan().actor, details: {} },
    written: { disciplines: { inserted: ['boxing'], updated: [], ledgerRows: 1 } },
    ledgerRows: 1,
  });
  mockMirror.mockResolvedValue(undefined);
  mockDrills.mockResolvedValue([]);
});

describe('who may load gym content', () => {
  test('a coach is refused, before anything is planned or a transaction opened', async () => {
    mockPrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-1' }));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) });

    expect(response.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  test('the platform owner is refused', async () => {
    mockPrincipal.mockResolvedValue(principal({ role: 'platform_owner', accountId: 'omega', organizationId: 'platform' }));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH });

    expect(response.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  test('a session with no organization is refused', async () => {
    mockPrincipal.mockResolvedValue(principal({ organizationId: null as unknown as string }));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) });

    expect(response.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin'] as const)('%s is admitted', async (role) => {
    mockPrincipal.mockResolvedValue(principal({ role }));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) });

    expect(response.status).toBe(200);
  });
});

describe('checking is the default: commit omitted, nothing is written and the plan comes back', () => {
  test('plans inside a READ ONLY transaction, never applies, and returns the plan with its hash', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.committed).toBe(false);
    expect(body.plan.plan_hash).toBe(HASH);
    expect(body.plan.counts).toEqual({ disciplines: { new: 1, new_version: 0, unchanged: 0, absent: 0, reject: 0 } });
    expect(body.plan.units).toEqual([{ dataset: 'disciplines', key: 'boxing', outcome: 'new', label: 'Boxing', to_version: 1 }]);

    // The database refuses any write in this transaction, and it is the first
    // statement: nothing the plan does can write.
    expect(client.query.mock.calls[0][0]).toBe('set transaction read only');
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockMirror).not.toHaveBeenCalled();
  });

  test('commit that is not a boolean is refused rather than read as a check', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: 'true', plan_hash: HASH });

    expect(response.status).toBe(400);
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('the gym is the session\'s', () => {
  test('an organization named in the body is ignored: the core is handed the session\'s gym and account', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), organization_id: 'org-2' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockPlan.mock.calls[0][0]).toMatchObject({ organizationId: 'org-1', actorAccountId: 'admin-1' });
    expect(mockPlan.mock.calls[0][0].files).toEqual({ 'seed_disciplines.csv': DISCIPLINES });
    expect(JSON.stringify(mockPlan.mock.calls)).not.toContain('org-2');
    expect(body.plan.organization_id).toBe('org-1');
  });

  test('a literal organization in a file is a blocking finding, and the file reaches the core as sent', async () => {
    // The core's own validator, offline, stands in for the database half:
    // the finding below is validate.ts's, not the test's.
    const references = loadOfflineReferenceSets(SEED_DATA_DIR);
    mockPlan.mockImplementation(async (request: { organizationId: string; files: Record<string, string> }) => {
      const validation = validatePackage(packageInputs(request.files), { references });
      return plan({ organizationId: request.organizationId, blocking: validation.blocking, units: [], changes: 0 });
    });
    const committed = fs.readFileSync(path.join(SEED_DATA_DIR, 'multidiscipline/seed_disciplines.csv'), 'utf8');
    const literal = committed.replace('{{PPBF_ORG_ID}}', 'org-2');
    expect(literal).not.toBe(committed);

    const response = await post({ files: files({ 'seed_disciplines.csv': literal }), organization_id: 'org-2' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockPlan.mock.calls[0][0].organizationId).toBe('org-1');
    expect(mockPlan.mock.calls[0][0].files['seed_disciplines.csv']).toBe(literal);
    expect(body.plan.blocking).toEqual([
      expect.objectContaining({ code: 'literal_organization', file: 'seed_disciplines.csv', column: 'organization_id' }),
    ]);
  });
});

describe('apply runs the plan that was shown, or nothing', () => {
  test('commit without the plan hash is refused, and nothing is applied', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/plan_hash/);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('commit applies inside a transaction with the hash of the plan shown, then writes the SHADOW mirror', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH, organization_id: 'org-2' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith({
      client,
      organizationId: 'org-1',
      actorAccountId: 'admin-1',
      files: { 'seed_disciplines.csv': DISCIPLINES },
      expectedPlanHash: HASH,
    });
    expect(mockPlan).not.toHaveBeenCalled();
    // After the transaction, on its own connection.
    expect(mockMirror).toHaveBeenCalledTimes(1);
    expect(mockTransaction.mock.invocationCallOrder[0]).toBeLessThan(mockPoolClient.mock.invocationCallOrder[0]);
    expect(body).toMatchObject({ committed: true, import_id: 'imp_1', audit_id: '42', ledger_rows: 1, audit_mirror: 'written' });
  });

  test('commit is refused when the plan hash changed since the preview: 409, the core\'s reason, no mirror', async () => {
    mockApply.mockRejectedValue(new ContentImportRefusal(
      'STALE_PLAN',
      'the database changed after the plan was made (plan aaaaaaaaaaaa, now bbbbbbbbbbbb); nothing was written. Plan again and review the new plan.',
    ));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('STALE_PLAN');
    expect(body.error).toBe(
      'the database changed after the plan was made (plan aaaaaaaaaaaa, now bbbbbbbbbbbb); nothing was written. Plan again and review the new plan.',
    );
    expect(mockMirror).not.toHaveBeenCalled();
  });

  test('a plan that blocks at apply is a 409 too', async () => {
    mockApply.mockRejectedValue(new ContentImportRefusal('PLAN_BLOCKED', '1 blocking finding(s); nothing was written.'));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PLAN_BLOCKED');
  });

  test('the core refusing the account is a 403 with its reason', async () => {
    mockPlan.mockRejectedValue(new ContentImportRefusal('ACTOR_NOT_A_MEMBER', "'admin-1' has no ACTIVE membership in 'org-1'"));

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "'admin-1' has no ACTIVE membership in 'org-1'", code: 'ACTOR_NOT_A_MEMBER' });
  });

  test('a failed SHADOW mirror after commit still answers committed, and says the mirror failed', async () => {
    mockMirror.mockRejectedValue(new Error('connection reset'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ committed: true, import_id: 'imp_1', audit_mirror: 'failed' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('connection reset');
    logged.mockRestore();
  });

  test('an unexpected database failure is an opaque 500, never the driver\'s message', async () => {
    mockApply.mockRejectedValue(new Error('password authentication failed for user "ppbf"'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }), commit: true, plan_hash: HASH });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    logged.mockRestore();
  });
});

describe('the caps name their number', () => {
  test('more than the row cap is refused with the cap and the count, before anything is planned', async () => {
    const rows = UPLOAD_LIMITS.rows + 1;

    const response = await post({ files: files({ 'seed_competence_levels.csv': levelsWithRows(rows) }) });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe('UPLOAD_TOO_MANY_ROWS');
    expect(body.error).toContain(`${rows.toLocaleString('en-US')} rows`);
    expect(body.error).toContain(`accepts ${UPLOAD_LIMITS.rows.toLocaleString('en-US')}`);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test('rows with the wrong number of cells count toward the row cap, as the core reads each one', async () => {
    // Half well-formed, half short. The core reports every short row as a
    // blocking column_count finding, so counting only the readable ones let a
    // file of short rows past the cap with a finding per row behind it.
    const good = UPLOAD_LIMITS.rows / 2;
    const short = UPLOAD_LIMITS.rows / 2 + 1;
    const [header, ...wellFormed] = levelsWithRows(good).trimEnd().split('\n');
    const text = `${[header, ...wellFormed, ...Array.from({ length: short }, (_, index) => `,short_${index},${index}`)].join('\n')}\n`;
    const references = loadOfflineReferenceSets(SEED_DATA_DIR);
    const findings = validatePackage(packageInputs({ 'seed_competence_levels.csv': text }), { references })
      .blocking.filter((finding) => finding.code === 'column_count');
    expect(findings).toHaveLength(short);

    const response = await post({ files: files({ 'seed_competence_levels.csv': text }) });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe('UPLOAD_TOO_MANY_ROWS');
    expect(body.error).toContain(`${(good + short).toLocaleString('en-US')} rows`);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test('exactly the row cap is accepted', async () => {
    const response = await post({ files: files({ 'seed_competence_levels.csv': levelsWithRows(UPLOAD_LIMITS.rows) }) });

    expect(response.status).toBe(200);
  });

  test('more than the file cap is refused with the number', async () => {
    const many = Array.from({ length: UPLOAD_LIMITS.files + 1 }, (_, index) => ({ name: `extra_${index}.csv`, text: 'a\n1\n' }));

    const response = await post({ files: many });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe('UPLOAD_TOO_MANY_FILES');
    expect(body.error).toContain(`accepts ${UPLOAD_LIMITS.files} at a time`);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test('more than the byte cap is refused with the number', async () => {
    const text = `organization_id,discipline,display_name\n${'x'.repeat(UPLOAD_LIMITS.packageBytes)}\n`;

    const response = await post({ files: files({ 'seed_disciplines.csv': text }) });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe('UPLOAD_TOO_MANY_BYTES');
    expect(body.error).toContain(`accepts ${UPLOAD_LIMITS.packageBytes.toLocaleString('en-US')}`);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test('a body declared larger than the body cap is refused before it is read', async () => {
    const response = await post({ files: files({ 'seed_disciplines.csv': DISCIPLINES }) }, { 'content-length': String(UPLOAD_LIMITS.bodyBytes + 1) });
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe('UPLOAD_BODY_TOO_LARGE');
    expect(body.error).toContain(UPLOAD_LIMITS.bodyBytes.toLocaleString('en-US'));
  });

  test('a body with no length is counted as it streams and refused at the cap', async () => {
    const huge = JSON.stringify({ files: files({ 'seed_disciplines.csv': 'y'.repeat(UPLOAD_LIMITS.bodyBytes) }) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(huge);
        for (let offset = 0; offset < bytes.length; offset += 65_536) controller.enqueue(bytes.slice(offset, offset + 65_536));
        controller.close();
      },
    });
    // A streamed body carries no Content-Length. `duplex` is required by the
    // fetch spec for a stream body and is not in this TypeScript lib's RequestInit.
    const streamed = new Request('http://localhost/api/pilot/admin/content-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.headers.get('content-length')).toBeNull();
    const response = await POST(new NextRequest(streamed));

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('UPLOAD_BODY_TOO_LARGE');
  });

  test('everything committed today outside research fits under every cap', async () => {
    const committed = fs.readdirSync(SEED_DATA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isResearchFile(`${entry.name}/`))
      .flatMap((entry) => fs.readdirSync(path.join(SEED_DATA_DIR, entry.name))
        .filter((name) => name.endsWith('.csv'))
        .map((name) => ({ name, text: fs.readFileSync(path.join(SEED_DATA_DIR, entry.name, name), 'utf8') })));
    expect(committed.map((file) => file.name)).toEqual(expect.arrayContaining(['seed_drill_library.csv', 'seed_workout_templates.csv']));

    const response = await post({ files: committed });

    expect(response.status).toBe(200);
    expect(UPLOAD_LIMITS.files).toBeGreaterThanOrEqual(CONTRACT_FILE_NAMES.length);
  });
});

describe('research is not loaded from this screen', () => {
  test('a research registry is refused by name, before anything is planned', async () => {
    const response = await post({
      files: files({ 'seed_disciplines.csv': DISCIPLINES, 'evidence_registry_boxing_learning.csv': 'claim_id\nA1-001\n' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('UPLOAD_RESEARCH_REFUSED');
    expect(body.error).toContain('evidence_registry_boxing_learning.csv');
    expect(mockPlan).not.toHaveBeenCalled();
  });

  test('every file of both committed research packages reads as research, and no contract file does', () => {
    const researchFiles: string[] = [];
    for (const root of ['shadow-research', 'research-evidence']) {
      for (const release of fs.readdirSync(path.join(SEED_DATA_DIR, root))) {
        for (const name of fs.readdirSync(path.join(SEED_DATA_DIR, root, release))) researchFiles.push(`${root}/${release}/${name}`);
      }
    }
    expect(researchFiles.length).toBeGreaterThan(15);

    // By its path, every file. By its bare name -- what a browser sends --
    // every CSV: the data that must not load into a gym.
    expect(researchFiles.filter((file) => !isResearchFile(file))).toEqual([]);
    expect(researchFiles.filter((file) => file.endsWith('.csv')).map((file) => path.basename(file)).filter((name) => !isResearchFile(name))).toEqual([]);
    // The research release contract's own file names (plan, CONTRACT section 9).
    for (const name of ['evidence_registry.csv', 'sources.csv', 'cross_track_conflict_ledger.csv', 'RESEARCH_METHODS.md']) {
      expect(isResearchFile(name)).toBe(true);
    }
    expect(CONTRACT_FILE_NAMES.filter((name) => isResearchFile(name))).toEqual([]);
  });
});

describe('GET: the workout intake prompt, behind the same gate as the upload', () => {
  function get() {
    return GET(new NextRequest('http://localhost/api/pilot/admin/content-import', { method: 'GET' }));
  }

  /** A full library row of `organizationId`, as listDrillLibrary returns it: every column, most of which must not leave. */
  function libraryRow(organizationId: string, n: number): DrillLibraryRow {
    return {
      organization_id: organizationId,
      drill_id: `drl_version-${organizationId}-${n}`,
      lineage_id: `drl_lineage-${organizationId}-${n}`,
      version: 2,
      supersedes_drill_id: `drl_older-${organizationId}-${n}`,
      superseded_at: null,
      name: `Drill ${n} of ${organizationId}`,
      discipline: 'DISCIPLINE-TEXT',
      category: 'CATEGORY-TEXT',
      difficulty: 'DIFFICULTY-TEXT',
      skill_id: `SK-TEST-0${n}`,
      target_behavior: 'TARGET-BEHAVIOR-TEXT',
      purpose: 'PURPOSE-TEXT',
      standard_setup: 'SETUP-TEXT',
      execution: 'EXECUTION-TEXT',
      what_good_looks_like: 'GOOD-TEXT',
      what_bad_looks_like: 'BAD-TEXT',
      common_errors: 'ERRORS-TEXT',
      corrections: 'CORRECTIONS-TEXT',
      transfer: 'TRANSFER-TEXT',
      contact_level: 'light_technical',
      equipment_needed: 'EQUIPMENT-TEXT',
      requires_coach_authorization: false,
      content_class: 'CONTENT-CLASS-TEXT',
      source_ref: 'SOURCE-REF-TEXT',
      grounding_claim_ids: ['CLAIM-ID-TEXT'],
      field_provenance: 'PROVENANCE-TEXT',
      active: true,
      created_by_account_id: 'author-account-1',
      created_by_role: 'CREATED-BY-ROLE-TEXT',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    };
  }

  test("an organization admin gets the prompt built from the session gym's drills, and no transaction is opened for it", async () => {
    const rows = [libraryRow('org-1', 1), libraryRow('org-1', 2)];
    mockDrills.mockResolvedValue(rows);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, dataset: 'workout-templates', prompt: workoutIntakePrompt(promptDrills(rows)) });
    expect(mockPrincipal).toHaveBeenCalledTimes(1);
    // The one read: the gym's current library, for the session's organization, no filter.
    expect(mockDrills.mock.calls).toEqual([['org-1']]);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPoolClient).not.toHaveBeenCalled();
    expect(body.prompt).toContain('- drl_lineage-org-1-1 | Drill 1 of org-1 | SK-TEST-01');
    expect(body.prompt).toContain('- drl_lineage-org-1-2 | Drill 2 of org-1 | SK-TEST-02');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('only drill names, lineage ids, skill codes and contact levels leave: nothing else of the row, the session or an athlete', async () => {
    const row = libraryRow('org-1', 1);
    mockDrills.mockResolvedValue([row]);
    mockPrincipal.mockResolvedValue(principal({ athleteId: 'ath-should-not-appear' }));

    const body = await (await get()).json();
    const listed = body.prompt.split('\n').filter((line: string) => line.startsWith('- drl_'));
    expect(listed).toEqual(['- drl_lineage-org-1-1 | Drill 1 of org-1 | SK-TEST-01 | light_technical']);

    const leaves = new Set(['lineage_id', 'name', 'skill_id', 'contact_level']);
    for (const [column, value] of Object.entries(row)) {
      if (leaves.has(column)) continue;
      for (const part of (Array.isArray(value) ? value : [value]).map(String)) {
        // Every text column above carries a distinctive value; only numbers and booleans (version, active...) are short.
        if (part.length < 8) continue;
        expect({ column, found: body.prompt.includes(part) }).toEqual({ column, found: false });
      }
    }
    for (const session of ['admin-1', 'ath-should-not-appear']) expect(body.prompt).not.toContain(session);
  });

  test('each gym gets its own list: the read follows the session, and the request cannot name another gym', async () => {
    mockDrills.mockImplementation(async (organizationId: string) => [libraryRow(organizationId, 1)]);

    mockPrincipal.mockResolvedValue(principal({ organizationId: 'org-2', accountId: 'admin-2' }));
    const response = await GET(new NextRequest(
      'http://localhost/api/pilot/admin/content-import?organization_id=org-1&organizationId=org-1',
      { method: 'GET', headers: { 'x-organization-id': 'org-1' } },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockDrills.mock.calls).toEqual([['org-2']]);
    expect(body.prompt).toContain('- drl_lineage-org-2-1 | Drill 1 of org-2 | SK-TEST-01 | light_technical');
    expect(body.prompt).not.toContain('org-1');
  });

  test('a gym with no current drills gets the words-only prompt', async () => {
    mockDrills.mockResolvedValue([]);
    const body = await (await get()).json();
    expect(body.prompt).toBe(workoutIntakePrompt());
    expect(body.prompt).not.toContain("THE GYM'S DRILLS");
  });

  test("a failed drill read is an opaque 500, never the driver's message, and no prompt", async () => {
    mockDrills.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    const response = await get();
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.prompt).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });

  test.each([
    ['a coach', principal({ role: 'coach', accountId: 'coach-1' })],
    ['the platform owner', principal({ role: 'platform_owner', accountId: 'omega', organizationId: 'platform' })],
    ['an athlete', principal({ role: 'athlete', accountId: 'athlete-1', athleteId: 'ath-1' })],
    ['a session with no organization', principal({ organizationId: null as unknown as string })],
  ])('%s is refused and gets no prompt', async (_who, refused) => {
    mockPrincipal.mockResolvedValue(refused);

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.prompt).toBeUndefined();
    expect(mockDrills).not.toHaveBeenCalled();
  });

  test('a session that is not a Microsoft sign-in is refused, by the same sign-in check as the upload', async () => {
    mockPrincipal.mockRejectedValue(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await get();

    expect(response.status).toBe(403);
    expect((await response.json()).prompt).toBeUndefined();
  });

  test('both verbs go through the one gate: the route names its role list once', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'route.ts'), 'utf8');
    expect(source.match(/requireRole\(/g)).toHaveLength(1);
    expect(source.match(/requireMicrosoftAuthenticatedPrincipal\(/g)).toHaveLength(1);
    expect(source.match(/await admit\(request\)/g)).toHaveLength(2);
  });
});

describe('the door in front of this route', () => {
  const DOOR = '/admin/content-import';

  test('advertises only roles the route admits, and never the platform owner or a coach', () => {
    const door = BUILDING.find((entry) => entry.href === DOOR);
    expect(door).toBeDefined();
    expect(door?.roles).not.toBe('open');
    const advertised = door?.roles as readonly string[];
    expect(advertised).toEqual(['admin']);
    // The route's own gate, run for each advertised role and for the two it refuses.
    const gate = (role: string) => () => requireRole(principal({ role: role as PilotPrincipal['role'] }), ['organization_admin', 'admin']);
    for (const role of advertised) expect(gate(role)).not.toThrow();
    expect(gate('coach')).toThrow('Forbidden');
    expect(gate('platform_owner')).toThrow('Forbidden');
  });

  test('and the page behind it gates on exactly the roles the door advertises', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../admin/content-import/page.tsx'), 'utf8');
    const gate = /<RoleSessionGate allowedRoles=\{\[([^\]]*)\]\}>/.exec(source);
    expect(gate).not.toBeNull();
    const guarded = (gate?.[1] ?? '').split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
    const door = BUILDING.find((entry) => entry.href === DOOR);
    expect([...guarded].sort()).toEqual([...(door?.roles as readonly string[])].sort());
  });
});
