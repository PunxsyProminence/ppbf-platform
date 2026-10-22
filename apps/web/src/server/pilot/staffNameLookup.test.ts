import { STAFF_LIST_NAME_FLOOR } from '@/src/shared/staffListNames';

import { getCoachDisplayName, getStaffDisplayName } from './achievements';
import { coachNamesByAccount, staffNamesByAccount } from './staffNameLookup';

jest.mock('./achievements', () => ({
  ...jest.requireActual('./achievements'),
  getCoachDisplayName: jest.fn(),
  getStaffDisplayName: jest.fn(),
}));

const mockStaffName = getStaffDisplayName as jest.Mock;
const mockCoachName = getCoachDisplayName as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
});

describe('staffNamesByAccount', () => {
  test('one read per distinct person, in the asking organization', async () => {
    mockStaffName.mockImplementation(async (_org: string, id: string) => (id === 'a' ? 'Sam Rivera' : 'Pat Lowe'));

    const names = await staffNamesByAccount('org-1', ['a', 'b', 'a', 'b', 'a']);

    expect(mockStaffName.mock.calls).toEqual([['org-1', 'a'], ['org-1', 'b']]);
    expect([...names]).toEqual([['a', 'Sam Rivera'], ['b', 'Pat Lowe']]);
  });

  test('a person who cannot be named reads as the floor, never as the id', async () => {
    mockStaffName.mockResolvedValue(null);

    const names = await staffNamesByAccount('org-1', ['acct-secret-1']);

    expect(names.get('acct-secret-1')).toBe(STAFF_LIST_NAME_FLOOR);
  });

  test('empty, null and undefined ids are not looked up', async () => {
    const names = await staffNamesByAccount('org-1', ['', null, undefined]);

    expect(mockStaffName).not.toHaveBeenCalled();
    expect(names.size).toBe(0);
  });
});

describe('coachNamesByAccount', () => {
  test('uses the coach reader, so the title and its own floor phrase come with it', async () => {
    mockCoachName.mockImplementation(async (_org: string, id: string) => (id === 'a' ? 'Coach Rivera' : 'Your coach'));

    const names = await coachNamesByAccount('org-1', ['a', 'b', 'a']);

    expect(mockCoachName.mock.calls).toEqual([['org-1', 'a'], ['org-1', 'b']]);
    expect(mockStaffName).not.toHaveBeenCalled();
    expect([...names]).toEqual([['a', 'Coach Rivera'], ['b', 'Your coach']]);
  });
});

describe('the floor is the one the server already uses for a staff note author', () => {
  test('STAFF_LIST_NAME_FLOOR (a client page cannot import achievements.ts) equals STAFF_AUTHOR_NAME_FLOOR', () => {
    const { STAFF_AUTHOR_NAME_FLOOR } = jest.requireActual('./achievements') as { STAFF_AUTHOR_NAME_FLOOR: string };
    expect(STAFF_LIST_NAME_FLOOR).toBe(STAFF_AUTHOR_NAME_FLOOR);
  });
});
