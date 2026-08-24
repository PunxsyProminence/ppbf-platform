/**
 * The gate that guards an intake case, and the reader allowlist that guards
 * the note bus underneath it.
 *
 * These are unit tests over the real decision: only `./db` is mocked, so
 * `assertActorCanAccessIntakeCase` runs the real `assertActorCanAccessAthlete`
 * (and, for a parent, the real guardian-link lookup) against controlled rows.
 * Mocking the gate itself would leave the mock under test.
 */
jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { PASSBOOK_ATHLETE_NOTE_TYPES } from './passbook';
import {
  ATHLETE_READABLE_NOTE_TYPES,
  PARENT_READABLE_NOTE_TYPES,
  assertActorCanAccessIntakeCase,
  coachObservationNoteTypesForReader,
  resolveIntakeCaseAuthority,
} from './intake';
import { query, queryOne } from './db';
import type { ActorIdentity } from './access';
import type { PilotRole } from './contracts';

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

interface Fixture {
  /** The pilot.intake_cases row, or null for "no such case". */
  intakeCase?: { primary_athlete_id: string | null; submitted_by_account_id: string } | null;
  /** owner_entity_id values the case's documents carry under owner_entity_type='athlete'. */
  documentOwners?: string[];
  /** Athlete ids the coach under test is the coach of record for. */
  coachAssigned?: string[];
  /** Athlete ids the coach under test holds live coverage on. */
  coachCovered?: string[];
  /** Athlete ids that exist in the organization at all (the admin's check). */
  inOrganization?: string[];
  /** Athlete ids the parent under test is guardian-linked to. */
  guardianLinked?: string[];
}

/**
 * Routes both db entry points by SQL text, so every query the real chain
 * makes is answered from one declarative fixture rather than by call order --
 * an order-indexed mock would silently pass if the gate stopped querying.
 */
function withDatabase(fixture: Fixture): void {
  const ownerRows = (fixture.documentOwners ?? []).map((id) => ({ owner_entity_id: id }));

  mockQueryOne.mockImplementation(((sql: string, params: unknown[]) => {
    const text = String(sql);

    if (text.includes('from pilot.intake_cases')) {
      return Promise.resolve(fixture.intakeCase ?? null);
    }

    if (text.includes('from pilot.athletes') && text.includes('coach_id = $2')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.coachAssigned ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }

    if (text.includes('from pilot.athletes')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.inOrganization ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }

    if (text.includes('from pilot.coach_coverage')) {
      const athleteId = (params as string[])[1];
      return Promise.resolve(
        (fixture.coachCovered ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }

    if (text.includes('from pilot.guardian_links')) {
      const athleteId = (params as string[])[1];
      return Promise.resolve(
        (fixture.guardianLinked ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }

    throw new Error(`unexpected queryOne in test: ${text}`);
  }) as never);

  mockQuery.mockImplementation(((sql: string) => {
    const text = String(sql);
    if (text.includes('from pilot.intake_documents')) {
      return Promise.resolve(ownerRows);
    }
    throw new Error(`unexpected query in test: ${text}`);
  }) as never);
}

function actor(role: PilotRole, overrides: Partial<ActorIdentity> = {}): ActorIdentity {
  return {
    accountId: 'acct-actor',
    role,
    organizationId: 'org-1',
    athleteId: null,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('resolveIntakeCaseAuthority', () => {
  test('a case that does not exist resolves to found:false and no subject', async () => {
    withDatabase({ intakeCase: null });

    const authority = await resolveIntakeCaseAuthority('org-1', 'case-x');

    expect(authority).toEqual({ found: false, submittedByAccountId: null, subjectAthleteIds: [] });
  });

  test('the pending case every row in this schema actually is: no subject at all', async () => {
    // primary_athlete_id has no writer (createIntakeCase's one caller never
    // passes it, nothing updates it) and owner_entity_id is only stamped at
    // promotion. So a case in the review queue names nobody.
    withDatabase({
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: [],
    });

    const authority = await resolveIntakeCaseAuthority('org-1', 'case-1');

    expect(authority).toEqual({
      found: true,
      submittedByAccountId: 'acct-uploader',
      subjectAthleteIds: [],
    });
  });

  test('document owner_entity_id is read as a subject -- the linkage promotion actually writes', async () => {
    withDatabase({
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1', 'ath-1'],
    });

    const authority = await resolveIntakeCaseAuthority('org-1', 'case-1');

    expect(authority.subjectAthleteIds).toEqual(['ath-1']);
  });

  test('both sources are merged and de-duplicated', async () => {
    withDatabase({
      intakeCase: { primary_athlete_id: 'ath-1', submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1', 'ath-2'],
    });

    const authority = await resolveIntakeCaseAuthority('org-1', 'case-1');

    expect(authority.subjectAthleteIds.sort()).toEqual(['ath-1', 'ath-2']);
  });

  test('only owner_entity_type = athlete is read as an athlete subject', async () => {
    withDatabase({
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
    });

    await resolveIntakeCaseAuthority('org-1', 'case-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("owner_entity_type = 'athlete'");
    expect(String(sql)).toContain('owner_entity_id is not null');
  });
});

describe('assertActorCanAccessIntakeCase -- a case with a resolved subject', () => {
  const promotedCase = {
    intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
    documentOwners: ['ath-1'],
  };

  test('the coach of record for the subject is admitted', async () => {
    withDatabase({ ...promotedCase, coachAssigned: ['ath-1'] });

    await expect(
      assertActorCanAccessIntakeCase(actor('coach'), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true, subjectAthleteIds: ['ath-1'] });
  });

  test('a coach with no relationship to the subject is refused', async () => {
    withDatabase({ ...promotedCase, coachAssigned: ['ath-other'] });

    await expect(
      assertActorCanAccessIntakeCase(actor('coach'), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: coach not assigned to athlete');
  });

  test('every subject must pass -- reaching one athlete is not authority over the case', async () => {
    withDatabase({
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1', 'ath-2'],
      coachAssigned: ['ath-1'],
    });

    await expect(
      assertActorCanAccessIntakeCase(actor('coach'), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: coach not assigned to athlete');
  });

  test('a guardian linked to the subject is admitted; an unlinked one is refused', async () => {
    withDatabase({ ...promotedCase, guardianLinked: ['ath-1'] });
    await expect(
      assertActorCanAccessIntakeCase(actor('parent'), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true });

    withDatabase({ ...promotedCase, guardianLinked: [] });
    await expect(
      assertActorCanAccessIntakeCase(actor('parent'), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: parent not linked to athlete');
  });

  test('an athlete reaches only their own case', async () => {
    withDatabase(promotedCase);

    await expect(
      assertActorCanAccessIntakeCase(actor('athlete', { athleteId: 'ath-1' }), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true });
    await expect(
      assertActorCanAccessIntakeCase(actor('athlete', { athleteId: 'ath-2' }), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: athlete cannot access another athlete record');
  });

  test('the admin still needs the subject to be in their organization', async () => {
    withDatabase({ ...promotedCase, inOrganization: ['ath-1'] });
    await expect(
      assertActorCanAccessIntakeCase(actor('organization_admin'), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true });

    withDatabase({ ...promotedCase, inOrganization: [] });
    await expect(
      assertActorCanAccessIntakeCase(actor('organization_admin'), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: athlete does not belong to organization');
  });
});

describe('assertActorCanAccessIntakeCase -- a case with no resolved subject', () => {
  const pendingCase = {
    intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
    documentOwners: [],
  };

  test('the organization admin is admitted', async () => {
    withDatabase(pendingCase);

    await expect(
      assertActorCanAccessIntakeCase(actor('organization_admin'), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true, subjectAthleteIds: [] });
  });

  test('the legacy admin role is admitted on the same footing', async () => {
    withDatabase(pendingCase);

    await expect(
      assertActorCanAccessIntakeCase(actor('admin'), 'org-1', 'case-1'),
    ).resolves.toMatchObject({ found: true });
  });

  test('the coach who filed the case is admitted', async () => {
    withDatabase(pendingCase);

    await expect(
      assertActorCanAccessIntakeCase(
        actor('coach', { accountId: 'acct-uploader' }),
        'org-1',
        'case-1',
      ),
    ).resolves.toMatchObject({ found: true });
  });

  test('THE DEFECT: any other coach in the organization is refused', async () => {
    // Before the fix this branch did not exist -- the gate was written
    // `if (primary_athlete_id) assert(...)`, the column is never written, and
    // so every coach admitted by the role gate read every case in the
    // organization, filenames and blob paths included.
    withDatabase(pendingCase);

    await expect(
      assertActorCanAccessIntakeCase(
        actor('coach', { accountId: 'acct-other-coach' }),
        'org-1',
        'case-1',
      ),
    ).rejects.toThrow('Forbidden: actor has no relationship to this intake case');
  });

  test('an athlete and a guardian are refused an unattributed case', async () => {
    withDatabase(pendingCase);
    await expect(
      assertActorCanAccessIntakeCase(actor('athlete', { athleteId: 'ath-1' }), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: actor has no relationship to this intake case');

    withDatabase(pendingCase);
    await expect(
      assertActorCanAccessIntakeCase(actor('parent'), 'org-1', 'case-1'),
    ).rejects.toThrow('Forbidden: actor has no relationship to this intake case');
  });

  test('a missing case is reported, never granted', async () => {
    withDatabase({ intakeCase: null });

    await expect(
      assertActorCanAccessIntakeCase(actor('coach'), 'org-1', 'case-x'),
    ).resolves.toEqual({ found: false, submittedByAccountId: null, subjectAthleteIds: [] });
  });
});

describe('coachObservationNoteTypesForReader', () => {
  test('staff read the whole bus -- every note type on it is theirs or addressed to them', () => {
    expect(coachObservationNoteTypesForReader('organization_admin')).toBeNull();
    expect(coachObservationNoteTypesForReader('admin')).toBeNull();
    expect(coachObservationNoteTypesForReader('coach')).toBeNull();
  });

  test('a guardian reads parent_message only -- the set listParentMessages already decided', () => {
    expect(coachObservationNoteTypesForReader('parent')).toEqual(['parent_message']);
  });

  test('an athlete reads coach observations about themselves, and nothing else', () => {
    // Narrowed from a three-value list during integration, to agree with
    // passbook.ts. `behavior_standard` is one generic label covering every
    // conduct note a coach types -- decision-loop picks no categories on
    // purpose -- so it cannot be shown to a child selectively.
    // `intake_observation` is free text promoted out of a packet carrying
    // medical and waiver blocks.
    expect(coachObservationNoteTypesForReader('athlete')).toEqual(['coach_observation']);
  });

  test('the two note-type readers agree on what a child may read about themselves', () => {
    // A shared bus read by two modules is exactly where an allow-list drifts.
    // These were written in parallel and disagreed; this fails if they part
    // again.
    expect(coachObservationNoteTypesForReader('athlete')).toEqual([...PASSBOOK_ATHLETE_NOTE_TYPES]);
  });

  test.each(['athlete', 'parent'] as PilotRole[])(
    'a guardian-authored barrier report never reaches %s',
    (role) => {
      const allowed = coachObservationNoteTypesForReader(role) ?? [];
      expect(allowed).not.toContain('home_barrier');
      expect(allowed).not.toContain('transportation_barrier');
    },
  );

  test('parent_message is never handed to the child it is about', () => {
    expect(coachObservationNoteTypesForReader('athlete')).not.toContain('parent_message');
  });

  test.each(['volunteer', 'staff', 'board', 'platform_owner'] as PilotRole[])(
    'any other role (%s) falls through to the empty set, not to the whole bus',
    (role) => {
      expect(coachObservationNoteTypesForReader(role)).toEqual([]);
    },
  );

  test('the exported sets are the ones the function returns', () => {
    expect(coachObservationNoteTypesForReader('athlete')).toEqual([...ATHLETE_READABLE_NOTE_TYPES]);
    expect(coachObservationNoteTypesForReader('parent')).toEqual([...PARENT_READABLE_NOTE_TYPES]);
  });
});
