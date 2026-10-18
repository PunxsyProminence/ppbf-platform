import { createHash } from 'node:crypto';

import {
  ResearchArchiveConflictError,
  archiveFilenameFor,
  archiveResearchOriginal,
  readArchivedOriginal,
  type ResearchArchiveConfig,
} from './researchArchiveWrite';

/**
 * The archive write's whole job is refusing. These tests are therefore mostly
 * about what it must NOT do: not replace, not rename, not delete, not create a
 * folder, not file outside R01-R19, not escape its folder, not call a failure
 * a duplicate.
 *
 * Graph is mocked because there is no other option here -- no test has Graph
 * credentials. That bounds what these tests are worth, and the bound is stated
 * rather than implied: they prove the REQUESTS this module issues and the
 * DECISION it makes on each response shape. They do not and cannot prove that
 * Graph honours `conflictBehavior=fail`, or that the managed identity's
 * folder-scoped grant lets it create a file. Those are the supervised
 * synthetic-PDF proof (lane L57 plan section 7).
 *
 * Requests are asserted with EXACT string equality against the canonical URLs
 * this input may address. Substring and some()-style negative checks could not
 * fail under any mutation of the module; equality both proves where a request
 * DID go and breaks under any rename, retry, path drift or extra request.
 */

const ROOT = 'ROOTITEM';
const FOLDER_19 = 'FOLDER19';
const getAccessToken = jest.fn(async () => 'test-token');

const CONFIG: ResearchArchiveConfig = {
  siteId: 'punxsyprominenceboxing.sharepoint.com,site-guid,web-guid',
  driveId: 'b!drive-id',
  archiveRootItemId: ROOT,
  getAccessToken,
};

const INPUT = {
  config: CONFIG,
  archiveDomainCode: 'R19',
  archiveFilename: 'synthetic-pilot--0123456789ab.pdf',
  fileBuffer: Buffer.from('%PDF-1.4 synthetic'),
};

/**
 * Computed here, independently, from the same bytes. The implementation cannot
 * satisfy the hash assertions by echoing an input back, because the input does
 * not carry a hash at all.
 */
const EXPECTED_SHA256 = createHash('sha256').update(INPUT.fileBuffer).digest('hex');

const BASE = `https://graph.microsoft.com/v1.0/sites/${CONFIG.siteId}/drives/${CONFIG.driveId}`;
const LIST_URL = `${BASE}/items/${ROOT}/children?$select=id,name,folder,parentReference&$top=200`;
const ITEM_URL = `${BASE}/items/${FOLDER_19}:/synthetic-pilot--0123456789ab.pdf`;
const PUT_URL = `${ITEM_URL}:/content?@microsoft.graph.conflictBehavior=fail`;
const FOLDER_LIST_URL = `${BASE}/items/${FOLDER_19}/children?$select=id,name,folder,parentReference&$top=200`;
const EMPTY_FOLDER = { value: [] };

/** The live root's shape (2026-10-17), trimmed: subject folders named "R## - Title". */
const ROOT_CHILDREN = {
  value: [
    { id: 'CONTROL', name: '_CONTROL - Registers and Coverage Maps', folder: {}, parentReference: { id: ROOT } },
    { id: 'FOLDER00', name: 'R00 - Unsorted Drop', folder: {}, parentReference: { id: ROOT } },
    { id: 'FOLDER18', name: 'R18 - Learning Science and Skill Acquisition', folder: {}, parentReference: { id: ROOT } },
    { id: FOLDER_19, name: 'R19 - Measurement and Assessment Instruments', folder: {}, parentReference: { id: ROOT } },
    { id: 'FOLDER98', name: 'R98 - Duplicate Hold', folder: {}, parentReference: { id: ROOT } },
  ],
};

/** Graph's real error envelope is { error: { code, message } }, not a string. */
function graphError(code: string): { error: { code: string; message: string } } {
  return { error: { code, message: `synthetic ${code}` } };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bytesResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

const created = (extra: Record<string, unknown> = {}) =>
  jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/archive/item', parentReference: { id: FOLDER_19 }, ...extra });

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
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
  test('an original already at the name (in any case) is a conflict, and NO write is attempted', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [{ id: 'existing-item-id', name: 'Synthetic-Pilot--0123456789AB.pdf', file: {} }] }),
      );

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    // The load-bearing assertion. A conflict that still issued the PUT would
    // have replaced the original, and the thrown error would be a lie.
    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBe('existing-item-id');
    // Exactly the listing and the probe of the canonical name: any
    // rename-and-retry logic must add a request or move off this name.
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`]);
  });

  test('the same bytes filed earlier under another name are a conflict too, so a retry cannot file a second copy', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [
            { id: 'unrelated', name: 'Another paper--ffffffffffff.pdf', file: {} },
            { id: 'earlier-copy', name: `Old name--${EXPECTED_SHA256.slice(0, 12)}.pdf`, file: {} },
          ],
        }),
      );

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBe('earlier-copy');
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`]);
  });

  test('a file whose folder facet is null is still a file, so the same bytes are still found', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [{ id: 'earlier-copy', name: `Old name--${EXPECTED_SHA256.slice(0, 12)}.pdf`, folder: null }] }),
      );

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect((error as ResearchArchiveConflictError).existingItemId).toBe('earlier-copy');
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`]);
  });

  test('a FOLDER with the name is not an original, and does not stop the write', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, { value: [{ id: 'odd', name: 'synthetic-pilot--0123456789ab.pdf', folder: {} }] }))
      .mockResolvedValueOnce(created());

    await archiveResearchOriginal(INPUT);

    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
  });

  test('the write is create-only: conflictBehavior=fail is on the request, under the folder item id', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created());

    await archiveResearchOriginal(INPUT);

    // Graph documents this as a URL query parameter, and the default for PUT
    // is *replace* -- so its absence is not a missing nicety, it is a silent
    // overwrite. The exact-URL form also pins the parent-id address: no
    // `root:/` path, so no folder can be created along the way.
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/pdf' });
  });

  test('a write-time 409 nameAlreadyExists is a conflict, and the existing id is fetched', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(409, graphError('nameAlreadyExists')))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'raced-item-id' }));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBe('raced-item-id');
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`, `GET ${ITEM_URL}`]);
  });

  test('when the follow-up lookup fails, the refusal stands: null id, and the message says so', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(409, graphError('nameAlreadyExists')))
      .mockResolvedValueOnce(jsonResponse(503, graphError('serviceNotAvailable')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBeNull();
    expect((error as Error).message).toMatch(/id could not be fetched/i);
  });

  test('a 409 that is NOT nameAlreadyExists is a failed write, never a duplicate', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(409, graphError('resourceModified')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as Error).message).toContain('409 resourceModified');
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
  });

  test('a broken archive is NOT reported as a duplicate', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(503, graphError('serviceNotAvailable')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as Error).message).toMatch(/subject folder listing failed \(503\)/);
    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`]);
  });

  test('a write that returns no item id fails, because an unaddressable original is not archived', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(201, { webUrl: 'https://sharepoint/archive/item' }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/no item id/i);
  });

  test('anything but 201 Created from the create-only write is not recorded as filed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'replaced-item', parentReference: { id: FOLDER_19 } }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/answered 200, not 201 Created/);
  });

  test('a write that reports landing under another folder is not returned as filed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created({ parentReference: { id: 'SOMEWHERE-ELSE' } }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/not the R19 - Measurement/);
  });
});

describe('the subject folder is found by item id, never made', () => {
  test('a bare "R19" folder -- the path the old write aimed at -- is not the subject folder', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { value: [{ id: 'BARE', name: 'R19', folder: {}, parentReference: { id: ROOT } }] }),
    );

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/no "R19 - \.\.\." folder.*no folder was created/);
    // One listing, and nothing that could create a folder or write a file.
    expect(calls()).toEqual([`GET ${LIST_URL}`]);
  });

  test('two folders starting "R19 - " is a refusal, not a pick', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        value: [
          ...ROOT_CHILDREN.value,
          { id: 'FOLDER19B', name: 'R19 - Measurement (copy)', folder: {}, parentReference: { id: ROOT } },
        ],
      }),
    );

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/2 "R19 - \.\.\." folders/);
    expect(calls()).toEqual([`GET ${LIST_URL}`]);
  });

  test('a FILE named like the folder, and a folder under another parent, are not the subject folder', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        value: [
          { id: 'AFILE', name: 'R19 - Measurement notes.pdf', file: {}, parentReference: { id: ROOT } },
          { id: 'NESTED', name: 'R19 - Measurement and Assessment Instruments', folder: {}, parentReference: { id: 'OTHER' } },
        ],
      }),
    );

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/no "R19 - \.\.\." folder/);
    expect(calls()).toEqual([`GET ${LIST_URL}`]);
  });

  test('a paged root listing is followed to the end', async () => {
    const page2 = `${BASE}/items/${ROOT}/children?$skiptoken=2`;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { value: ROOT_CHILDREN.value.slice(0, 3), '@odata.nextLink': page2 }))
      .mockResolvedValueOnce(jsonResponse(200, { value: ROOT_CHILDREN.value.slice(3) }))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created());

    await archiveResearchOriginal(INPUT);

    expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${page2}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
  });

  test('a listing that never ends is refused rather than read partially', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { value: [], '@odata.nextLink': `${BASE}/items/${ROOT}/children?$skiptoken=again` }),
    );

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/did not end/);
    expect(calls().filter((c) => c.startsWith('PUT'))).toHaveLength(0);
  });

  test('a next page outside Microsoft Graph is not followed with the token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { value: [], '@odata.nextLink': 'https://graph.microsoft.com.evil.example/v1.0/next' }),
    );

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/outside Microsoft Graph/);
    expect(calls()).toEqual([`GET ${LIST_URL}`]);
  });

  test('a failed listing stops the write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, graphError('accessDenied')));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/root listing failed \(403\)/);
    expect(calls()).toEqual([`GET ${LIST_URL}`]);
  });
});

describe('names are validated before anything leaves the process', () => {
  test.each(['../../evil.pdf', 'a/b.pdf', 'a\\b.pdf', '..', '', '.hidden.pdf', 'paper.txt'])(
    'filename %j is refused with no request and no token',
    async (archiveFilename) => {
      const error = await archiveResearchOriginal({ ...INPUT, archiveFilename }).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
      expect((error as Error).message).toMatch(/refusing research archive write/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    },
  );

  // R00 and R98 are archive workflow states (#345), not subjects; R20+ do not exist.
  test.each(['R00', 'R98', 'R20', 'R1', 'r19', 'R19/../', 'R191', ''])(
    'archive domain code %j is refused with no request and no token',
    async (archiveDomainCode) => {
      const error = await archiveResearchOriginal({ ...INPUT, archiveDomainCode }).catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/refusing research archive write/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    },
  );

  test('R01 is accepted as a subject code', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [{ id: 'FOLDER01', name: 'R01 - Boxing and Athlete Development', folder: {}, parentReference: { id: ROOT } }] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created({ parentReference: { id: 'FOLDER01' } }));

    const identity = await archiveResearchOriginal({ ...INPUT, archiveDomainCode: 'R01' });

    expect(identity.archiveFolderItemId).toBe('FOLDER01');
  });
});

describe('sign-in is the token the caller supplies, never a client secret', () => {
  test('every request carries that token, and no token endpoint is called', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created());

    await archiveResearchOriginal(INPUT);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(String(url).startsWith(BASE)).toBe(true);
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    }
  });
});

describe('the hash and size are of the bytes, never accepted from a caller', () => {
  test('the returned contentSha256 is the sha256 of the buffer actually sent', async () => {
    const otherBuffer = Buffer.from('%PDF-1.4 different bytes');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created());

    const identity = await archiveResearchOriginal({ ...INPUT, fileBuffer: otherBuffer });

    expect(identity.contentSha256).toBe(createHash('sha256').update(otherBuffer).digest('hex'));
    expect(identity.contentSha256).not.toBe(EXPECTED_SHA256);
    expect(identity.byteSize).toBe(otherBuffer.length);
  });
});

describe('the identity it returns is the archive identity', () => {
  test('every structured value the record needs is present', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(created());

    expect(await archiveResearchOriginal(INPUT)).toEqual({
      provider: 'sharepoint',
      siteId: CONFIG.siteId,
      driveId: CONFIG.driveId,
      itemId: 'new-item-id',
      webUrl: 'https://sharepoint/archive/item',
      archiveRootItemId: ROOT,
      archiveDomainCode: 'R19',
      archiveFolderItemId: FOLDER_19,
      archiveFilename: 'synthetic-pilot--0123456789ab.pdf',
      contentSha256: EXPECTED_SHA256,
      byteSize: INPUT.fileBuffer.length,
    });
  });

  test('an absent webUrl is null, never a fabricated address', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
      .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id', parentReference: { id: FOLDER_19 } }));

    expect((await archiveResearchOriginal(INPUT)).webUrl).toBeNull();
  });
});

describe('it is a different path from the generic intake uploader', () => {
  test('it addresses the archive root even when the generic uploader is configured', async () => {
    process.env.SHAREPOINT_FOLDER_PATH = 'PPBF/Intake';
    process.env.SHAREPOINT_SITE_ID = 'generic-site';
    process.env.SHAREPOINT_DRIVE_ID = 'generic-drive';
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, ROOT_CHILDREN))
        .mockResolvedValueOnce(jsonResponse(200, EMPTY_FOLDER))
        .mockResolvedValueOnce(created());

      await archiveResearchOriginal(INPUT);

      expect(calls()).toEqual([`GET ${LIST_URL}`, `GET ${FOLDER_LIST_URL}`, `PUT ${PUT_URL}`]);
    } finally {
      delete process.env.SHAREPOINT_FOLDER_PATH;
      delete process.env.SHAREPOINT_SITE_ID;
      delete process.env.SHAREPOINT_DRIVE_ID;
    }
  });
});

describe('the filed name', () => {
  const SHA = 'f'.repeat(52) + '0123456789ab';
  const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}\.pdf$/i;

  test.each([
    ['Neale et al. (2024) Punch force?.pdf', `Neale et al. _2024_ Punch force--${SHA.slice(0, 12)}.pdf`],
    ['C:\\fakepath\\Paper.PDF', `Paper--${SHA.slice(0, 12)}.pdf`],
    ['../../evil.pdf', `evil--${SHA.slice(0, 12)}.pdf`],
    ['....pdf', `original--${SHA.slice(0, 12)}.pdf`],
    ['Ünïcode study.pdf', `n_code study--${SHA.slice(0, 12)}.pdf`],
    ['notes_vti_draft.pdf', `notes_vti-draft--${SHA.slice(0, 12)}.pdf`],
  ])('%j is filed as %j', (originalFilename, expected) => {
    const filed = archiveFilenameFor(originalFilename, SHA);
    expect(filed).toBe(expected);
    expect(filed).toMatch(SAFE_FILENAME);
  });

  test('a very long name is cut, and the result still passes the allowlist', () => {
    const filed = archiveFilenameFor(`${'a'.repeat(400)}.pdf`, SHA);
    expect(filed).toBe(`${'a'.repeat(150)}--${SHA.slice(0, 12)}.pdf`);
    expect(filed).toMatch(SAFE_FILENAME);
  });

  test('it needs the real hash of the bytes', () => {
    expect(() => archiveFilenameFor('x.pdf', 'ABC')).toThrow(/sha-256/);
  });
});

describe('reading an original back, for a caller holding a conflict', () => {
  const META_URL = `${BASE}/items/existing-item-id?$select=id,name,size,webUrl,parentReference`;
  const CONTENT_URL = `${BASE}/items/existing-item-id/content`;
  const READ = { config: CONFIG, itemId: 'existing-item-id', expectedFolderItemId: FOLDER_19, maxBytes: 1024 };

  test('returns the bytes and their hash after one metadata read and one download', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { id: 'existing-item-id', name: 'x.pdf', size: INPUT.fileBuffer.length, webUrl: 'https://sp/x', parentReference: { id: FOLDER_19 } }),
      )
      .mockResolvedValueOnce(bytesResponse(INPUT.fileBuffer));

    const read = await readArchivedOriginal(READ);

    expect(read).toMatchObject({ itemId: 'existing-item-id', name: 'x.pdf', webUrl: 'https://sp/x', contentSha256: EXPECTED_SHA256 });
    expect(calls()).toEqual([`GET ${META_URL}`, `GET ${CONTENT_URL}`]);
  });

  test.each([
    ['another folder', { id: 'existing-item-id', name: 'x.pdf', size: 10, parentReference: { id: 'OTHER' } }, /expected subject folder/],
    ['too large', { id: 'existing-item-id', name: 'x.pdf', size: 4096, parentReference: { id: FOLDER_19 } }, /outside 1\.\.1024/],
    ['a different item', { id: 'someone-else', name: 'x.pdf', size: 10, parentReference: { id: FOLDER_19 } }, /different item/],
  ])('an item in %s is refused before any download', async (_label, meta, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, meta));

    await expect(readArchivedOriginal(READ)).rejects.toThrow(message);
    expect(calls()).toEqual([`GET ${META_URL}`]);
  });
});
