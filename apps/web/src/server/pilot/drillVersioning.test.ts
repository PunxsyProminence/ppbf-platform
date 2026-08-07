jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

jest.mock('./shadowLibrary', () => ({
  requireEvidenceReviewer: jest.fn(),
}));

import {
  adoptDrillChangeProposal,
  declineDrillChangeProposal,
  getDrillLineage,
  listDrillChangeProposals,
  proposeDrillChange,
} from './drillVersioning';
import { query, queryOne, withTransaction } from './db';
import { requireEvidenceReviewer } from './shadowLibrary';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
const mockRequireEvidenceReviewer = requireEvidenceReviewer as jest.Mock;

function drillRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: 'drill-1',
    name: 'Straight Jab Retraction Snap',
    category: 'Striking',
    focus: 'Quick fist return to protect the chin.',
    cues: ['Elbow tucked'],
    difficulty: 'intermediate',
    active: true,
    version: 1,
    lineage_id: 'drill-1',
    supersedes_drill_id: null,
    superseded_at: null,
    superseded_by_drill_id: null,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: 'propchg-1',
    organization_id: 'org-1',
    lineage_id: 'drill-1',
    based_on_drill_id: 'drill-1',
    proposed_by_account_id: 'acct-coach-1',
    proposed_by_role: 'coach',
    rationale: 'Athletes keep dropping the guard on the retraction.',
    proposed_change: { cues: ['Elbow tucked', 'Snap on contact'] },
    observation_note_ids: [],
    review_state: 'proposed',
    reviewed_by_account_id: null,
    reviewed_at: null,
    review_note: null,
    resulting_drill_id: null,
    created_at: '2026-08-01T12:00:00.000Z',
    updated_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

// A fake pg PoolClient: withTransaction is mocked to hand the callback this
// object, and each test queues up the .rows sequence adoptDrillChangeProposal
// reads in order (proposal select, lineage select, insert, update-old,
// update-proposal).
function fakeClient(...responses: Array<Array<Record<string, unknown>>>) {
  const clientQuery = jest.fn();
  for (const rows of responses) {
    clientQuery.mockResolvedValueOnce({ rows });
  }
  return { query: clientQuery };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('proposeDrillChange', () => {
  test('throws when the base drill does not exist in this organization', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(
      proposeDrillChange({
        organizationId: 'org-1',
        basedOnDrillId: 'drill-missing',
        proposedByAccountId: 'acct-coach-1',
        proposedByRole: 'coach',
        rationale: 'Athletes keep dropping the guard.',
      }),
    ).rejects.toThrow('DRILL_NOT_FOUND');
  });

  test('refuses an empty rationale before ever inserting', async () => {
    mockQueryOne.mockResolvedValueOnce(drillRow());

    await expect(
      proposeDrillChange({
        organizationId: 'org-1',
        basedOnDrillId: 'drill-1',
        proposedByAccountId: 'acct-coach-1',
        proposedByRole: 'coach',
        rationale: '   ',
      }),
    ).rejects.toThrow(/rationale/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('inherits the base drill lineage_id, not its own generated id', async () => {
    mockQueryOne
      .mockResolvedValueOnce(drillRow({ lineage_id: 'lineage-original' }))
      .mockResolvedValueOnce(proposalRow({ lineage_id: 'lineage-original' }));
    mockQuery.mockResolvedValueOnce([proposalRow({ lineage_id: 'lineage-original' })]);

    await proposeDrillChange({
      organizationId: 'org-1',
      basedOnDrillId: 'drill-1',
      proposedByAccountId: 'acct-coach-1',
      proposedByRole: 'coach',
      rationale: 'Athletes keep dropping the guard.',
      observationNoteIds: ['00000000-0000-0000-0000-000000000001'],
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe('lineage-original');
    expect(params[3]).toBe('drill-1');
  });
});

describe('listDrillChangeProposals', () => {
  test('passes null filters through untouched rather than empty strings', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listDrillChangeProposals('org-1');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', null, null]);
  });

  test('filters by review state and lineage when the caller asks', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await listDrillChangeProposals('org-1', { reviewState: 'proposed', lineageId: 'lineage-1' });

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'proposed', 'lineage-1']);
  });
});

describe('getDrillLineage', () => {
  test('reads every version of one lineage in ascending order', async () => {
    mockQuery.mockResolvedValueOnce([drillRow({ version: 1 }), drillRow({ version: 2 })]);

    await getDrillLineage('org-1', 'lineage-1');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('order by version asc');
    expect(params).toEqual(['org-1', 'lineage-1']);
  });
});

describe('adoptDrillChangeProposal', () => {
  test('enforces the reviewer gate before touching the database', async () => {
    mockRequireEvidenceReviewer.mockImplementationOnce(() => {
      throw new Error('Forbidden: SHADOW evidence review requires an organization administrator');
    });

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-coach-1',
        reviewedByRole: 'coach',
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('inserts v2 from the merged proposed_change, deactivates v1, and marks the proposal adopted', async () => {
    const proposal = proposalRow();
    const current = drillRow();
    const newVersion = drillRow({
      drill_id: 'drill-2',
      version: 2,
      supersedes_drill_id: 'drill-1',
      cues: ['Elbow tucked', 'Snap on contact'],
    });
    const adoptedProposal = proposalRow({ review_state: 'adopted', resulting_drill_id: 'drill-2' });

    const client = fakeClient([proposal], [current], [newVersion], [], [adoptedProposal]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    const result = await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    expect(mockRequireEvidenceReviewer).toHaveBeenCalledWith('organization_admin');
    expect(result.newDrillVersion.version).toBe(2);
    expect(result.proposal.review_state).toBe('adopted');

    const insertCall = client.query.mock.calls[2];
    expect(insertCall[0]).toContain('insert into pilot.drills');
    expect(insertCall[1]).toEqual([
      'org-1',
      expect.any(String),
      current.name,
      current.category,
      current.focus,
      ['Elbow tucked', 'Snap on contact'],
      current.difficulty,
      current.version + 1,
      current.lineage_id,
      current.drill_id,
    ]);
  });

  test('refuses to adopt a proposal that no longer exists', async () => {
    const client = fakeClient([]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-missing',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_NOT_FOUND');
  });

  test('refuses to re-adopt a proposal that already has an outcome', async () => {
    const client = fakeClient([proposalRow({ review_state: 'declined' })]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_ALREADY_DECLINED');
  });

  test('refuses when the lineage the proposal targets has no drill at all', async () => {
    const client = fakeClient([proposalRow()], []);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toThrow('DRILL_LINEAGE_NOT_FOUND');
  });

  // A different proposal on the same lineage was adopted first, so the
  // current latest version no longer matches what this proposal was written
  // against. Applying it anyway could silently discard the intervening
  // change, so it is refused rather than guessed at.
  test('refuses a proposal whose base version has been superseded since it was written', async () => {
    const proposal = proposalRow({ based_on_drill_id: 'drill-1' });
    const current = drillRow({ drill_id: 'drill-2', version: 2 });
    const client = fakeClient([proposal], [current]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
  });

  test('proposed_change keys outside the editable set are silently ignored', async () => {
    const proposal = proposalRow({ proposed_change: { name: 'New Name', active: false, version: 99 } });
    const current = drillRow();
    const newVersion = drillRow({ drill_id: 'drill-2', version: 2, name: 'New Name' });
    const client = fakeClient([proposal], [current], [newVersion], [], [proposalRow({ review_state: 'adopted' })]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    const insertCall = client.query.mock.calls[2];
    // active is always true (position 6) and version is always current+1
    // (position 7), regardless of what proposed_change tried to set them to.
    expect(insertCall[1][2]).toBe('New Name');
    expect(insertCall[1][7]).toBe(current.version + 1);
  });
});

describe('declineDrillChangeProposal', () => {
  test('requires a non-empty review note before touching the database', async () => {
    await expect(
      declineDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
        reviewNote: '   ',
      }),
    ).rejects.toThrow(/review note/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('enforces the same reviewer gate as adopt', async () => {
    mockRequireEvidenceReviewer.mockImplementationOnce(() => {
      throw new Error('Forbidden: SHADOW evidence review requires an organization administrator');
    });

    await expect(
      declineDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-coach-1',
        reviewedByRole: 'coach',
        reviewNote: 'Not the direction we want.',
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('reports a miss when the proposal is gone or already decided, rather than a silent success', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(
      declineDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
        reviewNote: 'Not the direction we want.',
      }),
    ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_NOT_FOUND_OR_ALREADY_DECIDED');
  });

  test('declining stamps the reviewer, timestamp and note', async () => {
    mockQueryOne.mockResolvedValueOnce(
      proposalRow({ review_state: 'declined', review_note: 'Not the direction we want.' }),
    );

    const result = await declineDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
      reviewNote: 'Not the direction we want.',
    });

    expect(result.review_state).toBe('declined');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("review_state in ('proposed', 'under_review')");
    expect(params).toEqual(['org-1', 'propchg-1', 'acct-admin-1', 'Not the direction we want.']);
  });
});
