import {
  ResearchArchiveConflictError,
  archiveResearchOriginal,
  type ResearchArchiveConfig,
} from './researchArchiveWrite';

/**
 * The archive write's whole job is refusing. These tests are therefore mostly
 * about what it must NOT do: not replace, not rename, not delete.
 *
 * Graph is mocked because there is no other option here -- this sandbox has no
 * Graph credentials and the proxy refuses SharePoint outright. That bounds what
 * these tests are worth, and the bound is stated rather than implied: they
 * prove the REQUEST this module issues and the DECISION it makes on each
 * response shape. They do not and cannot prove that Graph honours
 * `conflictBehavior=fail`. That is a live-environment proof, and until it is
 * run the create-only guarantee rests on Microsoft's documented behaviour
 * rather than on anything observed here.
 */

jest.mock('../document-intake/auth', () => ({
  getClientCredentialToken: jest.fn(async () => 'test-token'),
}));

const CONFIG: ResearchArchiveConfig = {
  tenantId: 'tenant',
  clientId: 'client',
  clientSecret: 'secret',
  siteId: 'punxsyprominenceboxing.sharepoint.com,site-guid,web-guid',
  driveId: 'b!drive-id',
  archiveRootItemId: '0154ROOTITEMID',
  archiveRootPath: 'Research Archive',
};

const INPUT = {
  config: CONFIG,
  archiveDomainCode: 'R19',
  originalFilename: 'synthetic-pilot.pdf',
  contentSha256: 'a'.repeat(64),
  fileBuffer: Buffer.from('%PDF-1.4 synthetic'),
  acquisitionProvider: 'synthetic',
  acquisitionChannel: 'pilot_test',
  acquiredAt: '2026-08-24T00:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** Every request the module made, as `METHOD url`. */
function calls(): string[] {
  return fetchMock.mock.calls.map(
    ([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`,
  );
}

describe('the research archive write refuses rather than replaces', () => {
  test('an original already at the path is a conflict, and NO write is attempted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'existing-item-id' }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toBeInstanceOf(ResearchArchiveConflictError);

    // The load-bearing assertion. A conflict that still issued the PUT would
    // have replaced the original, and the thrown error would be a lie.
    expect(calls().filter((c) => c.startsWith('PUT'))).toHaveLength(0);
  });

  test('the conflict carries the existing item id, so lineage can be recorded against it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'existing-item-id' }));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBe('existing-item-id');
  });

  test('a collision is never renamed around', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'existing-item-id' }));

    await archiveResearchOriginal(INPUT).catch(() => undefined);

    // No second attempt under any name -- an auto `-2` suffix would create a
    // second original with no recorded relationship to the first.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls().some((c) => /synthetic-pilot[-_ ]?\d/.test(c))).toBe(false);
  });

  test('the write is create-only: conflictBehavior=fail is on the request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/archive/item' }));

    await archiveResearchOriginal(INPUT);

    const put = calls().find((c) => c.startsWith('PUT'));

    // Graph documents this as a URL query parameter, not a header or a body
    // field, and the default for PUT is *replace* -- so its absence is not a
    // missing nicety, it is a silent overwrite. Asserted on the decoded URL
    // because `@` is legal unencoded in a query (RFC 3986 pchar) and either
    // spelling reaches Graph as the same parameter; what must never vary is
    // that the parameter is there and says `fail`.
    expect(put).toBeDefined();
    expect(decodeURIComponent(String(put))).toContain('?@microsoft.graph.conflictBehavior=fail');
  });

  test('a 409 from Graph is a conflict, not a generic failure', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'nameAlreadyExists' }));

    // The race the pre-check cannot close: the item appeared between probe and
    // write. The caller must still be able to tell this from a broken archive.
    await expect(archiveResearchOriginal(INPUT)).rejects.toBeInstanceOf(ResearchArchiveConflictError);
  });

  test('a broken archive is NOT reported as a duplicate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'service unavailable' }));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
    expect(calls().filter((c) => c.startsWith('PUT'))).toHaveLength(0);
  });

  test('nothing is ever deleted', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/archive/item' }));

    await archiveResearchOriginal(INPUT);

    expect(calls().some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  test('a write that returns no item id fails, because an unaddressable original is not archived', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(201, { webUrl: 'https://sharepoint/archive/item' }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/no item id/i);
  });
});

describe('the identity it returns is the archive identity', () => {
  beforeEach(() => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(
        jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/sites/ops/Research%20Archive/R19/x.pdf' }),
      );
  });

  test('every structured value the contract requires is present', async () => {
    const identity = await archiveResearchOriginal(INPUT);

    expect(identity).toEqual({
      provider: 'sharepoint',
      siteId: CONFIG.siteId,
      driveId: CONFIG.driveId,
      itemId: 'new-item-id',
      webUrl: 'https://sharepoint/sites/ops/Research%20Archive/R19/x.pdf',
      archiveRootItemId: CONFIG.archiveRootItemId,
      archiveDomainCode: 'R19',
      originalFilename: 'synthetic-pilot.pdf',
      contentSha256: 'a'.repeat(64),
      acquisitionProvider: 'synthetic',
      acquisitionChannel: 'pilot_test',
      acquiredAt: '2026-08-24T00:00:00.000Z',
      duplicateStatus: 'original',
    });
  });

  test('webUrl is where Graph put the file, never a publisher or DOI url', async () => {
    const identity = await archiveResearchOriginal(INPUT);

    // Conflating the two is how a reader ends up at a paywall instead of the
    // governed artefact. This module only ever reports what Graph returned.
    expect(identity.webUrl).toBe('https://sharepoint/sites/ops/Research%20Archive/R19/x.pdf');
    expect(identity.webUrl).not.toMatch(/doi\.org|pubmed|sciencedirect/i);
  });

  test('the file lands under the archive root and its domain folder', async () => {
    await archiveResearchOriginal(INPUT);

    const put = calls().find((c) => c.startsWith('PUT'));
    expect(put).toContain('Research%20Archive/R19/synthetic-pilot.pdf');
  });
});

describe('it is a different path from the generic intake uploader', () => {
  test('it addresses the archive root, not SHAREPOINT_FOLDER_PATH', async () => {
    process.env.SHAREPOINT_FOLDER_PATH = 'PPBF/Intake';
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id' }));

    await archiveResearchOriginal(INPUT);

    // Configuring the generic uploader must never aim an archive write.
    expect(calls().every((c) => !c.includes('PPBF/Intake'))).toBe(true);
    delete process.env.SHAREPOINT_FOLDER_PATH;
  });
});
