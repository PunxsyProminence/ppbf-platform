import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TABLET_IDLE_MINUTES,
  isTabletIdleMinutes,
  readTabletIdlePolicy,
  setTabletIdlePolicy,
  TABLET_IDLE_MINUTES,
} from './tabletIdlePolicy';
import { queryOne, withTransaction } from './db';

/*
 * The gym tablet idle time (lane U1, AS2-a; OW25-53 A). The database half is
 * tabletIdlePolicy.pg.test.ts. These pin the default, the fixed list (the same
 * list in the module, the migration's CHECK and the runner's readiness check),
 * and that only the gym admin writes.
 */

jest.mock('./db', () => ({ queryOne: jest.fn(), withTransaction: jest.fn() }));

const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

beforeEach(() => jest.clearAllMocks());

test('the default is one hour, Jason\'s first value', () => {
  expect(DEFAULT_TABLET_IDLE_MINUTES).toBe(60);
  expect(TABLET_IDLE_MINUTES).toContain(DEFAULT_TABLET_IDLE_MINUTES);
});

test('the module, the migration CHECK and the runner hold one list', () => {
  const list = TABLET_IDLE_MINUTES.join(', ');
  expect(list).toBe('15, 30, 60, 120, 240');
  expect(read('infra/azure/pilot_slice_postgres_organization_tablet_idle_policy_migration.sql'))
    .toContain(`check (idle_minutes in (${list}))`);
  expect(read('apps/web/scripts/pilot-apply-organization-tablet-idle-policy-migration.mjs'))
    .toContain(`ARRAY[${list}]`);
});

test.each([[15, true], [60, true], [240, true], [1, false], [0, false], [45, false], ['60', false], [null, false], [60.5, false]])(
  'isTabletIdleMinutes(%p) is %p',
  (value, expected) => {
    expect(isTabletIdleMinutes(value)).toBe(expected);
  },
);

test('no row reads as the default, and says so', async () => {
  mockQueryOne.mockResolvedValue(null);
  await expect(readTabletIdlePolicy('org-1')).resolves.toEqual({ idle_minutes: 60, is_default: true });
  expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1']);
});

test('a stored value is read as set by the gym admin', async () => {
  mockQueryOne.mockResolvedValue({ idle_minutes: 30 });
  await expect(readTabletIdlePolicy('org-1')).resolves.toEqual({ idle_minutes: 30, is_default: false });
});

test('a stored value off the list fails loudly instead of guessing a time', async () => {
  mockQueryOne.mockResolvedValue({ idle_minutes: 7 });
  await expect(readTabletIdlePolicy('org-1')).rejects.toThrow('TABLET_IDLE_POLICY_INVALID_STORED_VALUE');
});

test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner'] as const)('a %s cannot set it, and nothing is written', async (role) => {
  await expect(setTabletIdlePolicy({ organizationId: 'org-1', actorAccountId: 'a', actorRole: role, idleMinutes: 30 }))
    .rejects.toMatchObject({ status: 403 });
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

test('a time off the list is refused before anything is written', async () => {
  await expect(setTabletIdlePolicy({ organizationId: 'org-1', actorAccountId: 'a', actorRole: 'organization_admin', idleMinutes: 5 }))
    .rejects.toMatchObject({ status: 400 });
  expect(mockWithTransaction).not.toHaveBeenCalled();
});

test('the gym admin\'s write upserts the row and audits old and new in the same transaction', async () => {
  const calls: Array<[string, unknown[]]> = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[]) => {
      calls.push([text, values]);
      return { rows: /^\s*select/i.test(text) ? [{ idle_minutes: 60 }] : [] };
    }),
  };
  mockWithTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

  await expect(setTabletIdlePolicy({ organizationId: 'org-1', actorAccountId: 'acct-admin', actorRole: 'organization_admin', idleMinutes: 120 }))
    .resolves.toEqual({ idle_minutes: 120, is_default: false });

  const upsert = calls.find(([text]) => /insert into pilot\.organization_tablet_idle_policy/.test(text));
  expect(upsert?.[1]).toEqual(['org-1', 120, 'acct-admin']);
  const audit = calls.find(([text]) => /insert into pilot\.audit_events/.test(text));
  expect(audit?.[1]).toEqual([
    'update', 'acct-admin', 'organization_admin', 'org-1', 'organization_tablet_idle_policy', 'org-1',
    JSON.stringify({ idle_minutes: 120, previous_idle_minutes: 60 }),
  ]);
});
