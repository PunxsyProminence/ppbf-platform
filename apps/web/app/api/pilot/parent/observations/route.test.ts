import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { composeObservationText, parseObservationText } from '@/src/shared/parentObservations';

/**
 * WO-PH-04: what a guardian notices at home, written and read back.
 *
 * Two families, and two guardians of one child. requirePrincipal, the audit
 * writer and the database driver are stood in for; access.ts,
 * guardianAccess.ts, intake.ts createCoachObservation and the route are real.
 * The fake database keeps pilot.coach_observations as rows and answers the
 * route's SELECT by the predicates the statement carries, so a read that
 * forgot one of them returns rows it should not.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
// The transaction's client: its statements go to the same fake table, and
// are kept apart so a test can see which writes rode in the transaction.
const transactionClient = { query: jest.fn() };
let transactionStatements: string[];
let readBackFails: boolean;

const athletes = [
  { organization_id: 'org-1', athlete_id: 'ath-a', dob: '2013-04-02' },
  { organization_id: 'org-1', athlete_id: 'ath-b', dob: '2012-09-15' },
  { organization_id: 'org-1', athlete_id: 'ath-a-sib', dob: '2015-01-20' },
];
// Family A has two guardians of ath-a; family B has one of ath-b.
const parents = [
  { organization_id: 'org-1', account_id: 'acct-a1', parent_id: 'par-a1' },
  { organization_id: 'org-1', account_id: 'acct-a2', parent_id: 'par-a2' },
  { organization_id: 'org-1', account_id: 'acct-b', parent_id: 'par-b' },
];
const links = [
  { organization_id: 'org-1', parent_id: 'par-a1', athlete_id: 'ath-a' },
  // Guardian a1 also has a younger child.
  { organization_id: 'org-1', parent_id: 'par-a1', athlete_id: 'ath-a-sib' },
  { organization_id: 'org-1', parent_id: 'par-a2', athlete_id: 'ath-a' },
  { organization_id: 'org-1', parent_id: 'par-b', athlete_id: 'ath-b' },
];

interface StoredRow {
  organization_id: string;
  note_id: string;
  athlete_id: string;
  coach_account_id: string;
  author_role: string;
  note_type: string;
  note_text: string;
  created_at: string;
}
let table: StoredRow[];
let clock: number;

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  clock = Date.parse('2026-10-12T12:00:00.000Z');
  table = [
    // A coach's own note and a coach message about ath-a: never a guardian observation.
    { organization_id: 'org-1', note_id: '00000000-0000-0000-0000-00000000c0a1', athlete_id: 'ath-a', coach_account_id: 'acct-coach', author_role: 'coach', note_type: 'coach_observation', note_text: 'Coach-only: watch the left shoulder.', created_at: '2026-10-01 12:00:00+00' },
    { organization_id: 'org-1', note_id: '00000000-0000-0000-0000-00000000c0a2', athlete_id: 'ath-a', coach_account_id: 'acct-coach', author_role: 'coach', note_type: 'parent_message', note_text: 'Bring gloves.', created_at: '2026-10-02 12:00:00+00' },
    // Guardian a1's own barrier report about ath-a: same author, another type.
    { organization_id: 'org-1', note_id: '00000000-0000-0000-0000-00000000ba01', athlete_id: 'ath-a', coach_account_id: 'acct-a1', author_role: 'parent', note_type: 'home_barrier', note_text: 'No ride on Thursdays.', created_at: '2026-10-02 13:00:00+00' },
    // The same ids in another gym: never this gym's record.
    { organization_id: 'org-2', note_id: '00000000-0000-0000-0000-0000000000f2', athlete_id: 'ath-a', coach_account_id: 'acct-a1', author_role: 'parent', note_type: 'parent_observation', note_text: composeObservationText('energy', 2, 'Another gym.'), created_at: '2026-10-04 12:00:00+00' },
    // The other guardian of ath-a has written one already.
    { organization_id: 'org-1', note_id: '00000000-0000-0000-0000-0000000000a2', athlete_id: 'ath-a', coach_account_id: 'acct-a2', author_role: 'parent', note_type: 'parent_observation', note_text: composeObservationText('motivation', 3, 'Other guardian: a hard week.'), created_at: '2026-10-03 12:00:00+00' },
  ];
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    if (text.includes('from pilot.guardian_links')) {
      const [organizationId, athleteId, accountId] = params as string[];
      const parentIds = parents.filter((row) => row.organization_id === organizationId && row.account_id === accountId).map((row) => row.parent_id);
      const link = links.find((row) => row.organization_id === organizationId && row.athlete_id === athleteId && parentIds.includes(row.parent_id));
      const athlete = athletes.find((row) => row.organization_id === organizationId && row.athlete_id === athleteId);
      return link && athlete ? { athlete_id: athleteId, dob: athlete.dob } : null;
    }
    throw new Error(`unexpected queryOne in this test: ${text}`);
  });
  transactionStatements = [];
  readBackFails = false;
  mockWithTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(transactionClient));
  transactionClient.query.mockImplementation(async (sql: string, params: unknown[]) => {
    transactionStatements.push(normalize(sql));
    return { rows: await mockQuery(sql, params) };
  });
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    if (readBackFails && text.includes('note_id = $5')) throw new Error('read-back lost');
    if (text.startsWith('insert into pilot.coach_observations')) {
      const [organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text] = params as string[];
      clock += 60_000;
      table.push({ organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text, created_at: new Date(clock).toISOString() });
      return [];
    }
    if (text.startsWith('select') && text.includes('from pilot.coach_observations')) {
      // Each predicate is honoured only if the statement carries it.
      const p = params as string[];
      let rows = table.slice();
      if (text.includes('organization_id = $1')) rows = rows.filter((row) => row.organization_id === p[0]);
      if (text.includes('athlete_id = $2')) rows = rows.filter((row) => row.athlete_id === p[1]);
      if (text.includes('note_type = $3')) rows = rows.filter((row) => row.note_type === p[2]);
      if (text.includes('coach_account_id = $4')) rows = rows.filter((row) => row.coach_account_id === p[3]);
      if (text.includes('note_id = $5')) rows = rows.filter((row) => row.note_id === p[4]);
      if (text.includes('order by created_at desc')) rows.sort((x, y) => y.created_at.localeCompare(x.created_at));
      return rows.map((row) => ({ note_id: row.note_id, note_text: row.note_text, created_at: row.created_at }));
    }
    throw new Error(`unexpected query in this test: ${text}`);
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

function as(accountId: string, role: PilotPrincipal['role'] = 'parent') {
  mockRequirePrincipal.mockResolvedValue({
    accountId,
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal);
}

async function post(body: Record<string, unknown>) {
  const response = await POST(new NextRequest('http://localhost/api/pilot/parent/observations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

async function get(athleteId: string) {
  const response = await GET(new NextRequest(`http://localhost/api/pilot/parent/observations?athlete_id=${athleteId}`));
  return { status: response.status, payload: (await response.json()) as { items?: Array<Record<string, unknown>> } };
}

describe('a linked guardian writes and reads back', () => {
  test('the entry is stored as a parent-authored parent_observation in words a coach reads, and comes back after a reload', async () => {
    as('acct-a1');
    const written = await post({ athlete_id: 'ath-a', category: 'energy', rating: 7, notes: 'Tired after school all week.' });
    expect(written.status).toBe(201);
    expect(written.payload.item).toMatchObject({ category: 'energy', rating: 7, notes: 'Tired after school all week.' });

    const stored = table[table.length - 1];
    expect(stored).toMatchObject({
      athlete_id: 'ath-a',
      coach_account_id: 'acct-a1',
      author_role: 'parent',
      note_type: 'parent_observation',
      note_text: 'Energy · 7 out of 10\n\nTired after school all week.',
    });

    const read = await get('ath-a');
    expect(read.status).toBe(200);
    expect(read.payload.items?.[0]).toMatchObject({ category: 'energy', rating: 7, notes: 'Tired after school all week.' });
  });

  test('no rating is a real answer and is stored without one', async () => {
    as('acct-a1');
    const written = await post({ athlete_id: 'ath-a', category: 'general_development', notes: 'Started helping his sister with homework.' });
    expect(written.status).toBe(201);
    expect(table[table.length - 1].note_text).toBe('General development\n\nStarted helping his sister with homework.');
    expect(written.payload.item).toMatchObject({ rating: null });
  });

  test('the note and its audit row are one transaction, and the audit carries no notes', async () => {
    as('acct-a1');
    await post({ athlete_id: 'ath-a', category: 'motivation', rating: 9, notes: 'Keen.' });
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(transactionStatements.some((text) => text.startsWith('insert into pilot.coach_observations'))).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'create',
      actor_account_id: 'acct-a1',
      actor_role: 'parent',
      entity_type: 'parent_observation',
      details: { athlete_id: 'ath-a', category: 'motivation', rated: true },
    }), transactionClient);
  });

  test('a saved entry whose read-back fails is still a save: 201 with no item, never a failure', async () => {
    as('acct-a1');
    readBackFails = true;
    const written = await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Saved anyway.' });
    expect(written.status).toBe(201);
    expect(written.payload).toEqual({ ok: true, item: null });
    expect(table[table.length - 1].note_text).toBe('Energy\n\nSaved anyway.');
  });

  test('the entry handed back is the one just saved, not another of this guardian’s', async () => {
    as('acct-a1');
    await post({ athlete_id: 'ath-a', category: 'energy', notes: 'First.' });
    const second = await post({ athlete_id: 'ath-a', category: 'motivation', notes: 'Second.' });
    expect((second.payload.item as { note_id: string }).note_id).toBe(table[table.length - 1].note_id);
    expect(second.payload.item).toMatchObject({ notes: 'Second.' });
  });

  test('the history is newest first', async () => {
    as('acct-a1');
    await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Older.' });
    await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Newer.' });
    expect((await get('ath-a')).payload.items?.map((item) => item.notes)).toEqual(['Newer.', 'Older.']);
  });

  test('the answer carries no account id', async () => {
    as('acct-a1');
    const written = await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Fine.' });
    const read = await get('ath-a');
    expect(JSON.stringify(written.payload)).not.toMatch(/acct-|account_id/);
    expect(JSON.stringify(read.payload)).not.toMatch(/acct-|account_id/);
  });
});

describe('who reads what', () => {
  test('a guardian reads only their own observations: not the other guardian’s, not a coach’s note or message, not their own barrier report, not another gym’s', async () => {
    as('acct-a1');
    await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Mine.' });
    const read = await get('ath-a');
    expect(read.payload.items?.map((item) => item.notes)).toEqual(['Mine.']);
  });

  test('a guardian with two children reads each child’s own observations, never the sibling’s', async () => {
    as('acct-a1');
    await post({ athlete_id: 'ath-a', category: 'energy', notes: 'About the older one.' });
    await post({ athlete_id: 'ath-a-sib', category: 'energy', notes: 'About the younger one.' });
    expect((await get('ath-a')).payload.items?.map((item) => item.notes)).toEqual(['About the older one.']);
    expect((await get('ath-a-sib')).payload.items?.map((item) => item.notes)).toEqual(['About the younger one.']);
  });

  test('another family’s guardian is refused on this child, for writing and for reading, and nothing is written', async () => {
    as('acct-b');
    const before = table.length;
    const written = await post({ athlete_id: 'ath-a', category: 'energy', notes: 'Not my child.' });
    expect(written.status).toBe(403);
    expect(table).toHaveLength(before);

    const read = await get('ath-a');
    expect(read.status).toBe(403);
    expect(read.payload.items).toBeUndefined();
  });

  test('only a guardian may use this route', async () => {
    as('acct-coach', 'coach');
    expect((await post({ athlete_id: 'ath-a', category: 'energy', notes: 'x' })).status).toBe(403);
    expect((await get('ath-a')).status).toBe(403);
  });
});

describe('what is refused', () => {
  test.each([
    ['an unknown category', { category: 'mood', notes: 'x' }],
    ['a rating of 0', { category: 'energy', rating: 0, notes: 'x' }],
    ['a rating of 11', { category: 'energy', rating: 11, notes: 'x' }],
    ['a rating of 7.5', { category: 'energy', rating: 7.5, notes: 'x' }],
    ['a rating as text', { category: 'energy', rating: '7', notes: 'x' }],
    ['empty notes', { category: 'energy', notes: '   ' }],
    ['notes over 4000 characters', { category: 'energy', notes: 'x'.repeat(4001) }],
    ['a category that is an Object property', { category: 'toString', notes: 'x' }],
    ['a category of __proto__', { category: '__proto__', notes: 'x' }],
    ['an athlete id over 300 characters', { athlete_id: 'a'.repeat(301), category: 'energy', notes: 'x' }],
  ])('%s', async (_label, fields) => {
    as('acct-a1');
    const before = table.length;
    const response = await post({ athlete_id: 'ath-a', ...fields });
    expect(response.status).toBe(400);
    expect(table).toHaveLength(before);
  });

  test('a body of JSON null is refused as invalid, not a server error', async () => {
    as('acct-a1');
    const response = await POST(new NextRequest('http://localhost/api/pilot/parent/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    }));
    expect(response.status).toBe(400);
  });

  test('notes of exactly 4000 characters are accepted', async () => {
    as('acct-a1');
    expect((await post({ athlete_id: 'ath-a', category: 'energy', notes: 'x'.repeat(4000) })).status).toBe(201);
  });

  test('a rating of 1 and of 10 are accepted', async () => {
    as('acct-a1');
    expect((await post({ athlete_id: 'ath-a', category: 'energy', rating: 1, notes: 'low' })).status).toBe(201);
    expect((await post({ athlete_id: 'ath-a', category: 'energy', rating: 10, notes: 'high' })).status).toBe(201);
  });
});

describe('the text grammar', () => {
  test('reads back exactly what it writes', () => {
    expect(parseObservationText(composeObservationText('sleep_recovery', 10, 'Line one.\n\nLine two.'))).toEqual({
      category: 'sleep_recovery',
      rating: 10,
      notes: 'Line one.\n\nLine two.',
    });
  });

  test('a row it cannot parse is returned whole as notes, not dropped', () => {
    expect(parseObservationText('Something written another way')).toEqual({
      category: 'general_development',
      rating: null,
      notes: 'Something written another way',
    });
    expect(parseObservationText('Energy · 12 out of 10\n\nx')).toEqual({
      category: 'general_development',
      rating: null,
      notes: 'Energy · 12 out of 10\n\nx',
    });
  });
});
