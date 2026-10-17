/**
 * The gym admin's profile save (lane L31 P3): the table's rules are checked
 * first, naming the field; the save and its audit row are one transaction;
 * and the store forgets the cached row so the next page reads the new one.
 */

const mockClientQuery = jest.fn();
const mockAudit = jest.fn();
const mockForget = jest.fn();
jest.mock('./db', () => ({
  queryOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: mockClientQuery })),
}));
jest.mock('./audit', () => ({ writePilotAuditEvent: (...args: unknown[]) => mockAudit(...args) }));
jest.mock('./organizationProfileStore', () => ({ forgetOrganizationProfile: (...args: unknown[]) => mockForget(...args) }));

import { PROFILE_FIELDS, saveOrganizationProfile, validateProfileInput } from './organizationProfileWrite';

const VALID = {
  brand: 'Ridgeway Lantern Boxing & Fitness',
  short_name: 'RLBF',
  common_name: 'Ridgeway Lantern',
  website_url: 'https://www.ridgeway-lantern.example',
  domain: 'ridgeway-lantern.example',
};

beforeEach(() => {
  mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
  mockAudit.mockReset().mockResolvedValue(undefined);
  mockForget.mockReset();
});

describe('validateProfileInput', () => {
  test('every field comes back trimmed; an absent optional field is empty', () => {
    const input = validateProfileInput({ ...VALID, brand: '  Ridgeway Lantern Boxing & Fitness  ', ein: ' 12-3456789 ' });
    expect(input.brand).toBe('Ridgeway Lantern Boxing & Fitness');
    expect(input.ein).toBe('12-3456789');
    expect(input.contact_email).toBe('');
    expect(Object.keys(input).sort()).toEqual(PROFILE_FIELDS.map(([field]) => field).sort());
  });

  test.each(['brand', 'short_name', 'common_name', 'website_url', 'domain'])('%s is required', (field) => {
    expect(() => validateProfileInput({ ...VALID, [field]: '   ' })).toThrow(`${field} is required`);
  });

  test.each(PROFILE_FIELDS.map(([field, limit]) => [field, limit] as const))('%s is limited to %i characters', (field, limit) => {
    expect(() => validateProfileInput({ ...VALID, [field]: 'x'.repeat(limit + 1) })).toThrow(`${field} must be ${limit} characters or fewer`);
  });

  test.each(['punxsy.example', 'http://www.example.org', 'https://www.example.org/', 'https://www.example.org/path'])(
    'the website %s is refused',
    (website_url) => {
      expect(() => validateProfileInput({ ...VALID, website_url })).toThrow(/website_url must be an https address/);
    },
  );

  test.each(['localhost', 'https://example.org', 'example.org/x'])('the domain %s is refused', (domain) => {
    expect(() => validateProfileInput({ ...VALID, domain })).toThrow(/domain must be a bare host name/);
  });

  test('a body that is not an object, or a field that is not text, is refused', () => {
    expect(() => validateProfileInput(null)).toThrow('profile must be a JSON object');
    expect(() => validateProfileInput([VALID])).toThrow('profile must be a JSON object');
    expect(() => validateProfileInput({ ...VALID, ein: 12 })).toThrow('ein must be text');
  });
});

describe('saveOrganizationProfile', () => {
  test('upserts the session gym, audits it in the same transaction, and drops the cached row', async () => {
    const saved = await saveOrganizationProfile('gym-1', { ...VALID, contact_email: 'office@ridgeway-lantern.example' }, {
      accountId: 'admin-1',
      role: 'organization_admin',
    });
    expect(saved.contact_email).toBe('office@ridgeway-lantern.example');
    const [sql, params] = mockClientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('insert into pilot.organization_profiles');
    expect(sql).toContain('on conflict (organization_id) do update set');
    expect(params[0]).toBe('gym-1');
    expect(params).toHaveLength(PROFILE_FIELDS.length + 1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'update',
        actor_account_id: 'admin-1',
        organization_id: 'gym-1',
        entity_type: 'organization_profile',
        entity_id: 'gym-1',
      }),
      expect.objectContaining({ query: mockClientQuery }),
    );
    expect(mockForget).toHaveBeenCalledWith('gym-1');
  });

  test('an invalid profile writes nothing', async () => {
    await expect(saveOrganizationProfile('gym-1', { ...VALID, domain: '' }, { accountId: 'admin-1', role: 'organization_admin' }))
      .rejects.toThrow('domain is required');
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockForget).not.toHaveBeenCalled();
  });
});
