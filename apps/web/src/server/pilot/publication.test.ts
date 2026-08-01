import { query, queryOne, withTransaction } from './db';
import { updatePublicationStatus } from './publication';

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

describe('updatePublicationStatus', () => {
  test('uses a parameterized query -- caller-supplied values are bound params, not interpolated literals', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    await updatePublicationStatus('org-1', 'pub-1', 'published', 'passed');

    const [sql, params] = mockQuery.mock.calls[0];
    // The caller-supplied complianceStatus value must never appear as a literal
    // in the SQL text -- it must travel only via the bound params array.
    expect(sql).not.toContain("'passed'");
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
    expect(sql).toMatch(/\$3/);
    expect(sql).toMatch(/\$4/);
    expect(sql).toMatch(/\$5/);
    expect(params).toEqual(['org-1', 'pub-1', 'published', expect.any(String), 'passed', null]);
  });

  test('the approving account is recorded, and left untouched when none is supplied', async () => {
    mockQuery
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }])
      .mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    await updatePublicationStatus('org-1', 'pub-1', 'approved', 'passed', 'admin-1');
    await updatePublicationStatus('org-1', 'pub-1', 'pending_review', 'manual_review');

    expect(mockQuery.mock.calls[0][1][5]).toBe('admin-1');
    expect(mockQuery.mock.calls[0][0]).toMatch(/approved_by_account_id = coalesce\(\$6, approved_by_account_id\)/);
    expect(mockQuery.mock.calls[1][1][5]).toBeNull();
  });

  test('a status value containing a single quote cannot alter the query structure', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    const maliciousStatus = "published'; drop table pilot.video_publications; --";
    await updatePublicationStatus('org-1', 'pub-1', maliciousStatus);

    const [sql, params] = mockQuery.mock.calls[0];
    // The malicious string must travel only as a bound parameter value, never
    // concatenated into the SQL text -- so the query text is unaffected by it.
    expect(sql).not.toContain('drop table');
    expect(params[2]).toBe(maliciousStatus);
  });

  test('omitting complianceStatus leaves the existing value untouched via coalesce', async () => {
    mockQuery.mockResolvedValueOnce([{ publication_id: 'pub-1' }]);

    await updatePublicationStatus('org-1', 'pub-1', 'pending_review');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1', 'pub-1', 'pending_review', expect.any(String), null, null]);
  });

  test('the update is scoped to the acting organization and reports a miss', async () => {
    // publication_id is the sole primary key, so an id belonging to another
    // gym would otherwise be mutated by whoever guesses or is handed it.
    mockQuery.mockResolvedValueOnce([]);

    const updated = await updatePublicationStatus('org-1', 'pub-from-other-org', 'published');

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/where\s+organization_id = \$1\s+and\s+publication_id = \$2/);
    expect(updated).toBe(false);
  });
});

describe('recordComplianceCheck', () => {
  test('records nothing for a publication outside the acting organization', async () => {
    // The insert is guarded by an exists() over the publication scoped to the
    // organization -- the checks table's foreign key alone accepts any gym's
    // publication_id.
    mockQuery.mockResolvedValueOnce([]);

    const { recordComplianceCheck } = await import('./publication');
    const check = await recordComplianceCheck({
      organizationId: 'org-1',
      publicationId: 'pub-from-other-org',
      checkType: 'compliance',
      checkStatus: 'passed',
      details: '',
      checkedByAccountId: 'admin-1',
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/where exists/i);
    expect(sql).toMatch(/organization_id = \$2 and publication_id = \$3/);
    expect(params[1]).toBe('org-1');
    expect(params[2]).toBe('pub-from-other-org');
    expect(check).toBeNull();
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
