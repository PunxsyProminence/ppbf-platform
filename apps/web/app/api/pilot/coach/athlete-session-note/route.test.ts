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
 * COVERAGE IS MODELLED ONLY TO PROVE IT IS NOT READ. A covering coach and a
 * lapsed one both appear below and both succeed -- because they are in the
 * organization -- and the cases assert no coach_coverage statement was issued
 * at all. A suite that simply stopped mentioning coverage would not catch a
 * route that quietly started consulting it again.
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
  deleted_at: string | null;
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
    { organization_id: 'org-1', athlete_id: 'ath-marisol', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-devon', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-rosa', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-auto', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-deleted', deleted_at: '2026-09-01T00:00:00Z' },
    { organization_id: 'org-2', athlete_id: 'ath-othergym', deleted_at: null },
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
  it.each([
    ['the coach of record', { accountId: 'coach-record', role: 'coach' }],
    ['an active covering coach', { accountId: 'coach-covering', role: 'coach' }],
    ['a coach whose coverage lapsed', { accountId: 'coach-lapsed', role: 'coach' }],
    ['a same-organization coach with no relationship at all', { accountId: 'coach-stranger', role: 'coach' }],
    ['an organization admin', { accountId: 'admin-1', role: 'organization_admin' }],
    ['a legacy admin', { accountId: 'admin-legacy', role: 'admin' }],
  ])('%s reads the note', async (_label, caller) => {
    const { status, body } = await readAs(caller as Partial<PilotPrincipal>);
    expect(status).toBe(200);
    expect(body).toEqual({ today: { note: MARISOL_NOTE } });
  });

  // The widening is organization membership, NOT a looser relationship rule.
  it('never asks about coverage, for any caller', async () => {
    await readAs({ accountId: 'coach-stranger', role: 'coach' });
    expect(coverageReads()).toEqual([]);
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
