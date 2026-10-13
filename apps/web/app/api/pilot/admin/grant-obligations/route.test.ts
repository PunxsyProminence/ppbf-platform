import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createGrantObligation,
  grantObligationsReport,
  listGrantObligations,
  updateGrantObligationStatus,
} from '@/src/server/pilot/grantObligations';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/grantObligations', () => {
  const actual = jest.requireActual('@/src/server/pilot/grantObligations');
  return {
    ...actual,
    createGrantObligation: jest.fn(),
    grantObligationsReport: jest.fn(),
    listGrantObligations: jest.fn(),
    updateGrantObligationStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createGrantObligation as jest.Mock;
const mockList = listGrantObligations as jest.Mock;
const mockUpdate = updateGrantObligationStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/admin/grant-obligations${query ? `?${query}` : ''}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/grant-obligations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/grant-obligations', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const VALID_POST = {
  grant_name: 'Community Youth Grant',
  obligation_type: 'report',
  description: 'Quarterly outcomes report.',
  due_date: '2026-10-01',
};

// Funder commitments are office records: admin-only in both directions.
describe('role gating', () => {
  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer'] as const)('%s is forbidden on every method', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(postRequest(VALID_POST))).status).toBeGreaterThanOrEqual(400);
    expect((await PATCH(patchRequest({ obligation_id: 'ob-1', status: 'complete' }))).status).toBeGreaterThanOrEqual(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an organization admin lists, org-scoped', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockList.mockResolvedValue([]);

    const payload = await (await GET(getRequest())).json();

    expect(mockList).toHaveBeenCalledWith('org-1', {});
    expect(payload.items).toEqual([]);
  });
});

describe('input validation', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
  });

  test('an unknown status filter is refused rather than passed through', async () => {
    expect((await GET(getRequest('status=someday'))).status).toBeGreaterThanOrEqual(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an unknown obligation_type is refused', async () => {
    const response = await POST(postRequest({ ...VALID_POST, obligation_type: 'party' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a malformed due date is refused', async () => {
    const response = await POST(postRequest({ ...VALID_POST, due_date: 'next fall' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a valid create is filed under the caller and their organization', async () => {
    mockCreate.mockResolvedValue({ obligation_id: 'ob-1' });

    await POST(postRequest({ ...VALID_POST, funder_name: 'Foundation X' }));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      createdByAccountId: 'acct-1',
      grantName: 'Community Youth Grant',
      funderName: 'Foundation X',
      obligationType: 'report',
      dueDate: '2026-10-01',
    }));
  });

  test('a missing obligation returns 404, and an unknown status never reaches the module', async () => {
    mockUpdate.mockResolvedValue(null);

    expect((await PATCH(patchRequest({ obligation_id: 'ob-x', status: 'complete' }))).status).toBe(404);
    expect((await PATCH(patchRequest({ obligation_id: 'ob-x', status: 'someday' }))).status).toBeGreaterThanOrEqual(400);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

/*
 * THE OBLIGATIONS REPORT AS CSV (RP-03): organization admin only, the facts
 * without notes, overdue derived by today's gym day for open work only, every
 * cell quoted and formula-guarded, a UTF-8 BOM, and refusals in sentences.
 */
describe('GET format=csv: the obligations report (RP-03)', () => {
  const mockReport = grantObligationsReport as jest.Mock;
  // 2026-10-14 03:30 UTC is 11:30 pm on 2026-10-13 in the gym.
  const GYM_LATE_EVENING = Date.parse('2026-10-14T03:30:00.000Z');

  function row(overrides: Record<string, unknown>) {
    return {
      obligation_id: 'ob-1',
      grant_name: 'Youth Grant',
      funder_name: 'Foundation X',
      obligation_type: 'report',
      description: 'Quarterly report.',
      due_date: '2026-10-12',
      status: 'open',
      completed_at: null,
      notes: 'INTERNAL NOTE',
      created_by_account_id: 'acct-1',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(GYM_LATE_EVENING);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function csvOf(query: string): Promise<{ response: Response; text: string; bytes: Uint8Array }> {
    const response = await GET(getRequest(query));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, text: new TextDecoder().decode(bytes), bytes };
  }

  test('the file: dated by the gym day, the facts, overdue for open work only, no notes', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockReport.mockResolvedValue([
      row({ obligation_id: 'ob-due-yesterday', due_date: '2026-10-12' }),
      row({ obligation_id: 'ob-due-today', due_date: '2026-10-13', description: 'Due today.' }),
      row({ obligation_id: 'ob-waived', status: 'waived', due_date: '2020-01-01', description: 'Waived long ago.', completed_at: '2026-10-01T15:00:00Z' }),
    ]);

    const { response, text, bytes } = await csvOf('format=csv&state=all&from=2020-01-01&to=2026-12-31');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // The gym's day at 11:30 pm Eastern is still the 13th, not UTC's 14th.
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="grant-obligations_all_2026-10-13.csv"');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(mockReport).toHaveBeenCalledWith('org-1', { dueFrom: '2020-01-01', dueTo: '2026-12-31', state: 'all' });
    const lines = text.split('\r\n');
    expect(lines[1]).toBe('"Grant","Funder","Type","Description","Due","Status","Settled (gym time)","Overdue"');
    // Yesterday is overdue; today is not yet; waived never is.
    expect(lines[2]).toMatch(/"2026-10-12","open","","yes"$/);
    expect(lines[3]).toMatch(/"2026-10-13","open","",""$/);
    // 15:00 UTC on October 1 is 11:00 am in the gym.
    expect(lines[4]).toMatch(/"waived","[^"]*Oct[^"]*1[^"]*2026 at 11:00\sAM",""$/);
    expect(text).not.toContain('INTERNAL NOTE');
  });

  test('overdue is open work only: in progress past due is; submitted and complete past due are not', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
    mockReport.mockResolvedValue([
      row({ obligation_id: 'ob-prog', status: 'in_progress', due_date: '2026-01-01' }),
      row({ obligation_id: 'ob-sub', status: 'submitted', due_date: '2026-01-01', completed_at: '2026-01-02T15:00:00Z' }),
      row({ obligation_id: 'ob-comp', status: 'complete', due_date: '2026-01-01', completed_at: '2026-01-02T15:00:00Z' }),
    ]);

    // No state sent: the report is all of them.
    const { response, text } = await csvOf('format=csv');

    expect(response.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith('org-1', { dueFrom: undefined, dueTo: undefined, state: 'all' });
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="grant-obligations_all_2026-10-13.csv"');
    const lines = text.split('\r\n');
    expect(lines[2]).toMatch(/"in_progress","","yes"$/);
    expect(lines[3]).toMatch(/"submitted","[^"]+",""$/);
    expect(lines[4]).toMatch(/"complete","[^"]+",""$/);
  });

  test('a cell that would run as a formula is defused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockReport.mockResolvedValue([row({ grant_name: '=HYPERLINK("x")', funder_name: '\t+Tabbed' })]);

    const { text } = await csvOf('format=csv');

    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).toContain(`"'\t+Tabbed"`);
  });

  test.each([
    ['another format', 'format=xlsx'],
    ['a state that does not exist', 'format=csv&state=overdue'],
    ['a status filter on the report', 'format=csv&status=open'],
    ['a date that is not a date', 'format=csv&from=2026-02-30'],
    ['a range that ends before it starts', 'format=csv&from=2026-10-13&to=2026-10-01'],
  ])('%s is refused with a sentence, and nothing is read', async (_label, query) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));

    const response = await GET(getRequest(query));

    expect(response.status).toBe(400);
    expect(mockReport).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner'] as const)('%s cannot download it', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    const response = await GET(getRequest('format=csv'));

    expect(response.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });
});
