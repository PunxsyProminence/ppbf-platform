import { query } from './db';
import { BEHAVIOUR_NOTE_TYPE, listBehaviourNotes } from './behaviourNotes';
import { ATHLETE_READABLE_NOTE_TYPES, PARENT_READABLE_NOTE_TYPES, coachObservationNoteTypesForReader } from './intake';
import {
  PASSBOOK_ATHLETE_NOTE_TYPES,
  PASSBOOK_GUARDIAN_NOTE_TYPES,
} from './passbook';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = query as jest.Mock;

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
});

test('the list is scoped to one gym and to the behaviour note type, and drops deleted athletes', async () => {
  await listBehaviourNotes('org-1');
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('co.organization_id = $1');
  expect(sql).toContain('co.note_type = $2');
  expect(sql).toContain('a.deleted_at is null');
  expect(params[0]).toBe('org-1');
  expect(params[1]).toBe(BEHAVIOUR_NOTE_TYPE);
  expect(BEHAVIOUR_NOTE_TYPE).toBe('behavior_standard');
});

const rowOf = (n: number) => ({
  note_id: String(n), athlete_id: 'a', athlete_name: 'A', note_text: 't', author_role: 'coach', created_at: 'x',
});

test('the page size is bounded, and one extra row is read to tell a partial list', async () => {
  await listBehaviourNotes('org-1', { limit: 100000 });
  expect(mockQuery.mock.calls[0][1][3]).toBe(101);
});

test('a list longer than the page says it is truncated and returns only the page', async () => {
  mockQuery.mockResolvedValueOnce(Array.from({ length: 101 }, (_, n) => rowOf(n)));
  const page = await listBehaviourNotes('org-1');
  expect(page.items).toHaveLength(100);
  expect(page.truncated).toBe(true);
});

test('a list within the page is not truncated', async () => {
  mockQuery.mockResolvedValueOnce(Array.from({ length: 100 }, (_, n) => rowOf(n)));
  const page = await listBehaviourNotes('org-1');
  expect(page.items).toHaveLength(100);
  expect(page.truncated).toBe(false);
});

// OD-2026-10-10-003 item 3: a coach's note is staff only. These are the
// family-facing readers of the shared pilot.coach_observations table; none may
// name the behaviour note type, so none can return one.
describe('no athlete or parent reader can return a behaviour note', () => {
  test('intake reader lists (domain-get, intake case aggregate)', () => {
    expect(ATHLETE_READABLE_NOTE_TYPES).not.toContain(BEHAVIOUR_NOTE_TYPE);
    expect(PARENT_READABLE_NOTE_TYPES).not.toContain(BEHAVIOUR_NOTE_TYPE);
    expect(coachObservationNoteTypesForReader('athlete')).not.toContain(BEHAVIOUR_NOTE_TYPE);
    expect(coachObservationNoteTypesForReader('parent')).not.toContain(BEHAVIOUR_NOTE_TYPE);
  });

  test('passbook reader lists', () => {
    expect(PASSBOOK_ATHLETE_NOTE_TYPES).not.toContain(BEHAVIOUR_NOTE_TYPE);
    expect(PASSBOOK_GUARDIAN_NOTE_TYPES).not.toContain(BEHAVIOUR_NOTE_TYPE);
  });

  test('staff readers keep it (coach and organization admin)', () => {
    expect(coachObservationNoteTypesForReader('coach')).toBeNull();
    expect(coachObservationNoteTypesForReader('organization_admin')).toBeNull();
  });
});
