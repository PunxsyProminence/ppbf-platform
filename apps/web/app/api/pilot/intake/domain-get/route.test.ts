/**
 * pilot.coach_observations is a shared bus, and this route read all of it.
 *
 * These tests drive the REAL query through a mocked `db` and assert on the
 * parameters the route actually sends, so a filter that stopped being applied
 * -- or that was applied to the wrong role -- shows up as a failure rather
 * than as rows nobody notices in a payload.
 */
import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { query, queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function domainRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/intake/domain-get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The parameters the coach_observations read was issued with. */
function observationCall(): [string, unknown[]] {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('from pilot.coach_observations'));
  if (!call) {
    throw new Error('the route never read pilot.coach_observations');
  }
  return [String(call[0]), call[1] as unknown[]];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  // Everything the athlete gate consults says yes; this suite is about what
  // comes back, not about who gets in.
  mockQueryOne.mockImplementation((() => Promise.resolve({ athlete_id: 'ath-1' })) as never);
  mockQuery.mockImplementation((() => Promise.resolve([])) as never);
});

describe('POST /api/pilot/intake/domain-get', () => {
  test('a missing athlete_id is a 400', async () => {
    expect((await POST(domainRequest({}))).status).toBe(400);
  });

  test('the note_type filter is applied in SQL, not after the rows are read', async () => {
    await POST(domainRequest({ athlete_id: 'ath-1' }));

    const [sql] = observationCall();
    expect(sql).toContain('note_type = any($3::text[])');
  });

  test('staff read the whole bus -- the filter parameter is null', async () => {
    for (const role of ['organization_admin', 'coach'] as PilotPrincipal['role'][]) {
      jest.clearAllMocks();
      mockQueryOne.mockImplementation((() => Promise.resolve({ athlete_id: 'ath-1' })) as never);
      mockQuery.mockImplementation((() => Promise.resolve([])) as never);
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      await POST(domainRequest({ athlete_id: 'ath-1' }));

      const [sql, params] = observationCall();
      expect(sql).toContain('note_type = any($3::text[])');
      expect(params[2]).toBeNull();
    }
  });

  test('THE DEFECT: a guardian no longer receives barrier reports through this route', async () => {
    // /api/pilot/parent/barrier-report writes guardian-authored
    // 'home_barrier' / 'transportation_barrier' rows into the same table. An
    // unfiltered read handed them to the athlete and to every OTHER linked
    // guardian -- one household reading the other household's report.
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-parent', role: 'parent' }));

    await POST(domainRequest({ athlete_id: 'ath-1' }));

    const [sql, params] = observationCall();
    expect(sql).toContain('note_type = any($3::text[])');
    expect(params[2]).toEqual(['parent_message']);
    expect(params[2]).not.toContain('home_barrier');
    expect(params[2]).not.toContain('transportation_barrier');
  });

  test('THE DEFECT: an athlete no longer receives barrier reports or their guardian\'s messages', async () => {
    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-1' }),
    );

    await POST(domainRequest({ athlete_id: 'ath-1' }));

    const [sql, params] = observationCall();
    expect(sql).toContain('note_type = any($3::text[])');
    expect(params[2]).toEqual(['coach_observation']);
    expect(params[2]).not.toContain('home_barrier');
    expect(params[2]).not.toContain('transportation_barrier');
    expect(params[2]).not.toContain('parent_message');
  });

  test('the athlete gate still runs before any read', async () => {
    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-2' }),
    );

    const response = await POST(domainRequest({ athlete_id: 'ath-1' }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE CO-GUARDIAN PROJECTION.
//
// The guardian read was `select p.*` over pilot.parents, whose columns include
// phone, email and account_id. requireRole here admits 'athlete' and 'parent',
// and assertActorCanAccessAthlete admits the athlete themself and EVERY linked
// guardian -- so one household received the other household's phone number and
// email address, and the child received both.
//
// That is the same disclosure the note_type filter directly above it was
// written to stop, arriving through the column list instead of through the row
// filter. The platform's posture elsewhere is stricter still: duplicateGuardians.ts
// masks a guardian email even for an organization admin, and passbook.ts's
// guardian read -- the athlete-and-guardian-facing one -- selects parent_id,
// full_name and relationship only.
//
// These assert the SELECT LIST because the route passes database rows straight
// through to the response: for this read, the projection IS the control, so a
// wildcard in it is the disclosure. The lists are compared for EQUALITY rather
// than probed with `not.toContain`, since "p.*" contains no substring named
// "p.phone" and a containment check would pass over the very defect it names.

/** The SQL and parameters the guardian read was issued with. */
function guardianCall(): [string, unknown[]] {
  const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('from pilot.guardian_links'));
  if (!call) {
    throw new Error('the route never read the guardian links');
  }
  return [String(call[0]), call[1] as unknown[]];
}

/** Every column between `select` and `from`, normalized and split. */
function guardianSelectList(): string[] {
  const [sql] = guardianCall();
  const match = /select\s+([\s\S]*?)\s+from\s/i.exec(sql);
  if (!match) {
    throw new Error(`the guardian read has no parsable select list: ${sql}`);
  }
  return match[1].split(',').map((column) => column.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const NON_STAFF_READERS: Array<[string, Partial<PilotPrincipal>]> = [
  ['a linked guardian', { accountId: 'acct-parent', role: 'parent' }],
  ['the athlete themself', { accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-1' }],
];

const STAFF_READERS: Array<[string, Partial<PilotPrincipal>]> = [
  ['an organization admin', { accountId: 'acct-admin', role: 'organization_admin' }],
  ['a coach', { accountId: 'acct-coach', role: 'coach' }],
];

describe('the guardian projection is an explicit column list, never p.*', () => {
  // A table-driven guard over an empty list passes without ever running.
  test('the reader tables are not empty', () => {
    expect(NON_STAFF_READERS.length).toBeGreaterThan(0);
    expect(STAFF_READERS.length).toBeGreaterThan(0);
  });

  test.each([...NON_STAFF_READERS, ...STAFF_READERS])(
    'for %s the guardian read names its columns instead of taking the whole row',
    async (_label, overrides) => {
      mockRequirePrincipal.mockResolvedValue(principal(overrides));

      await POST(domainRequest({ athlete_id: 'ath-1' }));

      // A wildcard ships whatever pilot.parents grows next. Naming the columns
      // makes adding one to this response a decision rather than an accident.
      expect(guardianSelectList()).not.toContain('p.*');
    },
  );

  test.each(NON_STAFF_READERS)(
    'THE DEFECT: %s receives identity and relationship only -- no other guardian\'s contact details',
    async (_label, overrides) => {
      mockRequirePrincipal.mockResolvedValue(principal(overrides));

      await POST(domainRequest({ athlete_id: 'ath-1' }));

      // Equality, not containment: this is the whole list, so a column added
      // later fails here rather than riding along unnoticed. Matches the set
      // passbook.ts already hands the same two readers.
      expect(guardianSelectList()).toEqual([
        'p.parent_id',
        'p.full_name',
        'g.relationship_to_athlete',
      ]);
    },
  );

  test.each(STAFF_READERS)(
    '%s still reads guardian contact details -- the roster and the emergency call need them',
    async (_label, overrides) => {
      mockRequirePrincipal.mockResolvedValue(principal(overrides));

      await POST(domainRequest({ athlete_id: 'ath-1' }));

      const columns = guardianSelectList();
      expect(columns).toContain('p.phone');
      expect(columns).toContain('p.email');
      expect(columns).toContain('p.parent_id');
      expect(columns).toContain('g.relationship_to_athlete');
    },
  );
});
