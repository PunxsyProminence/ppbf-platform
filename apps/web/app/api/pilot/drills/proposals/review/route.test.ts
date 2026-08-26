import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  adoptDrillChangeProposal,
  declineDrillChangeProposal,
} from '@/src/server/pilot/drillVersioning';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillVersioning', () => ({
  adoptDrillChangeProposal: jest.fn(),
  declineDrillChangeProposal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAdopt = adoptDrillChangeProposal as jest.Mock;
const mockDecline = declineDrillChangeProposal as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: 'propchg_1',
    organization_id: 'org-1',
    lineage_id: 'lineage-1',
    based_on_drill_id: 'drill-1',
    review_state: 'adopted',
    resulting_drill_id: 'drill-2',
    ...overrides,
  };
}

function drillVersion(overrides: Record<string, unknown> = {}) {
  return { drill_id: 'drill-2', lineage_id: 'lineage-1', version: 2, ...overrides };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/drills/proposals/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAdopt.mockResolvedValue({ proposal: proposal(), newDrillVersion: drillVersion() });
  mockDecline.mockResolvedValue(proposal({ review_state: 'declined', resulting_drill_id: null }));
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/drills/proposals/review', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(res.status).toBe(401);
    expect(mockAdopt).not.toHaveBeenCalled();
  });

  test('requires a proposal_id', async () => {
    const res = await POST(postRequest({ action: 'adopt' }));

    expect(res.status).toBe(400);
    expect(mockAdopt).not.toHaveBeenCalled();
  });

  test('requires a recognized action', async () => {
    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'approve' }));

    expect(res.status).toBe(400);
    expect(mockAdopt).not.toHaveBeenCalled();
    expect(mockDecline).not.toHaveBeenCalled();
  });

  // The route authenticates; requireEvidenceReviewer inside the domain
  // function authorizes. What this route must not do is decide the reviewer
  // tier itself or drop the caller's real role on the way through -- either
  // would make that gate unenforceable from here.
  test('hands the caller real role to the domain gate', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', accountId: 'coach-9' }));

    await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(mockAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ reviewedByRole: 'coach', reviewedByAccountId: 'coach-9' }),
    );
  });

  test('surfaces the reviewer gate refusal as a 403', async () => {
    mockAdopt.mockRejectedValueOnce(
      new Error('Forbidden: SHADOW evidence review requires an organization administrator'),
    );

    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(res.status).toBe(403);
  });

  test('scopes the review to the caller organization', async () => {
    await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(mockAdopt).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', proposalId: 'propchg_1' }),
    );
  });

  test('adopting answers with the proposal and the new drill version', async () => {
    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      organization_id: 'org-1',
      proposal: proposal(),
      drill: drillVersion(),
    });
  });

  test('declining requires a review note', async () => {
    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'decline' }));

    expect(res.status).toBe(400);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  test('declining passes the note through', async () => {
    const res = await POST(
      postRequest({ proposal_id: 'propchg_1', action: 'decline', review_note: 'Covered by v3.' }),
    );

    expect(res.status).toBe(200);
    expect(mockDecline).toHaveBeenCalledWith(
      expect.objectContaining({ reviewNote: 'Covered by v3.' }),
    );
    expect(mockAdopt).not.toHaveBeenCalled();
  });

  // Each of these is an ALL_CAPS domain code. jsonError keys off message
  // prefixes ('Missing', 'Not found', 'Forbidden'), so an unmapped code is
  // redacted to a 500 -- telling a reviewer the server broke when what
  // actually happened is that a colleague reached the lineage first.
  test.each([
    ['DRILL_CHANGE_PROPOSAL_NOT_FOUND', 404],
    ['DRILL_LINEAGE_NOT_FOUND', 404],
    ['DRILL_CHANGE_PROPOSAL_ALREADY_ADOPTED', 409],
    ['DRILL_CHANGE_PROPOSAL_ALREADY_DECLINED', 409],
    ['DRILL_CHANGE_PROPOSAL_ALREADY_SUPERSEDED', 409],
    ['DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION', 409],
  ] as const)('maps %s to %i', async (code, status) => {
    mockAdopt.mockRejectedValueOnce(new Error(code));

    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ error: code });
  });

  test('maps the decline miss to 409 rather than asserting the proposal is gone', async () => {
    mockDecline.mockRejectedValueOnce(
      new Error('DRILL_CHANGE_PROPOSAL_NOT_FOUND_OR_ALREADY_DECIDED'),
    );

    const res = await POST(
      postRequest({ proposal_id: 'propchg_1', action: 'decline', review_note: 'No.' }),
    );

    expect(res.status).toBe(409);
  });

  // An unrecognized failure must keep its 500 and its redaction: a raw
  // database message can carry SQL or connection detail.
  test('leaves an unrecognized failure redacted', async () => {
    mockAdopt.mockRejectedValueOnce(new Error('connection to 10.0.0.4 refused'));

    const res = await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
  });

  test('audits an adoption with a verb the constraint already admits', async () => {
    await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event.event_type).toBe('update');
    expect(event.entity_type).toBe('drill_change_proposal');
    expect(event.details.resulting_drill_id).toBe('drill-2');
    expect(event.details.new_version).toBe(2);
  });

  // A rolled-back adoption must not leave an audit line claiming a version
  // that does not exist.
  test('writes no audit line when the adoption fails', async () => {
    mockAdopt.mockRejectedValueOnce(new Error('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION'));

    await POST(postRequest({ proposal_id: 'propchg_1', action: 'adopt' }));

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
