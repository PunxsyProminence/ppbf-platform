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

  test('a website the URL parser cannot read is refused, though the pattern allows it', () => {
    // Every page builds the site address with `new URL`; one of these stored would take them all down.
    for (const website_url of ['https://www.example.123', 'https://1.2.3.999', 'https://999.999', 'https://xn--a.org']) {
      expect(() => validateProfileInput({ ...VALID, website_url })).toThrow(/website_url must be an https address/);
    }
  });

  test('the website is stored as the parser gives it back', () => {
    expect(validateProfileInput({ ...VALID, website_url: 'https://WWW.Ridgeway-Lantern.example' }).website_url)
      .toBe('https://www.ridgeway-lantern.example');
  });

  test('a NUL character is refused by name, not left for the database to fail on', () => {
    expect(() => validateProfileInput({ ...VALID, town: 'Ridge\u0000way' })).toThrow('town cannot contain a NUL character');
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
    // The current row is read, locked, first; then the upsert.
    expect(String(mockClientQuery.mock.calls[0][0])).toMatch(/from pilot\.organization_profiles where organization_id = \$1 for update/);
    const [sql, params] = mockClientQuery.mock.calls[1] as [string, unknown[]];
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

  test('the audit row names the fields that changed, never their values', async () => {
    const stored = validateProfileInput({ ...VALID, head_coach_name: 'Morgan Hale' });
    mockClientQuery.mockImplementation(async (sql: string) => (sql.includes('for update') ? { rows: [stored] } : { rows: [] }));
    await saveOrganizationProfile('gym-1', { ...VALID, head_coach_name: 'Morgan Hale', town: 'Ridgeway' }, {
      accountId: 'admin-1',
      role: 'organization_admin',
    });
    const [event] = mockAudit.mock.calls[0] as [{ details: Record<string, unknown> }];
    expect(event.details).toEqual({ action: 'organization_profile_saved', changed_fields: ['town'] });
    expect(JSON.stringify(event.details)).not.toContain('Morgan');
  });

  test('an invalid profile writes nothing', async () => {
    await expect(saveOrganizationProfile('gym-1', { ...VALID, domain: '' }, { accountId: 'admin-1', role: 'organization_admin' }))
      .rejects.toThrow('domain is required');
    expect(mockClientQuery).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockForget).not.toHaveBeenCalled();
  });
});
