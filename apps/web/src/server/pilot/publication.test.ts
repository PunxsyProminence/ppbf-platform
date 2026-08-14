import { query, queryOne, withTransaction } from './db';
import { decidePublicationCompliance, submitPublicationForReview } from './publication';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // publishToResearchLibrary claims the publication and writes the library row
  // in one transaction, so both statements run on a transaction client. The
  // fake returns the pg Result shape ({ rows }) that a real client returns,
  // unlike the module's query() which returns the rows array directly.
  withTransaction: jest.fn(),
}));

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;

beforeEach(() => {
  mockWithTransaction.mockImplementation(
    (work: (client: { query: jest.Mock }) => Promise<unknown>) => work({
      query: jest.fn(async (...args: unknown[]) => ({ rows: (await mockQuery(...args)) ?? [] })) as jest.Mock,
    }),
  );
  // Mirrors the real module: queryOne is query's first row, so a test can queue
  // its rows on mockQuery and assert on one call log either way.
  mockQueryOne.mockImplementation(async (...args: unknown[]) => (await mockQuery(...args))?.[0] ?? null);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('submitPublicationForReview', () => {
  test('uses a parameterized query -- caller-supplied values are bound params, not interpolated literals', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const maliciousId = "pub-1'; drop table pilot.video_publications; --";
    await submitPublicationForReview('org-1', maliciousId);

    const [sql, params] = mockQuery.mock.calls[0];
    // The malicious string must travel only as a bound parameter value, never
    // concatenated into the SQL text -- so the query text is unaffected by it.
    expect(sql).not.toContain('drop table');
    expect(params).toEqual(['org-1', maliciousId]);
  });

  test('the transition is a compare-and-swap out of draft only', async () => {
    // A stale submit -- a double-click, or a tab left open past an admin's
    // decision -- must not yank an already-decided publication back into the
    // review queue. The status values are the fixed endpoints of this one
    // transition, so they appear in the SQL text rather than as parameters.
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    await submitPublicationForReview('org-1', 'pub-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/set status = 'pending_review'/);
    expect(sql).toMatch(/and status = 'draft'/);
  });

  test('the update is scoped to the acting organization and reports a miss', async () => {
    // publication_id is the sole primary key, so an id belonging to another
    // gym would otherwise be mutated by whoever guesses or is handed it.
    mockQuery.mockResolvedValueOnce([]);

    const applied = await submitPublicationForReview('org-1', 'pub-from-other-org');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/where organization_id = \$1 and publication_id = \$2/);
    expect(applied).toBe(false);
  });
});

// The check-row insert deliberately carries no organization guard of its own:
// it only runs after the CAS UPDATE in the same transaction matched a row
// scoped by organization_id. These tests pin that ordering -- reordering the
// two statements, or dropping the org or status predicate from the UPDATE,
// is exactly the refactor that would silently file a compliance verdict
// against another gym's publication.
describe('decidePublicationCompliance', () => {
  const params = {
    organizationId: 'org-1',
    publicationId: 'pub-1',
    newStatus: 'approved',
    checkStatus: 'passed',
    checkType: 'compliance',
    details: 'ok',
    decidedByAccountId: 'admin-1',
    expectedCurrentStatus: 'pending_review',
  };

  test('the UPDATE is org-scoped and CAS-guarded, and runs before the check insert', async () => {
    mockQuery
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }])
      .mockResolvedValueOnce([]);

    const applied = await decidePublicationCompliance(params);

    expect(applied).toBe(true);
    const [updateSql, updateParams] = mockQuery.mock.calls[0];
    expect(updateSql).toMatch(/update pilot\.video_publications/);
    expect(updateSql).toMatch(/where organization_id = \$1 and publication_id = \$2 and status = \$7/);
    expect(updateParams[0]).toBe('org-1');
    expect(updateParams[6]).toBe('pending_review');
    const [insertSql] = mockQuery.mock.calls[1];
    expect(insertSql).toMatch(/insert into pilot\.publication_checks/);
  });

  test('a CAS miss writes no check row and reports false', async () => {
    // A cross-org publication_id and an already-decided row both surface as
    // zero UPDATE matches; either way the transaction must file nothing.
    mockQuery.mockResolvedValueOnce([]);

    const applied = await decidePublicationCompliance(params);

    expect(applied).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a verifyBeforeCommit throw aborts before any write', async () => {
    const gate = jest.fn().mockRejectedValueOnce(new Error('consent withdrawn'));

    await expect(
      decidePublicationCompliance({ ...params, verifyBeforeCommit: gate }),
    ).rejects.toThrow('consent withdrawn');

    expect(gate).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// tags is `text[] not null default '{}'::text[]`. node-pg passes a bound string
// through verbatim, and Postgres array_in rejects a JSON literal -- so
// JSON.stringify(tags) raised 22P02 on EVERY insert, including the empty
// default, and both publication endpoints returned a generic 500 forever.
describe('array-typed tags reach Postgres as arrays', () => {
  test('createPublication binds tags as a JS array, never a JSON string', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const { createPublication } = await import('./publication');
    await createPublication({
      organizationId: 'org-1',
      videoSessionId: 'vid-1',
      athleteId: 'ath-1',
      submittedByAccountId: 'coach-1',
      publicationType: 'research_library',
      title: 'Jab mechanics',
      description: 'Session review',
      tags: ['jab', 'footwork'],
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[8]).toEqual(['jab', 'footwork']);
    expect(typeof params[8]).not.toBe('string');
  });

  test('the empty-tags default is an empty array, not "[]"', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const { createPublication } = await import('./publication');
    await createPublication({
      organizationId: 'org-1',
      videoSessionId: 'vid-1',
      athleteId: 'ath-1',
      submittedByAccountId: 'coach-1',
      publicationType: 'private_archive',
      title: 'Untagged',
      description: '',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[8]).toEqual([]);
  });

  test('publishToResearchLibrary binds tags as a JS array too', async () => {
    // First statement claims the publication for the organization, second
    // writes the library row.
    mockQuery
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }])
      .mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    const libraryId = await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-1',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: 'Session review',
      tags: ['jab'],
    });

    expect(libraryId).toEqual(expect.stringContaining('lib_'));
    const [, params] = mockQuery.mock.calls[1];
    expect(params[6]).toEqual(['jab']);
  });
});

// research_library's foreign keys accept any organization's publication_id, so
// only the claim step keeps a publish inside the caller's gym. If that step is
// ever reordered after the insert, another gym's publication id lands a row on
// this gym's shelf and the caller is told it worked.
describe('publishing is refused when the publication belongs to another gym', () => {
  test('no library row is written and no library id is returned', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    const libraryId = await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-from-another-gym',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: 'Session review',
    });

    expect(libraryId).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('update pilot.video_publications');
  });

  test('the claim is scoped by organization before anything is written', async () => {
    mockQuery
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }])
      .mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-1',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: '',
    });

    const [claimSql, claimParams] = mockQuery.mock.calls[0];
    expect(claimSql).toContain('organization_id = $1');
    expect(claimParams).toEqual(['org-1', 'pub-1']);
    expect(mockQuery.mock.calls[1][0]).toContain('insert into pilot.research_library');
  });
});

// A draft reaching the research library is the failure this guards: the claim
// is the last gate a publish passes, so the clearance predicate has to live in
// the same statement that flips the row to 'published'.
describe('the claim will not publish a publication that is not cleared', () => {
  test('the claim demands approved status and passed compliance checks', async () => {
    mockQuery
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }])
      .mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-1',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: '',
    });

    const [claimSql] = mockQuery.mock.calls[0];
    expect(claimSql).toMatch(/status = 'approved'/);
    expect(claimSql).toMatch(/compliance_check_status = 'passed'/);
  });

  test('an uncleared publication writes no library row and returns no library id', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    const libraryId = await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-still-a-draft',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: '',
    });

    expect(libraryId).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('getPublicationForPublish', () => {
  test('reads the row scoped to the acting organization', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const { getPublicationForPublish } = await import('./publication');
    const row = await getPublicationForPublish('org-1', 'pub-from-another-gym');

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/where organization_id = \$1 and publication_id = \$2/);
    expect(params).toEqual(['org-1', 'pub-from-another-gym']);
    expect(row).toBeNull();
  });
});
