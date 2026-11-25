import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_STOPPED_COMING_GAP_DAYS,
  isStoppedComingGapDays,
  readStoppedComingPolicy,
  setStoppedComingPolicy,
  STOPPED_COMING_GAP_DAYS,
} from './stoppedComingPolicy';
import { queryOne, withTransaction } from './db';

/*
 * The gym's "who has stopped coming" number of days (lane W4-6, SC-0a;
 * OW27-30 A; Overwatch's W4-6 answers Q1 A and Q6 A). The database half is
 * stoppedComingPolicy.pg.test.ts. These pin the default, the fixed list (the
 * same list in the module, the migration's CHECK and the runner's readiness
 * check), "Use the default", and that only the gym admin writes.
 */

jest.mock('./db', () => ({ queryOne: jest.fn(), withTransaction: jest.fn() }));

const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

beforeEach(() => jest.clearAllMocks());

test('the default is 14 days, Jason\'s "first value 2 weeks"', () => {
  expect(DEFAULT_STOPPED_COMING_GAP_DAYS).toBe(14);
  expect(STOPPED_COMING_GAP_DAYS).toContain(DEFAULT_STOPPED_COMING_GAP_DAYS);
});

test('the module, the migration CHECK and the runner hold one list: 1, 2, 3, 4, 6 or 8 weeks', () => {
  const list = STOPPED_COMING_GAP_DAYS.join(', ');
  expect(list).toBe('7, 14, 21, 28, 42, 56');
  expect(read('infra/azure/pilot_slice_postgres_organization_stopped_coming_policy_migration.sql'))
    .toContain(`check (gap_days in (${list}))`);
  expect(read('apps/web/scripts/pilot-apply-organization-stopped-coming-policy-migration.mjs'))
    .toContain(`ARRAY[${list}]`);
});

test.each([[7, true], [14, true], [56, true], [0, false], [1, false], [30, false], [90, false], ['14', false], [null, false], [14.5, false]])(
  'isStoppedComingGapDays(%p) is %p',
  (value, expected) => {
    expect(isStoppedComingGapDays(value)).toBe(expected);
  },
);

test('no row reads as the default, and says so', async () => {
  mockQueryOne.mockResolvedValue(null);
  await expect(readStoppedComingPolicy('org-1')).resolves.toEqual({ gap_days: 14, is_default: true });
  expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1']);
});

test('a stored value is read as set by the gym admin', async () => {
  mockQueryOne.mockResolvedValue({ gap_days: 28 });
  await expect(readStoppedComingPolicy('org-1')).resolves.toEqual({ gap_days: 28, is_default: false });
});

test('a stored value off the list fails loudly instead of guessing whom to list', async () => {
  mockQueryOne.mockResolvedValue({ gap_days: 3 });
  await expect(readStoppedComingPolicy('org-1')).rejects.toThrow('STOPPED_COMING_POLICY_INVALID_STORED_VALUE');
});

test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'] as const)(
  'a %s cannot set it, and nothing is written',
  async (role) => {
    await expect(setStoppedComingPolicy({ organizationId: 'org-1', actorAccountId: 'a', actorRole: role, gapDays: 21 }))
      .rejects.toMatchObject({ status: 403 });
    await expect(setStoppedComingPolicy({ organizationId: 'org-1', actorAccountId: 'a', actorRole: role, gapDays: null }))
      .rejects.toMatchObject({ status: 403 });
    expect(mockWithTransaction).not.toHaveBeenCalled();
  },
);

test.each([0, 30, '14', undefined, 14.5])('a value off the list (%p) is refused before anything is written', async (gapDays) => {
  await expect(setStoppedComingPolicy({ organizationId: 'org-1', actorAccountId: 'a', actorRole: 'organization_admin', gapDays }))
    .rejects.toMatchObject({ status: 400 });
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

function recordingClient(stored: number | null) {
  const calls: Array<[string, unknown[]]> = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[]) => {
      calls.push([text, values]);
      return { rows: /^\s*select gap_days/i.test(text) && stored !== null ? [{ gap_days: stored }] : [] };
    }),
  };
  mockWithTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  return calls;
}

test('the gym admin\'s write upserts the row and audits old and new in the same transaction', async () => {
  const calls = recordingClient(14);

  await expect(setStoppedComingPolicy({ organizationId: 'org-1', actorAccountId: 'acct-admin', actorRole: 'organization_admin', gapDays: 21 }))
    .resolves.toEqual({ gap_days: 21, is_default: false });

  expect(calls).toHaveLength(4);
  expect(calls[0][0]).toMatch(/from pilot\.organizations where organization_id = \$1 for no key update/);
  expect(calls[0][1]).toEqual(['org-1']);
  const upsert = calls.find(([text]) => /insert into pilot\.organization_stopped_coming_policy/.test(text));
  expect(upsert?.[1]).toEqual(['org-1', 21, 'acct-admin']);
  expect(calls.some(([text]) => /delete from/i.test(text))).toBe(false);
  // A gym setting, not a person's record: nothing is mirrored to SHADOW.
  expect(calls.map(([text]) => text).filter((text) => /shadow/i.test(text))).toEqual([]);
  const audit = calls.find(([text]) => /insert into pilot\.audit_events/.test(text));
  expect(audit?.[1]).toEqual([
    'update', 'acct-admin', 'organization_admin', 'org-1', 'organization_stopped_coming_policy', 'org-1',
    JSON.stringify({ gap_days: 21, previous_gap_days: 14 }),
  ]);
});

test('"Use the default" (null) deletes the row, audits it, and reads back as the default', async () => {
  const calls = recordingClient(42);

  await expect(setStoppedComingPolicy({ organizationId: 'org-1', actorAccountId: 'acct-admin', actorRole: 'admin', gapDays: null }))
    .resolves.toEqual({ gap_days: 14, is_default: true });

  expect(calls).toHaveLength(4);
  const del = calls.find(([text]) => /delete from pilot\.organization_stopped_coming_policy where organization_id = \$1/.test(text));
  expect(del?.[1]).toEqual(['org-1']);
  expect(calls.some(([text]) => /insert into pilot\.organization_stopped_coming_policy/.test(text))).toBe(false);
  const audit = calls.find(([text]) => /insert into pilot\.audit_events/.test(text));
  expect(audit?.[1]).toEqual([
    'update', 'acct-admin', 'admin', 'org-1', 'organization_stopped_coming_policy', 'org-1',
    JSON.stringify({ gap_days: null, previous_gap_days: 42 }),
  ]);
});
