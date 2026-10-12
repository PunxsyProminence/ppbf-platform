jest.mock('./db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

jest.mock('./shadowLibrary', () => ({
  requireEvidenceReviewer: jest.fn(),
}));

jest.mock('./audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

import {
  adoptDrillChangeProposal,
  declineDrillChangeProposal,
  getDrillLineage,
  listDrillChangeProposals,
  proposeDrillChange,
  reinstateDrillVersion,
} from './drillVersioning';
import { writePilotAuditEvent } from './audit';
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
    reference_drill_id: null,
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
    mockQueryOne.mockResolvedValueOnce({ lineage_id: 'drill-1', lineage_active: true });

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
    // The INSERT ... RETURNING goes through queryOne (it always returns
    // zero-or-one row), not query -- proposeDrillChange calls queryOne
    // twice: once for the base drill lookup, once for the insert.
    mockQueryOne
      .mockResolvedValueOnce({ lineage_id: 'lineage-original', lineage_active: true })
      .mockResolvedValueOnce(proposalRow({ lineage_id: 'lineage-original' }));

    await proposeDrillChange({
      organizationId: 'org-1',
      basedOnDrillId: 'drill-1',
      proposedByAccountId: 'acct-coach-1',
      proposedByRole: 'coach',
      rationale: 'Athletes keep dropping the guard.',
      observationNoteIds: ['00000000-0000-0000-0000-000000000001'],
    });

    const [, params] = mockQueryOne.mock.calls[1];
    expect(params[2]).toBe('lineage-original');
    expect(params[3]).toBe('drill-1');
  });

  // OD-2026-10-08-008 D3. Retired = no version of the drill's lineage is in
  // use. The base read answers that in the same statement, so the refusal
  // costs no second query and happens before the insert.
  test('refuses a retired drill in plain words, before ever inserting', async () => {
    mockQueryOne.mockResolvedValueOnce({ lineage_id: 'drill-1', lineage_active: false });

    await expect(
      proposeDrillChange({
        organizationId: 'org-1',
        basedOnDrillId: 'drill-1',
        proposedByAccountId: 'acct-coach-1',
        proposedByRole: 'coach',
        rationale: 'Athletes keep dropping the guard.',
      }),
    ).rejects.toMatchObject({
      message: 'This drill is retired, so a change cannot be proposed for it. Restore the drill first.',
      code: 'DRILL_RETIRED',
      status: 409,
    });

    // The base read, and nothing after it.
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'drill-1']);
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

    // 6 statements in order: select proposal, select current lineage row,
    // deactivate v1 (no RETURNING), insert v2, restamp v1's
    // superseded_by_drill_id (no RETURNING), update the proposal.
    const client = fakeClient([proposal], [current], [], [newVersion], [], [adoptedProposal]);
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

    const insertCall = client.query.mock.calls[3];
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
      // Provenance travels with the lineage: a hand-authored drill carries null
      // and keeps carrying it. See the promoted case below.
      current.reference_drill_id,
    ]);
  });

  // OD-2026-09-16-001: a refinement is a new VERSION of the gym's own drill, and
  // the reference drill it was promoted from does not change when a coach
  // sharpens the wording. So the pointer is inherited, never re-derived and
  // never re-pointed at a newer reference version.
  test('a refinement of a promoted drill keeps the exact reference pointer it inherited', async () => {
    const current = drillRow({ reference_drill_id: 'drl_reference_1' });
    const newVersion = drillRow({
      drill_id: 'drill-2',
      version: 2,
      supersedes_drill_id: 'drill-1',
      reference_drill_id: 'drl_reference_1',
    });
    const client = fakeClient(
      [proposalRow()],
      [current],
      [],
      [newVersion],
      [],
      [proposalRow({ review_state: 'adopted', resulting_drill_id: 'drill-2' })],
    );
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    const result = await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    const insertCall = client.query.mock.calls[3];
    expect(insertCall[1]).toContain('drl_reference_1');
    expect(insertCall[1][insertCall[1].length - 1]).toBe('drl_reference_1');
    expect(result.newDrillVersion.reference_drill_id).toBe('drl_reference_1');
  });

  test('a refinement of a hand-authored drill stays unpromoted', async () => {
    const current = drillRow({ reference_drill_id: null });
    const client = fakeClient(
      [proposalRow()],
      [current],
      [],
      [drillRow({ drill_id: 'drill-2', version: 2, supersedes_drill_id: 'drill-1' })],
      [],
      [proposalRow({ review_state: 'adopted', resulting_drill_id: 'drill-2' })],
    );
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    const insertCall = client.query.mock.calls[3];
    expect(insertCall[1][insertCall[1].length - 1]).toBeNull();
  });

  test('a proposed_change cannot rewrite provenance', async () => {
    // reference_drill_id is not a content field. A proposal naming it is ignored
    // the same way one naming `active` or `version` is: adoption may change what
    // the drill SAYS, never which reference drill it came from.
    const current = drillRow({ reference_drill_id: 'drl_reference_1' });
    const client = fakeClient(
      [
        proposalRow({
          proposed_change: { focus: 'Sharper return', reference_drill_id: 'drl_somebody_elses' },
        }),
      ],
      [current],
      [],
      [drillRow({ drill_id: 'drill-2', version: 2, supersedes_drill_id: 'drill-1', reference_drill_id: 'drl_reference_1' })],
      [],
      [proposalRow({ review_state: 'adopted', resulting_drill_id: 'drill-2' })],
    );
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    const insertCall = client.query.mock.calls[3];
    expect(insertCall[1]).not.toContain('drl_somebody_elses');
    expect(insertCall[1][insertCall[1].length - 1]).toBe('drl_reference_1');
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

  // The `for update` lock on the lineage's current-latest-version row does
  // not guarantee a clean staleness refusal under genuine concurrency: a
  // second transaction blocked on that row can be handed back the SAME
  // physical row (now superseded) once the first commits, rather than a
  // freshly re-selected one -- see the comment in adoptDrillChangeProposal.
  // Its drill_id is unchanged, so the based_on_drill_id check above passes,
  // and the conflict only surfaces here, as a unique-violation on the v2
  // insert. This must be translated to the same clean error, not leaked as
  // a raw Postgres constraint violation.
  test('translates a lineage-version race lost at the insert into the same clean staleness error', async () => {
    const proposal = proposalRow();
    const current = drillRow();
    // [proposal], [current], then an empty resolved response for the
    // deactivate-v1 UPDATE that runs before the insert, before the insert
    // itself is made to reject below.
    const client = fakeClient([proposal], [current], []);
    client.query.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'pilot_drills_lineage_version_uq',
      }),
    );
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

  test('any other database failure during the insert is left alone', async () => {
    const proposal = proposalRow();
    const current = drillRow();
    const client = fakeClient([proposal], [current], []);
    client.query.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.not.toThrow('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
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

  // OD-2026-10-08-008 D3, the back door itself. The insert below always writes
  // active = true, so adopting onto a drill nobody runs would bring it back
  // without Restore's checks. Refused after the two locking reads and one
  // in-use read, before any write.
  test('refuses to adopt onto a retired drill, and writes nothing', async () => {
    const client = fakeClient([proposalRow()], [drillRow({ active: false })], []);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toMatchObject({
      message:
        'This drill is retired, so this change cannot be adopted. Restore the drill first, or decline the proposal.',
      code: 'DRILL_RETIRED',
      status: 409,
    });

    expect(client.query).toHaveBeenCalledTimes(3);
    const [inUseSql, inUseParams] = client.query.mock.calls[2];
    expect(inUseSql).not.toMatch(/insert|update/i);
    expect(inUseParams).toEqual(['org-1', 'drill-1']);
  });

  // "Written against an earlier version" invites a re-proposal against the
  // newest one, which a retired drill would then refuse. So retired is the
  // answer given, even when the proposal is stale as well.
  test('says retired, not stale, when the drill is both', async () => {
    const proposal = proposalRow({ based_on_drill_id: 'drill-1' });
    const current = drillRow({ drill_id: 'drill-2', version: 2, active: false });
    const client = fakeClient([proposal], [current], []);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toMatchObject({ code: 'DRILL_RETIRED' });
  });

  // The gate is "no version in use", not "the newest version is inactive".
  // With an earlier version still running the drill is not retired, so this
  // proposal gets the answer it got before: stale.
  test('an inactive newest version is not retired while another version is in use', async () => {
    const proposal = proposalRow({ based_on_drill_id: 'drill-1' });
    const current = drillRow({ drill_id: 'drill-2', version: 2, active: false });
    const client = fakeClient([proposal], [current], [{ in_use: 1 }]);
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

  // OD-2026-10-06-026 ruling 2, on a new version: a change that blanks the
  // cues of a technique drill is refused before anything is written.
  test('refuses a change that leaves a technique drill with no cue, and writes nothing', async () => {
    const proposal = proposalRow({ proposed_change: { cues: [] } });
    const client = fakeClient([proposal], [drillRow()]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED', status: 409 });

    // Only the two reads ran: v1 was not deactivated and no v2 was inserted.
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('a conditioning drill may lose its cues (the exemption)', async () => {
    const proposal = proposalRow({ proposed_change: { cues: [] } });
    const current = drillRow({ category: 'conditioning', cues: ['Breathe'] });
    const newVersion = drillRow({ drill_id: 'drill-2', version: 2, category: 'conditioning', cues: [] });
    const client = fakeClient([proposal], [current], [], [newVersion], [], [proposalRow({ review_state: 'adopted' })]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    const result = await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    expect(result.newDrillVersion.cues).toEqual([]);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('a change that touches neither cues nor category never consults the rule', async () => {
    const proposal = proposalRow({ proposed_change: { focus: 'Sharper return' } });
    const current = drillRow({ cues: [] });
    const newVersion = drillRow({ drill_id: 'drill-2', version: 2, cues: [], focus: 'Sharper return' });
    const client = fakeClient([proposal], [current], [], [newVersion], [], [proposalRow({ review_state: 'adopted' })]);
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await expect(
      adoptDrillChangeProposal({
        organizationId: 'org-1',
        proposalId: 'propchg-1',
        reviewedByAccountId: 'acct-admin-1',
        reviewedByRole: 'organization_admin',
      }),
    ).resolves.toBeDefined();
  });

  test('proposed_change keys outside the editable set are silently ignored', async () => {
    const proposal = proposalRow({ proposed_change: { name: 'New Name', active: false, version: 99 } });
    const current = drillRow();
    const newVersion = drillRow({ drill_id: 'drill-2', version: 2, name: 'New Name' });
    const client = fakeClient(
      [proposal], [current], [], [newVersion], [], [proposalRow({ review_state: 'adopted' })],
    );
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));

    await adoptDrillChangeProposal({
      organizationId: 'org-1',
      proposalId: 'propchg-1',
      reviewedByAccountId: 'acct-admin-1',
      reviewedByRole: 'organization_admin',
    });

    const insertCall = client.query.mock.calls[3];
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

describe('reinstateDrillVersion (#1470)', () => {
  // Statements in order: lock the lineage, read the source (with whether the
  // lineage is in use and whether its reference is withdrawn), read the head;
  // then deactivate, insert, stamp the head, and the audit row.
  const v1 = drillRow({ drill_id: 'drill-1', version: 1, active: false, cues: ['Old cue'], reference_drill_id: 'ref-1' });
  const v2 = drillRow({ drill_id: 'drill-2', version: 2, active: true, cues: ['New cue'], reference_drill_id: 'ref-2' });

  function reinstate(drillId: string, client: ReturnType<typeof fakeClient>) {
    mockWithTransaction.mockImplementationOnce((fn) => fn(client));
    return reinstateDrillVersion({
      organizationId: 'org-1',
      drillId,
      actorAccountId: 'acct-coach-1',
      actorRole: 'coach',
    });
  }

  function source(row: Record<string, unknown>, extra: { lineage_active?: boolean; reference_withdrawn?: boolean } = {}) {
    return { ...row, lineage_active: true, reference_withdrawn: false, ...extra };
  }

  test('a drill not in this gym locks nothing and is not found', async () => {
    const client = fakeClient([]);
    await expect(reinstate('drill-elsewhere', client)).rejects.toThrow('DRILL_NOT_FOUND');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]).toEqual(['org-1', 'drill-elsewhere']);
  });

  test('retired is checked before head: the newest version of a retired drill is told it is retired', async () => {
    const retiredHead = { ...v2, active: false };
    const client = fakeClient([{}], [source(retiredHead, { lineage_active: false })], [retiredHead]);

    await expect(reinstate('drill-2', client)).rejects.toMatchObject({
      message: 'This drill is retired, so an earlier version cannot be reinstated. Restore the drill first.',
      code: 'DRILL_RETIRED',
      status: 409,
    });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test('the newest version is refused, and nothing is written', async () => {
    const client = fakeClient([{}], [source(v2)], [v2]);

    await expect(reinstate('drill-2', client)).rejects.toMatchObject({
      message: 'This is already the newest version.',
      status: 409,
    });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test("a withdrawn reference is refused with Restore's own refusal, and nothing is written", async () => {
    const client = fakeClient([{}], [source(v1, { reference_withdrawn: true })], [v2]);

    await expect(reinstate('drill-1', client)).rejects.toMatchObject({
      name: 'DrillRestoreRefusedError',
      reason: 'reference_withdrawn',
    });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test('the cue rule is applied when the cues differ from the head, and refuses with nothing written', async () => {
    const cueless = { ...v1, cues: [], reference_drill_id: null };
    const client = fakeClient([{}], [source(cueless)], [v2]);

    await expect(reinstate('drill-1', client)).rejects.toMatchObject({ code: 'DRILL_CUE_REQUIRED', status: 409 });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  test('the cue rule is not applied when neither cues nor category differ from the head', async () => {
    const cuelessHead = { ...v2, cues: [], reference_drill_id: null };
    const cuelessSource = { ...v1, cues: [], reference_drill_id: null };
    const client = fakeClient([{}], [source(cuelessSource)], [cuelessHead], [], [drillRow({ drill_id: 'drill-3', version: 3 })], []);

    await expect(reinstate('drill-1', client)).resolves.toMatchObject({ drill: { drill_id: 'drill-3' } });
  });

  test("writes v(head+1) from the source's content and reference, deactivating every active version", async () => {
    const v3 = drillRow({ drill_id: 'drill-3', version: 3, cues: ['Old cue'], reference_drill_id: 'ref-1', supersedes_drill_id: 'drill-2' });
    const client = fakeClient([{}], [source(v1)], [v2], [], [v3], []);

    const result = await reinstate('drill-1', client);

    expect(result).toEqual({ drill: v3, previous: v2, source: v1 });
    const [deactivateSql, deactivateParams] = client.query.mock.calls[3];
    expect(deactivateSql).toContain('(active or drill_id = $3)');
    expect(deactivateParams).toEqual(['org-1', v2.lineage_id, 'drill-2']);
    const [insertSql, insertParams] = client.query.mock.calls[4];
    expect(insertSql).toContain('insert into pilot.drills');
    expect(insertParams).toEqual([
      'org-1', expect.any(String), v1.name, v1.category, v1.focus, ['Old cue'], v1.difficulty,
      3, v2.lineage_id, 'drill-2', 'ref-1',
    ]);
    expect(client.query.mock.calls[5][1]).toEqual(['org-1', 'drill-2', insertParams[1]]);
    expect(writePilotAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'update',
        entity_id: 'drill-3',
        details: expect.objectContaining({
          action: 'reinstate_version',
          reinstated_from_drill_id: 'drill-1',
          reinstated_from_version: 1,
          from_drill_id: 'drill-2',
        }),
      }),
      client,
    );
  });

  test('a version-number collision under a race is a clean 409, not a raw constraint error', async () => {
    const client = fakeClient([{}], [source(v1)], [v2], []);
    client.query.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'pilot_drills_lineage_version_uq',
    }));

    await expect(reinstate('drill-1', client)).rejects.toMatchObject({ code: 'DRILL_VERSION_CONFLICT', status: 409 });
  });

  test('a name clash is the name-taken error', async () => {
    const client = fakeClient([{}], [source(v1)], [v2], []);
    client.query.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'pilot_drills_one_name_per_org',
    }));

    await expect(reinstate('drill-1', client)).rejects.toMatchObject({ name: 'DrillNameTakenError' });
  });
});
