import { readRoomNames, setRoomName } from './roomNames';
import { query, withTransaction } from './db';

/*
 * The store's own rules, on a recording client (lane W4-9, RN-1b; the
 * stoppedComingPolicy.test.ts pattern). The database half is
 * roomNames.pg.test.ts. These pin what that suite cannot see, because there
 * the module's reads and its transaction share one connection: the gym-row
 * lock comes first, the audit row is written on the transaction's client with
 * exact values, nothing is mirrored to SHADOW, a refused name writes nothing,
 * and only the gym admin ('admin' included, by its alias) writes.
 */

jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

beforeEach(() => jest.clearAllMocks());

interface Stored { name_key: string; display_name: string }

function recordingClient(stored: Stored[]) {
  const calls: Array<[string, unknown[]]> = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[]) => {
      calls.push([text, values]);
      return { rows: /^\s*select name_key, display_name/i.test(text) ? stored : [] };
    }),
  };
  mockWithTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  return calls;
}

const set = (nameKey: unknown, displayName: unknown, actorRole = 'organization_admin') =>
  setRoomName({ organizationId: 'org-1', actorAccountId: 'acct-admin', actorRole: actorRole as never, nameKey, displayName });

test('the read asks for the caller\'s gym only', async () => {
  mockQuery.mockResolvedValue([{ name_key: 'place:front-desk', display_name: 'Lobby' }]);
  const names = await readRoomNames('org-1');
  expect(mockQuery.mock.calls[0][1]).toEqual(['org-1']);
  expect(mockQuery.mock.calls[0][0]).toMatch(/where organization_id = \$1/);
  expect(names['place:front-desk']).toEqual({ name: 'Lobby', is_default: false });
  expect(names['place:floor']).toEqual({ name: 'The Floor', is_default: true });
});

test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
  'a %s cannot rename or reset, and nothing is opened',
  async (role) => {
    await expect(set('place:front-desk', 'Lobby', role)).rejects.toMatchObject({ status: 403 });
    await expect(set('place:front-desk', null, role)).rejects.toMatchObject({ status: 403 });
    expect(mockWithTransaction).not.toHaveBeenCalled();
  },
);

test('the role is checked before the key and the name: a coach sending a key off the list is refused for the role (403)', async () => {
  await expect(set('place:lobby', 'x'.repeat(99), 'coach')).rejects.toMatchObject({ status: 403 });
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

test.each([
  ['a key off the list', 'place:lobby', 'Lobby'],
  ['a key that is not text', 7, 'Lobby'],
  ['a name over 40 characters', 'place:front-desk', 'x'.repeat(41)],
  ['a line break', 'place:front-desk', 'Front\nDesk'],
  ['a name that is not text', 'place:front-desk', 42],
])('%s is refused (400) before anything is opened', async (_label, key, name) => {
  await expect(set(key, name)).rejects.toMatchObject({ status: 400 });
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'admin'])('the gym admin (%s) renames: the gym row is locked first, then one upsert and one audit row on the same client', async (role) => {
  const calls = recordingClient([{ name_key: 'place:front-desk', display_name: 'Lobby' }]);

  const names = await set('place:front-desk', '  Reception ', role);
  expect(names['place:front-desk']).toEqual({ name: 'Reception', is_default: false });

  expect(calls).toHaveLength(4);
  expect(calls[0][0]).toMatch(/from pilot\.organizations where organization_id = \$1 for no key update/);
  expect(calls[0][1]).toEqual(['org-1']);
  expect(calls[1][0]).toMatch(/from pilot\.organization_room_names\s+where organization_id = \$1 for update/);
  const upsert = calls.find(([text]) => /insert into pilot\.organization_room_names/.test(text));
  expect(upsert?.[0]).toMatch(/on conflict \(organization_id, name_key\) do update/);
  expect(upsert?.[1]).toEqual(['org-1', 'place:front-desk', 'Reception', 'acct-admin']);
  expect(calls.some(([text]) => /delete from/i.test(text))).toBe(false);
  // The gym's words for its rooms, not a person's record: nothing is mirrored to SHADOW.
  expect(calls.map(([text]) => text).filter((text) => /shadow/i.test(text))).toEqual([]);
  const audit = calls.find(([text]) => /insert into pilot\.audit_events/.test(text));
  expect(audit?.[1]).toEqual([
    'update', 'acct-admin', role, 'org-1', 'organization_room_name', 'org-1:place:front-desk',
    JSON.stringify({ name_key: 'place:front-desk', display_name: 'Reception', previous_display_name: 'Lobby' }),
  ]);
});

test('"Use the default" deletes the row for that key only, audits it, and reads back as the default', async () => {
  const calls = recordingClient([{ name_key: 'card:my-corner', display_name: 'My Space' }]);

  const names = await set('card:my-corner', null);
  expect(names['card:my-corner']).toEqual({ name: 'My Corner', is_default: true });

  expect(calls).toHaveLength(4);
  const del = calls.find(([text]) => /delete from pilot\.organization_room_names where organization_id = \$1 and name_key = \$2/.test(text));
  expect(del?.[1]).toEqual(['org-1', 'card:my-corner']);
  expect(calls.some(([text]) => /insert into pilot\.organization_room_names/.test(text))).toBe(false);
  const audit = calls.find(([text]) => /insert into pilot\.audit_events/.test(text));
  expect(audit?.[1]).toEqual([
    'update', 'acct-admin', 'organization_admin', 'org-1', 'organization_room_name', 'org-1:card:my-corner',
    JSON.stringify({ name_key: 'card:my-corner', display_name: null, previous_display_name: 'My Space' }),
  ]);
});

test.each([
  ['another room\'s default', [], 'place:front-desk', 'The Floor', 'The Floor'],
  ['the same words with two spaces', [{ name_key: 'place:floor', display_name: 'The Ring' }], 'place:front-desk', 'The  Ring', 'The Floor'],
  ['the same words with a non-breaking space', [{ name_key: 'place:floor', display_name: 'The Ring' }], 'place:front-desk', 'The\u00a0Ring', 'The Floor'],
  ['the same words with a zero-width space', [{ name_key: 'place:floor', display_name: 'The Ring' }], 'place:front-desk', 'The Ring\u200b', 'The Floor'],
  ['the same words in other case', [{ name_key: 'card:your-entry', display_name: 'Entry' }], 'card:coach-entry', 'ENTRY', 'Your entry'],
  ['a default taken back while another room holds it', [{ name_key: 'place:front-desk', display_name: 'The Floor' }, { name_key: 'place:floor', display_name: 'The Ring' }], 'place:floor', null, 'Front Desk'],
])('Q-B A: %s is refused (409) after the lock and before any write, naming the holder by its default', async (_label, stored, key, name, holderDefault) => {
  const calls = recordingClient(stored as Stored[]);
  const refusal = set(key, name);
  await expect(refusal).rejects.toMatchObject({ status: 409, code: 'ROOM_NAME_TAKEN' });
  await expect(refusal).rejects.toThrow(`(the one that is "${holderDefault}" by default)`);
  expect(calls).toHaveLength(2);
  expect(calls[0][0]).toMatch(/for no key update/);
  expect(calls.some(([text]) => /insert into|delete from/i.test(text))).toBe(false);
});

test('a name another list shows is not a clash, and neither is a room\'s own current name', async () => {
  recordingClient([{ name_key: 'place:front-desk', display_name: 'Lobby' }]);
  await expect(set('room:office', 'The Floor')).resolves.toBeDefined();
  recordingClient([{ name_key: 'place:front-desk', display_name: 'Lobby' }]);
  await expect(set('place:front-desk', 'lobby')).resolves.toBeDefined();
});
