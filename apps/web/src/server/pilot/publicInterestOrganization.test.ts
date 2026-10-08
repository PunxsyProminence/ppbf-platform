// The public interest form has its own organization setting, and ONLY the form.
//
// WHY. Every signed-out surface used getPilotDefaultOrganizationId(). Production
// answers 'ppbf-default-org' there (observed 2026-10-07), while the gym's staff
// work under 'punxsy_prominence' and read enquiries under their session
// organization (public-interest/review/route.ts). So a website enquiry was
// filed where the gym's organization admin could not see it (audit ORG-01).
//
// Jason's ruling, 2026-10-07: "A" -- fix the enquiries without touching the
// wall. What the wall, the login-page notices and public floor hours read is
// NOT ruled, so this file holds two things at once: the form follows the new
// setting, and those three do not. env.ts is real here; only the database
// readers are mocked, so the organization each surface asks for is the one the
// real setting resolves.

import { NextRequest } from 'next/server';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./wallDisplayDb', () => ({ loadPublicWallBoard: jest.fn() }));
jest.mock('./announcements', () => ({ listLiveAnnouncements: jest.fn() }));
jest.mock('./floorHours', () => ({ getFloorHoursPublic: jest.fn() }));

import { GET as getPublicNotices } from '@/app/api/pilot/announcements/public/route';
import { GET as getPublicFloorHours } from '@/app/api/pilot/floor-hours/public/route';
import { GET as getWall } from '@/app/api/pilot/wall/route';

import { listLiveAnnouncements } from './announcements';
import { queryOne } from './db';
import { getPilotDefaultOrganizationId, getPublicInterestOrganizationId } from './env';
import { getFloorHoursPublic } from './floorHours';
import { createPublicInterestSubmission } from './publicInterest';
import { loadPublicWallBoard } from './wallDisplayDb';
import { resetWallBudget } from './wallRateLimit';

const mockQueryOne = jest.mocked(queryOne);
const mockLoadWallBoard = jest.mocked(loadPublicWallBoard);
const mockListLiveAnnouncements = jest.mocked(listLiveAnnouncements);
const mockGetFloorHoursPublic = jest.mocked(getFloorHoursPublic);

const DEFAULT_ORG = 'org-platform-default';
const GYM_ORG = 'org-the-gym';

const SETTINGS = ['PPBF_PILOT_DEFAULT_ORG_ID', 'PPBF_PUBLIC_INTEREST_ORG_ID'] as const;
const previous: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of SETTINGS) previous[name] = process.env[name];
});

afterAll(() => {
  for (const name of SETTINGS) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  resetWallBudget();
  process.env.PPBF_PILOT_DEFAULT_ORG_ID = DEFAULT_ORG;
  delete process.env.PPBF_PUBLIC_INTEREST_ORG_ID;
  mockQueryOne.mockResolvedValue({ submission_id: 'sub-1' });
  mockLoadWallBoard.mockResolvedValue({} as Awaited<ReturnType<typeof loadPublicWallBoard>>);
  mockListLiveAnnouncements.mockResolvedValue([]);
  mockGetFloorHoursPublic.mockResolvedValue([]);
});

async function insertedOrganization(): Promise<unknown> {
  await createPublicInterestSubmission({
    fullName: 'Jordan Visitor',
    email: 'jordan@example.com',
    visitorType: 'Parent / Guardian',
    programInterest: 'Youth Development',
    preferredContactMethod: 'Email',
    consentToContact: true,
  });
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
  const [sql, params] = mockQueryOne.mock.calls[0];
  expect(String(sql)).toContain('insert into pilot.public_interest_submissions');
  return params?.[0];
}

describe('getPublicInterestOrganizationId', () => {
  test('unset: the default organization, whatever that is configured to be', () => {
    expect(getPublicInterestOrganizationId()).toBe(DEFAULT_ORG);

    delete process.env.PPBF_PILOT_DEFAULT_ORG_ID;
    expect(getPublicInterestOrganizationId()).toBe('ppbf-default-org');
  });

  test.each(['', '   ', '\t\n'])('blank (%j) counts as unset', (blank) => {
    process.env.PPBF_PUBLIC_INTEREST_ORG_ID = blank;
    expect(getPublicInterestOrganizationId()).toBe(DEFAULT_ORG);
  });

  test('set: that organization, trimmed, and the default is left alone', () => {
    process.env.PPBF_PUBLIC_INTEREST_ORG_ID = `  ${GYM_ORG}\n`;
    expect(getPublicInterestOrganizationId()).toBe(GYM_ORG);
    expect(getPilotDefaultOrganizationId()).toBe(DEFAULT_ORG);
  });
});

describe('the interest form insert', () => {
  test('unset: files the enquiry under the default organization, as before', async () => {
    await expect(insertedOrganization()).resolves.toBe(DEFAULT_ORG);
  });

  test('set: files the enquiry under the interest-form organization', async () => {
    process.env.PPBF_PUBLIC_INTEREST_ORG_ID = GYM_ORG;
    await expect(insertedOrganization()).resolves.toBe(GYM_ORG);
  });
});

// The setting can name an organization this database does not have. Every
// enquiry then fails the foreign key. It must stay a failure -- falling back to
// the default organization is the defect this setting exists to end -- and the
// log has to say which organization, because the route's own line is a constant.
describe('an interest-form organization that does not exist', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.PPBF_PUBLIC_INTEREST_ORG_ID = GYM_ORG;
  });

  afterEach(() => {
    logged.mockRestore();
  });

  test('fails the submission, files nothing elsewhere, and names the organization in the log', async () => {
    const foreignKey = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    mockQueryOne.mockReset();
    mockQueryOne.mockRejectedValueOnce(foreignKey);

    await expect(insertedOrganization()).rejects.toBe(foreignKey);
    // One attempt. A retry under some other organization would be a second call.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls).toEqual([['public-interest-organization-unknown', { organizationId: GYM_ORG }]]);
  });

  test('any other database failure is not blamed on the organization', async () => {
    const outage = Object.assign(new Error('connection terminated'), { code: '57P01' });
    mockQueryOne.mockReset();
    mockQueryOne.mockRejectedValueOnce(outage);

    await expect(insertedOrganization()).rejects.toBe(outage);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalled();
  });
});

// Not ruled, so not moved. Each of these must keep asking for the DEFAULT
// organization while the interest-form setting points somewhere else.
describe('the other signed-out surfaces ignore the interest-form setting', () => {
  beforeEach(() => {
    process.env.PPBF_PUBLIC_INTEREST_ORG_ID = GYM_ORG;
  });

  test('the wall still reads the default organization', async () => {
    const response = await getWall(
      new NextRequest('http://localhost/api/pilot/wall', { headers: { 'x-real-ip': '10.0.0.1' } }),
    );

    expect(response.status).toBe(200);
    expect(mockLoadWallBoard).toHaveBeenCalledTimes(1);
    expect(mockLoadWallBoard.mock.calls[0][0].organizationId).toBe(DEFAULT_ORG);
  });

  test('login-page notices still read the default organization', async () => {
    const response = await getPublicNotices(new NextRequest('http://localhost/api/pilot/announcements/public'));

    expect(response.status).toBe(200);
    expect(mockListLiveAnnouncements).toHaveBeenCalledTimes(1);
    expect(mockListLiveAnnouncements.mock.calls[0][0]).toBe(DEFAULT_ORG);
    await expect(response.json()).resolves.toMatchObject({ organization_id: DEFAULT_ORG });
  });

  test('public floor hours still read the default organization', async () => {
    const response = await getPublicFloorHours(new NextRequest('http://localhost/api/pilot/floor-hours/public'));

    expect(response.status).toBe(200);
    expect(mockGetFloorHoursPublic).toHaveBeenCalledTimes(1);
    expect(mockGetFloorHoursPublic.mock.calls[0][0]).toBe(DEFAULT_ORG);
    await expect(response.json()).resolves.toMatchObject({ organization_id: DEFAULT_ORG });
  });
});
