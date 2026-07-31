import { query } from './db';
import { updatePublicationStatus } from './publication';

jest.mock('./db', () => ({
  query: jest.fn(),
}));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('updatePublicationStatus', () => {
  test('uses a parameterized query -- caller-supplied values are bound params, not interpolated literals', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await updatePublicationStatus('pub-1', 'published', 'passed');

    const [sql, params] = mockQuery.mock.calls[0];
    // The caller-supplied complianceStatus value must never appear as a literal
    // in the SQL text -- it must travel only via the bound params array.
    expect(sql).not.toContain("'passed'");
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
    expect(sql).toMatch(/\$3/);
    expect(sql).toMatch(/\$4/);
    expect(params).toEqual(['pub-1', 'published', expect.any(String), 'passed']);
  });

  test('a status value containing a single quote cannot alter the query structure', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const maliciousStatus = "published'; drop table pilot.video_publications; --";
    await updatePublicationStatus('pub-1', maliciousStatus);

    const [sql, params] = mockQuery.mock.calls[0];
    // The malicious string must travel only as a bound parameter value, never
    // concatenated into the SQL text -- so the query text is unaffected by it.
    expect(sql).not.toContain('drop table');
    expect(params[1]).toBe(maliciousStatus);
  });

  test('omitting complianceStatus leaves the existing value untouched via coalesce', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await updatePublicationStatus('pub-1', 'pending_review');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['pub-1', 'pending_review', expect.any(String), null]);
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
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const { publishToResearchLibrary } = await import('./publication');
    await publishToResearchLibrary({
      organizationId: 'org-1',
      publicationId: 'pub-1',
      videoSessionId: 'vid-1',
      title: 'Jab mechanics',
      description: 'Session review',
      tags: ['jab'],
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toEqual(['jab']);
  });
});
