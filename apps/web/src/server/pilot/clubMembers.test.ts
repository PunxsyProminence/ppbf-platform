import { insertClubMemberIfAbsent, isClubMembershipType } from './clubMembers';
import { query } from './db';

jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
});

describe('insertClubMemberIfAbsent', () => {
  const payload = {
    member_id: 'mbr-1',
    athlete_id: null,
    full_name: 'Jason Neale',
    membership_type: 'non_athlete' as const,
    address_line1: '1 Main St',
    city: 'Punxsutawney',
    state: 'PA',
    postal_code: '15767',
    created_by_account_id: 'admin-1',
  };

  it('returns true when the insert lands a row', async () => {
    mockQuery.mockResolvedValue([{ member_id: 'mbr-1' }]);

    const created = await insertClubMemberIfAbsent('org-1', payload);

    expect(created).toBe(true);
  });

  // The create-only property: `on conflict do nothing` means a row that
  // already exists returns zero rows, never an overwrite.
  it('returns false without raising when the member id already exists', async () => {
    mockQuery.mockResolvedValue([]);

    const created = await insertClubMemberIfAbsent('org-1', payload);

    expect(created).toBe(false);
  });

  it('scopes the insert to the caller organization and passes every field through', async () => {
    mockQuery.mockResolvedValue([{ member_id: 'mbr-1' }]);

    await insertClubMemberIfAbsent('org-1', payload);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('pilot.club_members');
    expect(sql).toContain('on conflict (organization_id, member_id) do nothing');
    expect(params).toEqual([
      'org-1',
      'mbr-1',
      null,
      'Jason Neale',
      'non_athlete',
      '1 Main St',
      'Punxsutawney',
      'PA',
      '15767',
      'admin-1',
    ]);
  });

  it('passes a null full_name through untouched for an athlete-linked row', async () => {
    mockQuery.mockResolvedValue([{ member_id: 'ath-1' }]);

    await insertClubMemberIfAbsent('org-1', {
      ...payload,
      member_id: 'ath-1',
      athlete_id: 'ath-1',
      full_name: null,
      membership_type: 'athlete',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([
      'org-1',
      'ath-1',
      'ath-1',
      null,
      'athlete',
      '1 Main St',
      'Punxsutawney',
      'PA',
      '15767',
      'admin-1',
    ]);
  });
});

describe('isClubMembershipType', () => {
  it('accepts the four known values', () => {
    expect(isClubMembershipType('athlete')).toBe(true);
    expect(isClubMembershipType('non_athlete')).toBe(true);
    expect(isClubMembershipType('junior_fitness_non_contact')).toBe(true);
    expect(isClubMembershipType('adult_fitness_non_contact')).toBe(true);
  });

  it('rejects anything else, including the raw CSV spelling', () => {
    expect(isClubMembershipType('Non-Athlete')).toBe(false);
    expect(isClubMembershipType('board_member')).toBe(false);
    expect(isClubMembershipType(42)).toBe(false);
  });
});
