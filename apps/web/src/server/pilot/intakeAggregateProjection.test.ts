/**
 * THE HALF OF THE FIX NOTHING WAS WATCHING.
 *
 * Two functions read pilot.parents on behalf of a family: the domain-get route
 * and getIntakeCaseAggregate. The route's projection has been pinned by
 * app/api/pilot/intake/domain-get/route.test.ts since the narrowing landed.
 * The aggregate's had nothing at all: its only caller,
 * /api/pilot/intake/cases/get, mocks getIntakeCaseAggregate out wholesale, so
 * reverting THIS half to `select p.*` turned no test in the repository red.
 * A safeguarding fix that can be undone on one of its two call sites with a
 * green build is half a fix.
 *
 * The embedded-Postgres suite (guardianContactProjection.pg.test.ts) proves
 * the rows this function really returns. These are the same properties held in
 * the FAST suite, which runs on every pull request, because the migration
 * chain runs conditionally and a guard that might not run is a guard you
 * cannot lean on.
 *
 * Only `./db` is mocked; the real function builds the real SQL.
 */

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { getIntakeCaseAggregate } from './intake';
import { query, queryOne } from './db';
import type { PilotRole } from './contracts';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

const ORG = 'org-1';
const CASE_ID = 'case-1';
const ATHLETE = 'ath-1';

beforeEach(() => {
  jest.clearAllMocks();
  // The case exists and names an athlete; every read below returns nothing.
  // This suite is about the SQL the function issues, not about rows.
  mockQueryOne.mockImplementation((() => Promise.resolve({
    organization_id: ORG,
    intake_case_id: CASE_ID,
    status: 'pending_review',
    primary_athlete_id: ATHLETE,
    summary: 'Registration',
    submitted_by_account_id: 'acct-admin',
    payload: {},
  })) as never);
  mockQuery.mockImplementation((() => Promise.resolve([])) as never);
});

/** The select list of the read whose SQL mentions `table`, normalized. */
function selectListFor(table: string): string[] {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes(table));
  if (!call) {
    throw new Error(`the aggregate never read ${table}`);
  }
  const match = /select\s+([\s\S]*?)\s+from\s/i.exec(String(call[0]));
  if (!match) {
    throw new Error(`the ${table} read has no parsable select list: ${String(call[0])}`);
  }
  return match[1].split(',').map((column) => column.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function paramsFor(table: string): unknown[] {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes(table));
  if (!call) {
    throw new Error(`the aggregate never read ${table}`);
  }
  return call[1] as unknown[];
}

async function run(actorRole?: PilotRole) {
  await getIntakeCaseAggregate(
    ORG,
    CASE_ID,
    actorRole ? { actorAccountId: `acct-${actorRole}`, actorRole } : undefined,
  );
}

const FAMILY_READERS: PilotRole[] = ['athlete', 'parent'];
/** `admin` is here because roleEquals lets it past requireRole on cases/get. */
const STAFF_READERS: PilotRole[] = ['organization_admin', 'admin', 'coach'];

describe('the aggregate guardian projection', () => {
  test('the reader tables are not empty', () => {
    expect(FAMILY_READERS.length).toBeGreaterThan(0);
    expect(STAFF_READERS.length).toBeGreaterThan(0);
  });

  test.each(FAMILY_READERS)(
    'THE DEFECT: %s receives identity and relationship only',
    async (role) => {
      await run(role);

      // Equality, not containment: "p.*" contains no substring "p.phone", so
      // a containment check passes over exactly the defect it names.
      expect(selectListFor('from pilot.guardian_links')).toEqual([
        'p.parent_id',
        'p.full_name',
        'g.relationship_to_athlete',
        'g.athlete_id',
      ]);
    },
  );

  test.each(STAFF_READERS)('%s keeps the contact columns', async (role) => {
    await run(role);

    expect(selectListFor('from pilot.guardian_links')).toEqual([
      'p.parent_id',
      'p.full_name',
      'p.account_id',
      'p.phone',
      'p.email',
      'g.relationship_to_athlete',
      'g.athlete_id',
    ]);
  });

  /* A caller that forgets the context argument must not be the one path that
     hands out phone numbers. The code comment argues for this default; nothing
     asserted it. */
  test('a call with no reader named falls to identity only, not to contact', async () => {
    await run();

    expect(selectListFor('from pilot.guardian_links')).toEqual([
      'p.parent_id',
      'p.full_name',
      'g.relationship_to_athlete',
      'g.athlete_id',
    ]);
  });

  test('the guardian read is scoped to the organization on both sides of the join', async () => {
    await run('coach');

    const [sql] = [String(mockQuery.mock.calls.find(([s]) => String(s).includes('from pilot.guardian_links'))?.[0])];
    expect(sql).toContain('p.organization_id = g.organization_id');
    expect(paramsFor('from pilot.guardian_links')).toEqual([ORG, ATHLETE]);
  });
});

describe('the aggregate emergency-contact projection', () => {
  test.each(FAMILY_READERS)(
    'THE SECOND DEFECT: %s learns who the emergency contact is, and not how to reach them',
    async (role) => {
      await run(role);

      expect(selectListFor('from pilot.emergency_contacts')).toEqual([
        'contact_id',
        'athlete_id',
        'full_name',
        'relationship_to_athlete',
        'is_primary',
      ]);
    },
  );

  test.each(STAFF_READERS)('%s keeps the number, the email and the note', async (role) => {
    await run(role);

    expect(selectListFor('from pilot.emergency_contacts')).toEqual([
      'contact_id',
      'athlete_id',
      'full_name',
      'relationship_to_athlete',
      'is_primary',
      'phone',
      'email',
      'notes',
    ]);
  });

  test('no reader named means identity only here too', async () => {
    await run();

    expect(selectListFor('from pilot.emergency_contacts')).not.toContain('phone');
  });
});

/* The note-type filter the sibling route has had since it was written, and
   this function did not: an unfiltered read handed the child, and the other
   household, a barrier report a guardian wrote to a coach in confidence. */
describe('the aggregate coach-observation filter', () => {
  test('the filter is applied in SQL, not after the rows are read', async () => {
    await run('parent');

    const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('from pilot.coach_observations'));
    expect(String(call?.[0])).toContain('note_type = any($3::text[])');
  });

  test('a guardian receives parent_message only', async () => {
    await run('parent');

    expect(paramsFor('from pilot.coach_observations')[2]).toEqual(['parent_message']);
  });

  test('an athlete receives training notes only', async () => {
    await run('athlete');

    expect(paramsFor('from pilot.coach_observations')[2]).toEqual(['coach_observation']);
  });

  test.each(STAFF_READERS)('%s still reads the whole bus', async (role) => {
    await run(role);

    expect(paramsFor('from pilot.coach_observations')[2]).toBeNull();
  });

  test('no reader named means the closed side -- the empty set, not the whole bus', async () => {
    await run();

    // 'athlete' is the documented fallback, so the closed side here is the
    // athlete's own list rather than [] -- asserted so the fallback is a
    // stated contract rather than an accident of the `??`.
    expect(paramsFor('from pilot.coach_observations')[2]).toEqual(['coach_observation']);
  });
});

/**
 * THE AGGREGATE HALF OF THE ASSESSMENT AND READINESS NARROWING.
 *
 * Same argument as the guardian block at the top of this file, one table
 * further on: the route's projection is pinned by
 * app/api/pilot/intake/domain-get/route.test.ts, and this function -- reached
 * by the same athlete and the same guardians through
 * /api/pilot/intake/cases/get -- has its own copy of the read. Its only
 * caller mocks it out wholesale, so reverting THIS half to `select *` would
 * turn nothing else in the repository red.
 */
describe('the aggregate assessment projection', () => {
  test.each(FAMILY_READERS)('%s receives no staff note, no rater id, no second rating', async (role) => {
    await run(role);

    expect(selectListFor('from pilot.assessments')).toEqual([
      'organization_id',
      'assessment_id',
      'athlete_id',
      'assessment_type',
      'result',
      'created_at',
      'updated_at',
      'protocol_id',
      'protocol_version',
      'administration_kind',
      'due_on',
      'administered_on',
      'retest_of_assessment_id',
      'training_hours_at_administration',
      'assessor_role',
    ]);
  });

  test.each(STAFF_READERS)('%s keeps the staff columns', async (role) => {
    await run(role);

    const columns = selectListFor('from pilot.assessments');
    for (const column of [
      'assessor_account_id',
      'second_rater_account_id',
      'second_rater_result',
      'conditions_note',
    ]) {
      expect(columns).toContain(column);
    }
  });

  test('a call with no reader named falls to identity only, not to the staff note', async () => {
    // The closed side of the default, asserted for this table too. A caller
    // that forgets the context argument must not be the one path that hands a
    // family the reliability study's raw material.
    await run();

    expect(selectListFor('from pilot.assessments')).not.toContain('conditions_note');
    expect(selectListFor('from pilot.assessments')).not.toContain('second_rater_result');
  });
});

describe('the aggregate readiness projection', () => {
  test.each(FAMILY_READERS)('%s receives no staff account id', async (role) => {
    await run(role);

    expect(selectListFor('from pilot.readiness')).toEqual([
      'organization_id',
      'readiness_id',
      'athlete_id',
      'score',
      'category',
      'measured_at',
      'created_at',
      'method',
      'reliability_status',
      'validity_status',
      'evidence_class',
    ]);
  });

  test.each(STAFF_READERS)('%s keeps recorded_by_account_id', async (role) => {
    await run(role);

    expect(selectListFor('from pilot.readiness')).toContain('recorded_by_account_id');
  });

  test('a call with no reader named falls to identity only', async () => {
    await run();

    expect(selectListFor('from pilot.readiness')).not.toContain('recorded_by_account_id');
  });
});
