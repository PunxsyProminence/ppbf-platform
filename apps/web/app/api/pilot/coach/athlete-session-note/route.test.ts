import { NextRequest } from 'next/server';

import { GET } from './route';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { NO_ATHLETE_NOTE_PLACEHOLDER } from '@/src/shared/sessionNoteSemantics';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * A-FIN-08 -- any coach or admin in the athlete's own organization reads that
 * athlete's session note for today, and nothing else off the session row.
 *
 * WHAT IS REAL AND WHAT IS FAKED. requirePrincipal is faked (there is no
 * session store here) and so is the driver. Everything between is shipped
 * code: the route, the real access.ts (requireRole and
 * assertAthleteBelongsToOrganization), the real sessionNotes.ts reader with
 * its gym-day reduction, the real sessionNoteSemantics recognizer and the
 * real jsonError. So a 403 below is the one a caller would actually receive.
 *
 * THE FAKE HONOURS A PREDICATE ONLY WHEN THE SQL CARRIES IT. A deleted
 * athlete is filtered only because the statement says `deleted_at is null`; a
 * cross-organization athlete only because it matches organization_id. Drop
 * either from the gate and these refusals go red, which is the point of
 * modelling tables rather than answers.
 *
 * THE DAY IS COMPUTED, NOT ASSUMED. The fake reduces each row's created_at in
 * America/New_York exactly as Postgres would, and matches it against the day
 * the statement asked for. So "which day did the route ask about" is
 * observable, and a read that reverted to the UTC day finds nothing.
 *
 * RELATIONSHIP STATE IS MODELLED ONLY TO PROVE IT IS NOT READ. The fake keeps
 * a pilot.coach_coverage table -- one grant on ath-marisol inside its window
 * and one that has lapsed -- and every athlete row carries a coach_id of
 * record. So the four coach callers below hold four genuinely different
 * relationships to the same child: coach of record, live grant, expired
 * grant, nothing whatever. All four read the note, because organization
 * membership is the only question this route asks, and the cases assert that
 * no coach_coverage statement was issued for any of them. Modelled states
 * treated identically is what proves the indifference; naming callers for
 * states the fixture never creates would be one test three times under three
 * names, and a suite that merely stopped mentioning coverage would not catch
 * a route that quietly started consulting it again.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

/* FROZEN ON THE FAR SIDE OF UTC MIDNIGHT. 20:30 on a September evening in
   Punxsutawney is 00:30 the NEXT day in UTC, and the database runs in UTC.
   GYM_DAY and UTC_DAY below are therefore different days at this one instant,
   which is the entire drift this slice exists to avoid. */
const GYM_DAY = '2026-09-25';
const UTC_DAY = '2026-09-26';
const EVENING_AT_THE_GYM = new Date('2026-09-26T00:30:00Z');

/** The note as the athlete typed it: punctuation, a blank line, trailing
 *  space. "Exactly as stored" has to survive all three. */
const MARISOL_NOTE = 'Left knee is "tight" after sparring.\n\nStill want to do pads. ';

interface FakeAthlete {
  organization_id: string;
  athlete_id: string;
  /** The coach of record. No statement this route issues reads it, which is
   *  exactly why it is here: the caller named "the coach of record" below has
   *  to really be one for that name to mean anything. */
  coach_id: string;
  deleted_at: string | null;
}

/** A temporary per-athlete grant on pilot.coach_coverage. `live` stands for the
 *  `starts_at <= now() and expires_at > now()` window the real authorization
 *  statement asks for (src/server/pilot/access.ts), so a lapsed grant is a row
 *  that exists and does not currently hold -- the state that used to decide
 *  whether a substitute could read this child at all. */
interface FakeCoverage {
  organization_id: string;
  athlete_id: string;
  covering_coach_id: string;
  live: boolean;
}

interface FakeSession {
  organization_id: string;
  athlete_id: string;
  created_at: string;
  notes: string | null;
  /** Deliberately wrong on one row -- nothing may read it. */
  date: string;
}

let athletes: FakeAthlete[];
let coverage: FakeCoverage[];
let sessions: FakeSession[];
let statements: string[];

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** The gym's calendar day for an instant, the way Postgres would reduce it. */
function gymDayOf(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const at = (type: string) => parts.find((part) => part.type === type)?.value;
  return [at('year'), at('month'), at('day')].join('-');
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(EVENING_AT_THE_GYM);

  athletes = [
    { organization_id: 'org-1', athlete_id: 'ath-marisol', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-devon', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-rosa', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-auto', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-deleted', coach_id: 'coach-record', deleted_at: '2026-09-01T00:00:00Z' },
    { organization_id: 'org-2', athlete_id: 'ath-othergym', coach_id: 'coach-othergym', deleted_at: null },
  ];

  /* Two grants on Marisol, so "covering" and "lapsed" below are states that
     exist in the fake rather than two spellings of the same accountId. If the
     route ever starts consulting coverage, the fake has something to answer
     with -- and coach-lapsed's row then goes red on its own name. */
  coverage = [
    { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-covering', live: true },
    { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-lapsed', live: false },
  ];

  sessions = [
    // Earlier this evening, gym-side. Superseded by the one below.
    {
      organization_id: 'org-1',
      athlete_id: 'ath-marisol',
      created_at: '2026-09-25T23:05:00.000Z',
      date: GYM_DAY,
      notes: 'An earlier note from the same evening.',
    },
    // 20:20 at the gym = 00:20 UTC TOMORROW. Newest of the gym day, so this
    // is the one a coach must be shown.
    {
      organization_id: 'org-1',
      athlete_id: 'ath-marisol',
      created_at: '2026-09-26T00:20:00.000Z',
      date: UTC_DAY,
      notes: MARISOL_NOTE,
    },
    // Yesterday's session, carrying TODAY's date in the drifting column. Only
    // a read that trusts `date` would surface it.
    {
      organization_id: 'org-1',
      athlete_id: 'ath-rosa',
      created_at: '2026-09-24T22:00:00.000Z',
      date: GYM_DAY,
      notes: 'Yesterday. Must not be read as today.',
    },
    {
      organization_id: 'org-1',
      athlete_id: 'ath-devon',
      created_at: '2026-09-25T22:00:00.000Z',
      date: GYM_DAY,
      notes: NO_ATHLETE_NOTE_PLACEHOLDER,
    },
    {
      organization_id: 'org-1',
      athlete_id: 'ath-auto',
      created_at: '2026-09-25T22:10:00.000Z',
      date: GYM_DAY,
      notes: 'Auto check-in readiness GREEN',
    },
    // The soft-deleted athlete HAS a note today: there is real data to leak.
    {
      organization_id: 'org-1',
      athlete_id: 'ath-deleted',
      created_at: '2026-09-25T22:20:00.000Z',
      date: GYM_DAY,
      notes: 'deleted athlete note',
    },
    {
      organization_id: 'org-2',
      athlete_id: 'ath-othergym',
      created_at: '2026-09-25T22:30:00.000Z',
      date: GYM_DAY,
      notes: 'another gym note',
    },
  ];

  statements = [];

  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);

    if (/^(insert|update|delete|create|alter|drop)\b/i.test(text)) {
      throw new Error('write attempted by a read-only route: ' + text);
    }

    /* Answered, not refused. A coverage lookup from this route would be a
       defect -- but one the suite has to be able to SEE rather than one that
       blows up the fake, because the shape of the defect matters: a route that
       consulted the grant window would still serve coach-covering and would
       start refusing coach-lapsed, and that is the failure the named rows
       below are there to catch. The predicates are honoured only when the SQL
       carries them, exactly as the real statement in access.ts writes them. */
    if (text.includes('from pilot.coach_coverage')) {
      const [organizationId, athleteId, coachId] = params as string[];
      const windowed = text.includes('expires_at > now()');
      // The grant table has no deleted_at of its own: only a statement that
      // joins the athlete and asks for a live one can see a deletion.
      const liveAthleteOnly = text.includes('join pilot.athletes') && text.includes('deleted_at is null');
      const grant = coverage.find((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId
        && row.covering_coach_id === coachId
        && (!windowed || row.live)
        && (!liveAthleteOnly || athletes.some((ath) => ath.organization_id === row.organization_id
          && ath.athlete_id === row.athlete_id
          && ath.deleted_at === null)));
      return grant ? { athlete_id: grant.athlete_id } : null;
    }

    if (text.includes('from pilot.athletes')) {
      const [athleteId, organizationId] = params as string[];
      const liveOnly = text.includes('deleted_at is null');
      const scoped = text.includes('organization_id');
      const hit = athletes.find((row) => row.athlete_id === athleteId
        && (!scoped || row.organization_id === organizationId)
        && (!liveOnly || row.deleted_at === null));
      return hit ? { athlete_id: hit.athlete_id } : null;
    }

    if (text.includes('from pilot.sessions')) {
      const [organizationId, athleteId, day] = params as string[];
      // The day must be one the application resolved and passed in. A read
      // that asked the database for its own day is refused by name.
      if (/current_date|now\(\)/i.test(text)) {
        throw new Error('session read used the database clock: ' + text);
      }
      if (!text.includes("at time zone 'America/New_York'")) {
        throw new Error('session read did not reduce created_at in the gym zone: ' + text);
      }
      const matches = sessions
        .filter((row) => row.organization_id === organizationId
          && row.athlete_id === athleteId
          && gymDayOf(row.created_at) === day)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return matches[0] ? { notes: matches[0].notes } : null;
    }

    throw new Error('unexpected statement: ' + text);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'coach-record',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

async function readAs(caller: Partial<PilotPrincipal>, queryString = 'athlete_id=ath-marisol') {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await GET(
    new NextRequest('http://localhost/api/pilot/coach/athlete-session-note?' + queryString),
  );
  return { status: response.status, body: await response.json() };
}

const coverageReads = () => statements.filter((sql) => sql.includes('pilot.coach_coverage'));
const sessionReads = () => statements.filter((sql) => sql.includes('pilot.sessions'));

describe('who may read it', () => {
  /* Each coach row names the relationship that account actually holds to
     Marisol in the fixture: coach_id of record, a grant inside its window, a
     grant outside it, and no row anywhere. They are listed because they used
     to be four different answers, and under this permission they are one. */
  it.each([
    ['the coach of record', { accountId: 'coach-record', role: 'coach' }],
    ['a coach holding a live coverage grant', { accountId: 'coach-covering', role: 'coach' }],
    ['a coach whose coverage grant has lapsed', { accountId: 'coach-lapsed', role: 'coach' }],
    ['a same-organization coach with no relationship at all', { accountId: 'coach-stranger', role: 'coach' }],
    ['an organization admin', { accountId: 'admin-1', role: 'organization_admin' }],
    ['a legacy admin', { accountId: 'admin-legacy', role: 'admin' }],
  ])('%s reads the note', async (_label, caller) => {
    const { status, body } = await readAs(caller as Partial<PilotPrincipal>);
    expect(status).toBe(200);
    expect(body).toEqual({ today: { note: MARISOL_NOTE } });
  });

  /* The widening is organization membership, NOT a looser relationship rule.
     Grants on Marisol exist in the fake, so a lookup would have something to
     find; the claim is that the route never asks. Said for every flavour of
     caller, because "it stopped asking for the coach of record" was already
     true before this slice. */
  it('never asks about coverage, for any caller', async () => {
    expect(coverage.filter((grant) => grant.athlete_id === 'ath-marisol')).not.toEqual([]);

    for (const caller of [
      { accountId: 'coach-record', role: 'coach' as const },
      { accountId: 'coach-covering', role: 'coach' as const },
      { accountId: 'coach-lapsed', role: 'coach' as const },
      { accountId: 'coach-stranger', role: 'coach' as const },
      { accountId: 'admin-1', role: 'organization_admin' as const },
    ]) {
      statements = [];
      const { status } = await readAs(caller);

      expect({ caller: caller.accountId, status, coverageReads: coverageReads() })
        .toEqual({ caller: caller.accountId, status: 200, coverageReads: [] });
    }
  });
});

/* THE TWO MODELLED GRANT STATES ARE REALLY TWO STATES.
   Not a test of the route -- a check on the fixture the rows above are named
   for. "A coach holding a live coverage grant" and "a coach whose coverage
   grant has lapsed" only mean something while the fake can tell those two
   apart; if the grants ever collapse into one state (both live, the `live`
   flag dropped, the window predicate no longer honoured) the two rows quietly
   become one test twice over under two names, which is exactly the defect this
   fixture exists to answer. The statement is the windowed lookup
   authorization really issues: assertCoachAssignedToAthlete
   (src/server/pilot/access.ts:92, the query at :121) -- so this also pins
   that the fake honours the window rather than matching on the account id
   alone.

   THAT CITATION WAS WRONG WHEN FIRST WRITTEN. It named
   "assertCoachCanAccessAthlete", which exists nowhere in this repository --
   an invented symbol, sitting where a reader would look to check that the
   pasted SQL below still matches production. It was plausible because two
   real neighbours read like it: assertCoachAssignedToAthlete, which actually
   issues this statement, and assertActorCanAccessAthlete at :374, which is
   the gate this route deliberately does NOT use. A copied query is only as
   good as the pointer back to its original, so the pointer is the part that
   has to be right. */
describe('the modelled coverage states', () => {
  const WINDOWED_GRANT_LOOKUP = `select cc.athlete_id
       from pilot.coach_coverage cc
       join pilot.athletes ath
         on ath.organization_id = cc.organization_id and ath.athlete_id = cc.athlete_id
       where cc.organization_id = $1
         and cc.athlete_id = $2
         and cc.covering_coach_id = $3
         and cc.starts_at <= now()
         and cc.expires_at > now()
         and ath.deleted_at is null`;

  const grantFor = (coachId: string) => mockQueryOne(WINDOWED_GRANT_LOOKUP, ['org-1', 'ath-marisol', coachId]);

  it('answer a windowed lookup differently: live grant found, lapsed grant not, stranger never', async () => {
    await expect(grantFor('coach-covering')).resolves.toEqual({ athlete_id: 'ath-marisol' });
    await expect(grantFor('coach-lapsed')).resolves.toBeNull();
    await expect(grantFor('coach-stranger')).resolves.toBeNull();
  });
});

describe('who may not', () => {
  it.each([
    ['an athlete', { role: 'athlete', athleteId: 'ath-marisol' }],
    ['a parent', { role: 'parent' }],
    ['the board', { role: 'board' }],
    ['a platform owner', { role: 'platform_owner' }],
  ])('%s is refused before any session is read', async (_label, caller) => {
    const { status } = await readAs(caller as Partial<PilotPrincipal>);
    expect(status).toBe(403);
    expect(sessionReads()).toEqual([]);
  });

  it('refuses a coach from another gym', async () => {
    const { status } = await readAs({ role: 'coach', organizationId: 'org-2' });
    expect(status).toBe(403);
  });

  it('refuses a soft-deleted athlete even though a note exists for them', async () => {
    const { status } = await readAs({ role: 'coach' }, 'athlete_id=ath-deleted');
    expect(status).toBe(403);
    expect(JSON.stringify(statements)).not.toContain('deleted athlete note');
  });

  // Cross-organization, soft-deleted and "no such child" must be one answer.
  it('refuses an unknown athlete the same way as a forbidden one', async () => {
    const unknown = await readAs({ role: 'coach' }, 'athlete_id=ath-nobody');
    const deleted = await readAs({ role: 'coach' }, 'athlete_id=ath-deleted');
    expect(unknown.status).toBe(403);
    expect(unknown.body).toEqual(deleted.body);
  });
});

describe('the request cannot aim itself', () => {
  it('rejects a missing athlete_id', async () => {
    const { status } = await readAs({ role: 'coach' }, '');
    expect(status).toBe(400);
  });

  // The organization is the principal's own. A query parameter must not move
  // the read into another gym.
  it('ignores an organization_id parameter', async () => {
    const { status } = await readAs(
      { role: 'coach', organizationId: 'org-1' },
      'athlete_id=ath-othergym&organization_id=org-2',
    );
    expect(status).toBe(403);
  });
});

describe('which day it reads', () => {
  it('reads the gym evening, not the UTC day that already rolled over', async () => {
    const { body } = await readAs({ role: 'coach' });
    // ath-marisol's newest row is stamped 00:20 UTC on UTC_DAY. Only a read
    // on the gym day finds it.
    expect(body).toEqual({ today: { note: MARISOL_NOTE } });
    expect(GYM_DAY).not.toBe(UTC_DAY);
  });

  it('shows the newest session of the gym day when there are two', async () => {
    const { body } = await readAs({ role: 'coach' });
    expect(body.today.note).toBe(MARISOL_NOTE);
    expect(body.today.note).not.toContain('An earlier note');
  });

  it('does not let yesterday become today through the drifting date column', async () => {
    const { status, body } = await readAs({ role: 'coach' }, 'athlete_id=ath-rosa');
    expect(status).toBe(200);
    expect(body).toEqual({ today: null });
  });
});

describe('what a coach is told', () => {
  it('says plainly when no session was started today', async () => {
    const { status, body } = await readAs({ role: 'coach' }, 'athlete_id=ath-rosa');
    expect(status).toBe(200);
    expect(body).toEqual({ today: null });
  });

  it('returns the athlete own words exactly, including line breaks', async () => {
    const { body } = await readAs({ role: 'coach' });
    expect(body.today.note).toBe(MARISOL_NOTE);
  });

  it('never sends the no-note placeholder as something a child wrote', async () => {
    const { status, body } = await readAs({ role: 'coach' }, 'athlete_id=ath-devon');
    expect(status).toBe(200);
    expect(body).toEqual({ today: { note: null } });
    expect(JSON.stringify(body)).not.toContain('No athlete note provided');
  });

  it('never sends the historical Auto check-in readiness text', async () => {
    const { status, body } = await readAs({ role: 'coach' }, 'athlete_id=ath-auto');
    expect(status).toBe(200);
    expect(body).toEqual({ today: { note: null } });
    expect(JSON.stringify(body)).not.toContain('Auto check-in readiness');
  });

  // "No session today" and "a session with no note" are different facts about
  // a child's day, and the screen says different things for them.
  it('keeps "no session" and "session with no note" apart', async () => {
    const noSession = await readAs({ role: 'coach' }, 'athlete_id=ath-rosa');
    const noNote = await readAs({ role: 'coach' }, 'athlete_id=ath-devon');
    expect(noSession.body).toEqual({ today: null });
    expect(noNote.body).toEqual({ today: { note: null } });
    expect(noSession.body).not.toEqual(noNote.body);
  });

  it('carries nothing but the note off the session row', async () => {
    const { body } = await readAs({ role: 'coach' });
    expect(Object.keys(body)).toEqual(['today']);
    expect(Object.keys(body.today)).toEqual(['note']);
  });
});
