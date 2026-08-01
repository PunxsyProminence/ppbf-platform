import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import { createFeedbackSubmission } from '@/src/server/pilot/feedback';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/feedback', () => ({
  ...jest.requireActual('@/src/server/pilot/feedback'),
  createFeedbackSubmission: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockCreate = createFeedbackSubmission as jest.MockedFunction<typeof createFeedbackSubmission>;

const DISCLOSURE = 'someone at the gym keeps hurting me and im scared to come back';

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token-1',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/feedback/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ submission_id: 'sub-1', route: 'product' });
});

describe('POST /api/pilot/feedback/submit', () => {
  test('rejects an unauthenticated caller', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const res = await POST(request({ kind: 'bug', body: 'the page is broken' }));

    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Athletes sign in with a PIN. A comment box that only accepted Microsoft
  // sessions would be closed to every child on the platform.
  test('accepts an athlete on a PIN session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ kind: 'other', body: DISCLOSURE }));

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-athlete', role: 'athlete' }),
    );
  });

  test('takes the gym, the account and the capacity from the session, never the request', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(
      request({
        kind: 'bug',
        body: 'the schedule is wrong',
        organization_id: 'org-2',
        submitted_by_account_id: 'acct-someone-else',
        submitted_by_role: 'coach',
        route: 'product',
      }),
    );

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'acct-athlete',
      role: 'athlete',
      kind: 'bug',
      body: 'the schedule is wrong',
    });
  });

  test('a caller cannot choose the route by asking for one', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'acct-coach' }));

    await POST(request({ kind: 'bug', body: 'the schedule is wrong', route: 'safeguarding' }));

    expect(mockCreate).toHaveBeenCalledWith(expect.not.objectContaining({ route: expect.anything() }));
  });

  test('an empty or whitespace-only submission is refused rather than stored', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    const blank = await POST(request({ kind: 'bug', body: '   \n  ' }));
    expect(blank.status).toBe(400);

    mockResolvePrincipal.mockResolvedValueOnce(principal());
    const missing = await POST(request({ kind: 'bug' }));
    expect(missing.status).toBe(400);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('refuses a kind the database would reject', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ kind: 'feature-request', body: 'add a timer' }));

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('refuses a body longer than the column is meant to carry', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(request({ kind: 'other', body: 'x'.repeat(4001) }));

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // The whole point of the split: the child is told plainly that a person will
  // read it, and is told nothing about a queue, a flag or a classification.
  test('tells a child a person will read it, without telling them why', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ submission_id: 'sub-9', route: 'safeguarding' });

    const res = await POST(request({ kind: 'other', body: DISCLOSURE }));
    const payload = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(String(payload.acknowledgement)).toContain('A person at the gym reads this');

    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain('safeguard');
    expect(serialized).not.toContain('flag');
    expect(payload).not.toHaveProperty('route');
    expect(payload).not.toHaveProperty('submission_id');
  });

  // The response must be byte-identical whichever way the submission was
  // routed. A confirmation that differs is a classifier anyone can probe by
  // submitting throwaway text -- including an adult a child might be
  // disclosing about, sitting beside them while they type.
  test('the reply to a disclosure is identical to the reply to a bug report', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ submission_id: 'sub-1', route: 'safeguarding' });
    const disclosure = await (await POST(request({ kind: 'other', body: DISCLOSURE }))).json();

    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ submission_id: 'sub-2', route: 'product' });
    const bugReport = await (await POST(request({ kind: 'bug', body: 'the schedule page is confusing' }))).json();

    expect(disclosure).toEqual(bugReport);
  });

  test('a product submission gets the same promise and the same shape', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ submission_id: 'sub-10', route: 'product' });

    const res = await POST(request({ kind: 'idea', body: 'add a water break timer' }));
    const payload = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(['acknowledgement', 'ok']);
    expect(String(payload.acknowledgement)).toContain('A person at the gym reads');
  });
});
