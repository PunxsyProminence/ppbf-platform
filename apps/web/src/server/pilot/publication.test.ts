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
