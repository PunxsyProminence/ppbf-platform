// The anchor vocabulary contract, and the rules a rabbit hole write must keep.
//
// pilot.rabbit_holes deliberately puts no CHECK on anchor_key: one column holds
// values drawn from eight separate vocabularies, so a constraint listing every
// value of all eight would accept 'technique' under anchor_type 'formula_id'.
// The migration records that obligation as a test and hands key validity to the
// writing code. This file is where that obligation is discharged, and the first
// half of it asserts the declared lists still MATCH THEIR SOURCES -- a lesson
// anchored to a key nothing renders is a lesson nobody will ever see, and a
// vocabulary that grew without this file noticing produces exactly that.
//
// The database is mocked. Real Postgres behaviour -- constraints, the citation
// join, cross-organization isolation -- is proven in rabbitHoles.pg.test.ts.

import fs from 'node:fs';
import path from 'node:path';

import { boardSeatConfigs } from '@/app/board/boardWorkspaceConfig';

import { FORMULA_IDS } from './formulas/types';
import { deriveEvidenceTier } from './shadowEvidenceTier';

const queryMock = jest.fn();
const queryOneMock = jest.fn();

jest.mock('./db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
}));

import {
  assertCanAuthorRabbitHoles,
  assertCanManageRabbitHole,
  assertRabbitHoleAnchor,
  audiencesVisibleTo,
  createRabbitHole,
  listPublishedRabbitHoles,
  RABBIT_HOLE_ANCHOR_TYPES,
  RABBIT_HOLE_AUDIENCES,
  RABBIT_HOLE_CLOSED_ANCHOR_KEYS,
  setRabbitHoleStatus,
  updateRabbitHole,
} from './rabbitHoles';

const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

function readInfra(file: string): string {
  return fs.readFileSync(path.join(INFRA_DIR, file), 'utf8');
}

/** The quoted literals of a CHECK, which is where a vocabulary is written. */
function checkVocabulary(sql: string, pattern: RegExp): string[] {
  const match = pattern.exec(sql);
  if (!match) {
    throw new Error(`No constraint matched ${pattern} -- the migration moved or was renamed`);
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((quoted) => quoted[1]);
}

const RABBIT_HOLES_SQL = readInfra('pilot_slice_postgres_rabbit_holes_migration.sql');
const PROGRESSION_SQL = readInfra('pilot_slice_postgres_progression_migration.sql');

function lessonRow(overrides: Record<string, unknown> = {}) {
  return {
    rabbit_hole_id: 'rh-1',
    anchor_type: 'gap_type',
    anchor_key: 'technique',
    audience: 'all',
    title: 'Kinetic force transfer',
    concept: 'Power does not generate in the shoulders.',
    homework: 'Thirty slow crosses, three seconds at full extension.',
    author_display_name: 'Coach Jason',
    status: 'published',
    author_account_id: 'acct-coach',
    library_document_id: null,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    cited_document_id: null,
    cited_document_name: null,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  queryOneMock.mockReset();
  queryMock.mockResolvedValue([]);
  queryOneMock.mockResolvedValue(null);
});

describe('the anchor vocabularies match their sources', () => {
  test('anchor_type is exactly what the migration admits', () => {
    const fromMigration = checkVocabulary(
      RABBIT_HOLES_SQL,
      /add constraint pilot_rabbit_holes_anchor_type_check\s*check \(anchor_type in \(([^)]*)\)\)/,
    );

    expect([...RABBIT_HOLE_ANCHOR_TYPES].sort()).toEqual([...fromMigration].sort());
    expect(RABBIT_HOLE_ANCHOR_TYPES).toHaveLength(8);
  });

  test('audience is exactly what the migration admits', () => {
    const fromMigration = checkVocabulary(
      RABBIT_HOLES_SQL,
      /add constraint pilot_rabbit_holes_audience_check\s*check \(audience in \(([^)]*)\)\)/,
    );

    expect([...RABBIT_HOLE_AUDIENCES].sort()).toEqual([...fromMigration].sort());
  });

  // Each of the six closed vocabularies against the authority that owns it. A
  // gap type added to the progression CHECK, a formula added to the frozen
  // union, a ninth board seat -- any of them lands here rather than in a coach
  // discovering the write is refused.
  test('gap_type and severity are the progression CHECKs', () => {
    const gapTypes = checkVocabulary(PROGRESSION_SQL, /check \(gap_type in \(([^)]*)\)\)/);
    const severities = checkVocabulary(PROGRESSION_SQL, /check \(severity in \(([^)]*)\)\)/);

    expect([...RABBIT_HOLE_CLOSED_ANCHOR_KEYS.gap_type].sort()).toEqual([...gapTypes].sort());
    expect([...RABBIT_HOLE_CLOSED_ANCHOR_KEYS.severity].sort()).toEqual([...severities].sort());
  });

  test('formula_id is the frozen formula union', () => {
    expect(RABBIT_HOLE_CLOSED_ANCHOR_KEYS.formula_id).toEqual([...FORMULA_IDS]);
  });

  test('board_seat is the slugs the board pages route on', () => {
    expect(RABBIT_HOLE_CLOSED_ANCHOR_KEYS.board_seat).toEqual(boardSeatConfigs.map((seat) => seat.slug));
  });

  test('evidence_tier is every tier deriveEvidenceTier can produce', () => {
    const derived = [
      deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 2 }),
      deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 1 }),
      deriveEvidenceTier({ isAnsweredState: true, evidenceAvailability: 'available', citationCount: 0 }),
      deriveEvidenceTier({ isAnsweredState: false, evidenceAvailability: 'available', citationCount: 0 }),
    ];

    expect([...RABBIT_HOLE_CLOSED_ANCHOR_KEYS.evidence_tier].sort()).toEqual([...new Set(derived)].sort());
  });

  test('every closed vocabulary is non-empty and free of blanks', () => {
    for (const [anchorType, keys] of Object.entries(RABBIT_HOLE_CLOSED_ANCHOR_KEYS)) {
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((key) => typeof key === 'string' && key.trim() === key && key.length > 0)).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      expect(RABBIT_HOLE_ANCHOR_TYPES).toContain(anchorType);
    }
  });
});

describe('anchor key validation at write time', () => {
  test('a key belonging to the vocabulary is accepted', async () => {
    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'gap_type', anchorKey: 'technique' }),
    ).resolves.toEqual({ anchorType: 'gap_type', anchorKey: 'technique' });
  });

  // The exact failure the database cannot catch, and the reason this module
  // exists: the same key text under two vocabularies is two different anchors.
  test('a key from another vocabulary is refused', async () => {
    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'severity', anchorKey: 'technique' }),
    ).rejects.toThrow(/Unsupported anchor_key/);

    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'formula_id', anchorKey: 'critical' }),
    ).rejects.toThrow(/Unsupported anchor_key/);
  });

  test('a key belonging to no vocabulary at all is refused', async () => {
    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'gap_type', anchorKey: 'not-a-gap-type' }),
    ).rejects.toThrow(/Unsupported anchor_key/);
  });

  test('an empty or missing key is refused before it reaches the database', async () => {
    for (const anchorKey of ['', '   ', undefined, null, 42]) {
      await expect(
        assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'gap_type', anchorKey }),
      ).rejects.toThrow(/Missing anchor_key/);
    }
    expect(queryOneMock).not.toHaveBeenCalled();
  });

  test('a display card is not an anchor', async () => {
    await expect(
      assertRabbitHoleAnchor({
        organizationId: 'org-a',
        anchorType: 'dashboard_card',
        anchorKey: 'kinetic-force-card',
      }),
    ).rejects.toThrow(/Unsupported anchor_type/);
  });

  // The two vocabularies whose values are rows: validity is a lookup against
  // the organization's own drills and compliance rules, so a lesson cannot be
  // anchored to another gym's drill or to one that does not exist.
  test('a drill anchor is checked against this organization drills', async () => {
    queryOneMock.mockResolvedValueOnce(null);
    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'drill', anchorKey: 'drill-unknown' }),
    ).rejects.toThrow(/no drill in this organization/);

    queryOneMock.mockResolvedValueOnce({ drill_id: 'drill-slip-rope-01' });
    await expect(
      assertRabbitHoleAnchor({ organizationId: 'org-a', anchorType: 'drill', anchorKey: 'drill-slip-rope-01' }),
    ).resolves.toEqual({ anchorType: 'drill', anchorKey: 'drill-slip-rope-01' });

    const [sql, values] = queryOneMock.mock.calls[1];
    expect(sql).toContain('pilot.drills');
    expect(values).toEqual(['org-a', 'drill-slip-rope-01']);
  });

  test('a compliance rule anchor is checked against this organization rules', async () => {
    queryOneMock.mockResolvedValueOnce(null);
    await expect(
      assertRabbitHoleAnchor({
        organizationId: 'org-a',
        anchorType: 'compliance_rule',
        anchorKey: 'invented-slug',
      }),
    ).rejects.toThrow(/no compliance rule in this organization/);

    const [sql, values] = queryOneMock.mock.calls[0];
    expect(sql).toContain('pilot.compliance_rules');
    expect(values).toEqual(['org-a', 'invented-slug']);
  });
});

describe('who may write and change a lesson', () => {
  // The owner's decision: coaches write AND publish directly. There is no
  // review state because there is no reviewer.
  test('a coach may author, and the write publishes immediately', async () => {
    expect(() => assertCanAuthorRabbitHoles({ role: 'coach' })).not.toThrow();

    queryMock.mockResolvedValueOnce([]);
    queryMock.mockResolvedValueOnce([lessonRow()]);

    const lesson = await createRabbitHole({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      title: 'Kinetic force transfer',
      concept: 'Power does not generate in the shoulders.',
      authorAccountId: 'acct-coach',
      authorDisplayName: 'Coach Jason',
    });

    expect(lesson.status).toBe('published');
    const [insertSql, insertValues] = queryMock.mock.calls[0];
    expect(insertSql).toContain('insert into pilot.rabbit_holes');
    expect(insertSql).toContain("'published'");
    expect(insertSql).not.toMatch(/pending|review/i);
    expect(insertValues[0]).toBe('org-a');
  });

  test('an administrator may author and an athlete, parent, board or volunteer may not', () => {
    for (const role of ['organization_admin', 'admin'] as const) {
      expect(() => assertCanAuthorRabbitHoles({ role })).not.toThrow();
    }
    for (const role of ['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'] as const) {
      expect(() => assertCanAuthorRabbitHoles({ role })).toThrow(/^Forbidden/);
    }
  });

  test('a coach may change their own lesson and not another coach lesson', () => {
    const actor = { accountId: 'acct-coach', role: 'coach' as const };

    expect(() => assertCanManageRabbitHole(actor, { author_account_id: 'acct-coach' })).not.toThrow();
    expect(() => assertCanManageRabbitHole(actor, { author_account_id: 'acct-other' })).toThrow(/^Forbidden/);
    // author_account_id clears when the account is removed; the lesson survives
    // it, and only an administrator can still take it down.
    expect(() => assertCanManageRabbitHole(actor, { author_account_id: null })).toThrow(/^Forbidden/);
    expect(() =>
      assertCanManageRabbitHole({ accountId: 'acct-admin', role: 'admin' }, { author_account_id: null }),
    ).not.toThrow();
  });
});

describe('what a reader receives', () => {
  test('the read is scoped to the organization, the anchor, the audience and published status', async () => {
    queryMock.mockResolvedValueOnce([lessonRow()]);

    await listPublishedRabbitHoles({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });

    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('r.organization_id = $1');
    expect(sql).toContain("r.status = 'published'");
    expect(sql).toContain('r.audience = any($4::text[])');
    expect(values).toEqual(['org-a', 'gap_type', 'technique', ['all', 'athlete']]);
  });

  // 'admin' rows predate 'organization_admin' and the platform treats the two
  // as the same person, so a lesson addressed to one must not be invisible to
  // the other.
  test('an administrator sees both spellings of the administrator role', () => {
    expect(audiencesVisibleTo('organization_admin').sort()).toEqual(['admin', 'all', 'organization_admin']);
    expect(audiencesVisibleTo('admin').sort()).toEqual(['admin', 'all', 'organization_admin']);
    expect(audiencesVisibleTo('coach').sort()).toEqual(['all', 'coach']);
    expect(audiencesVisibleTo('board').sort()).toEqual(['all', 'board']);
  });

  // A hand-written lesson makes no evidence claim. PROVEN / EMERGING /
  // EXPERIMENTAL / RESEARCH_NEEDED mean retrieved-and-cited SHADOW evidence.
  test('a lesson carries an author and never an evidence tier', async () => {
    queryMock.mockResolvedValueOnce([lessonRow()]);

    const [lesson] = await listPublishedRabbitHoles({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });

    expect(lesson.author_display_name).toBe('Coach Jason');
    expect(Object.keys(lesson)).not.toContain('evidence_tier');
    expect(JSON.stringify(lesson)).not.toMatch(/PROVEN|EMERGING|EXPERIMENTAL|RESEARCH_NEEDED/);
  });

  // A pointer that did not resolve is not a citation, and the raw id of an
  // unapproved document must not reach the surface either.
  test('an unresolved library pointer leaves the lesson standing and the citation absent', async () => {
    queryMock.mockResolvedValueOnce([
      lessonRow({ library_document_id: 'doc-pending', cited_document_id: null, cited_document_name: null }),
    ]);

    const [lesson] = await listPublishedRabbitHoles({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });

    expect(lesson.title).toBe('Kinetic force transfer');
    expect(lesson.citation).toBeNull();
    expect(JSON.stringify(lesson)).not.toContain('doc-pending');
  });

  test('a resolved pointer renders as a named citation', async () => {
    queryMock.mockResolvedValueOnce([
      lessonRow({
        library_document_id: 'doc-approved',
        cited_document_id: 'doc-approved',
        cited_document_name: 'Boxing Biomechanics, ch. 4',
      }),
    ]);

    const [lesson] = await listPublishedRabbitHoles({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });

    expect(lesson.citation).toEqual({
      document_id: 'doc-approved',
      document_name: 'Boxing Biomechanics, ch. 4',
    });
  });

  // The citation is resolved on every read because approval is revocable, and
  // organization scoping of the citation is the join's responsibility -- there
  // is no foreign key to do it.
  test('the citation join carries the full approval predicate and the organization', async () => {
    queryMock.mockResolvedValueOnce([]);

    await listPublishedRabbitHoles({
      organizationId: 'org-a',
      anchorType: 'gap_type',
      anchorKey: 'technique',
      role: 'athlete',
    });

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('left join pilot.shadow_library_documents d');
    expect(sql).toContain('d.organization_id = r.organization_id');
    expect(sql).toContain("d.ingest_state = 'indexed'");
    expect(sql).toContain('d.index_completed_at is not null');
    expect(sql).toContain("d.approval_state = 'approved'");
    expect(sql).toContain("d.verification_state = 'verified'");
    expect(sql).toContain("s.status = 'active'");
    expect(sql).toContain("s.approval_state = 'approved'");
    expect(sql).toContain("s.verification_state = 'verified'");
  });
});

describe('editing and retiring', () => {
  test('an anchor moves only as a pair', async () => {
    await expect(
      updateRabbitHole({ organizationId: 'org-a', rabbitHoleId: 'rh-1', anchorType: 'severity' }),
    ).rejects.toThrow(/anchor_type and anchor_key move together/);

    await expect(
      updateRabbitHole({ organizationId: 'org-a', rabbitHoleId: 'rh-1', anchorKey: 'critical' }),
    ).rejects.toThrow(/anchor_type and anchor_key move together/);

    expect(queryMock).not.toHaveBeenCalled();
  });

  test('a re-anchor is validated exactly as a write is', async () => {
    await expect(
      updateRabbitHole({
        organizationId: 'org-a',
        rabbitHoleId: 'rh-1',
        anchorType: 'severity',
        anchorKey: 'technique',
      }),
    ).rejects.toThrow(/Unsupported anchor_key/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('an empty edit is refused rather than written as a no-op', async () => {
    await expect(
      updateRabbitHole({ organizationId: 'org-a', rabbitHoleId: 'rh-1' }),
    ).rejects.toThrow(/Missing changes/);
  });

  test('clearing homework blanks the column rather than reading as leave it', async () => {
    queryMock.mockResolvedValueOnce([{ rabbit_hole_id: 'rh-1' }]);
    queryMock.mockResolvedValueOnce([lessonRow({ homework: null })]);

    await updateRabbitHole({ organizationId: 'org-a', rabbitHoleId: 'rh-1', homework: '' });

    const [sql, values] = queryMock.mock.calls[0];
    expect(sql).toContain('homework = $3');
    expect(values).toEqual(['org-a', 'rh-1', null]);
  });

  test('an edit for a lesson in another gym changes nothing and reports it', async () => {
    queryMock.mockResolvedValueOnce([]);

    await expect(
      updateRabbitHole({ organizationId: 'org-a', rabbitHoleId: 'rh-elsewhere', title: 'Renamed' }),
    ).resolves.toBeNull();

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('where organization_id = $1 and rabbit_hole_id = $2');
  });

  // Retiring is not deleting: homework a reader is part-way through does not
  // vanish from the record.
  test('retiring updates status and never deletes', async () => {
    queryMock.mockResolvedValueOnce([{ rabbit_hole_id: 'rh-1' }]);
    queryMock.mockResolvedValueOnce([lessonRow({ status: 'retired' })]);

    const lesson = await setRabbitHoleStatus({
      organizationId: 'org-a',
      rabbitHoleId: 'rh-1',
      status: 'retired',
    });

    expect(lesson?.status).toBe('retired');
    expect(lesson?.homework).toBe('Thirty slow crosses, three seconds at full extension.');
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('update pilot.rabbit_holes');
    expect(sql).not.toMatch(/\bdelete\b/i);
  });

  test('a status outside the vocabulary is refused', async () => {
    for (const status of ['pending_review', 'draft', '', undefined]) {
      await expect(
        setRabbitHoleStatus({ organizationId: 'org-a', rabbitHoleId: 'rh-1', status }),
      ).rejects.toThrow(/Unsupported status/);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('the module issues no DDL', () => {
  test('nothing in rabbitHoles.ts reshapes the schema', () => {
    const source = fs.readFileSync(path.join(__dirname, 'rabbitHoles.ts'), 'utf8');
    expect(source).not.toMatch(/\b(create|alter|drop|truncate)\s+(table|schema|index|extension|view|type|sequence)\b/i);
  });
});
