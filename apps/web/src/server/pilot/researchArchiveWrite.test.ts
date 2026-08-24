import { createHash } from 'node:crypto';
import { getClientCredentialToken } from '../document-intake/auth';
import {
  ResearchArchiveConflictError,
  archiveResearchOriginal,
  type ResearchArchiveConfig,
} from './researchArchiveWrite';

/**
 * The archive write's whole job is refusing. These tests are therefore mostly
 * about what it must NOT do: not replace, not rename, not delete, not escape
 * its folder, not call a failure a duplicate.
 *
 * Graph is mocked because there is no other option here -- this sandbox has no
 * Graph credentials and the proxy refuses SharePoint outright. That bounds what
 * these tests are worth, and the bound is stated rather than implied: they
 * prove the REQUEST this module issues and the DECISION it makes on each
 * response shape. They do not and cannot prove that Graph honours
 * `conflictBehavior=fail`. That is a live-environment proof, and until it is
 * run the create-only guarantee rests on Microsoft's documented behaviour
 * rather than on anything observed here.
 *
 * Requests are asserted with EXACT string equality against the one canonical
 * URL this input may address. Substring and some()-style negative checks were
 * removed after review showed several could not fail under any mutation of the
 * module; equality both proves where a request DID go and breaks under any
 * rename, retry, or path drift.
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
  fileBuffer: Buffer.from('%PDF-1.4 synthetic'),
  acquisitionProvider: 'synthetic',
  acquisitionChannel: 'pilot_test',
  acquiredAt: '2026-08-24T00:00:00.000Z',
};

/**
 * Computed here, independently, from the same bytes. The implementation cannot
 * satisfy the hash assertions by echoing an input back, because the input no
 * longer carries a hash at all.
 */
const EXPECTED_SHA256 = createHash('sha256').update(INPUT.fileBuffer).digest('hex');

/** The one path this INPUT may address, and the only write URL it may use. */
const ITEM_URL = `https://graph.microsoft.com/v1.0/sites/${CONFIG.siteId}/drives/${CONFIG.driveId}/root:/Research%20Archive/R19/synthetic-pilot.pdf`;
const PUT_URL = `${ITEM_URL}:/content?@microsoft.graph.conflictBehavior=fail`;

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

    // Exactly one request, and it is the probe of the canonical path. Any
    // rename-and-retry logic must either add a request or move off this path,
    // and either breaks the equality. (An earlier regex-based "no renamed
    // URL" check could not fail under any mutation; this can.)
    expect(calls()).toEqual([`GET ${ITEM_URL}`]);
  });

  test('the write is create-only: conflictBehavior=fail is on the request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/archive/item' }));

    await archiveResearchOriginal(INPUT);

    // Graph documents this as a URL query parameter, not a header or a body
    // field, and the default for PUT is *replace* -- so its absence is not a
    // missing nicety, it is a silent overwrite. `@` is legal unencoded in a
    // query (RFC 3986 pchar); the exact-URL form pins the parameter and the
    // path in one assertion.
    expect(calls().find((c) => c.startsWith('PUT'))).toBe(`PUT ${PUT_URL}`);
  });

  test('a write-time 409 nameAlreadyExists is a conflict, and the existing id is fetched for lineage', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(409, graphError('nameAlreadyExists')))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'raced-item-id' }));

    // The race the pre-check cannot close: the item appeared between probe and
    // write. Still a duplicate, and the caller still gets the id to record
    // lineage against -- via a follow-up read of the same canonical path.
    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBe('raced-item-id');
    expect(calls()).toEqual([`GET ${ITEM_URL}`, `PUT ${PUT_URL}`, `GET ${ITEM_URL}`]);
  });

  test('when the follow-up lookup fails, the refusal stands: null id, and the message says so', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(409, graphError('nameAlreadyExists')))
      .mockResolvedValueOnce(jsonResponse(503, graphError('serviceNotAvailable')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    // Best-effort means best-effort: a failed lookup must not turn the
    // refusal into a crash, and must not fabricate an id either.
    expect(error).toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as ResearchArchiveConflictError).existingItemId).toBeNull();
    expect((error as Error).message).toMatch(/id could not be fetched/i);
  });

  test('a 409 that is NOT nameAlreadyExists is a failed write, never a duplicate', async () => {
    // Graph answers 409 for more than duplicates: a missing parent folder and
    // concurrency violations land here too. A new domain code whose folder
    // does not exist yet must surface as "nothing was archived", not be
    // recorded as "duplicate of an already-archived original".
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(409, graphError('resourceModified')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as Error).message).toContain('409 resourceModified');
    // No lineage lookup either: there is no duplicate to record lineage against.
    expect(calls()).toEqual([`GET ${ITEM_URL}`, `PUT ${PUT_URL}`]);
  });

  test('a broken archive is NOT reported as a duplicate', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, graphError('serviceNotAvailable')));

    const error = await archiveResearchOriginal(INPUT).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
    expect((error as Error).message).toMatch(/pre-check failed \(503\)/);
    expect(calls().filter((c) => c.startsWith('PUT'))).toHaveLength(0);
  });

  test('the success path is exactly one probe and one create, and nothing else', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/archive/item' }));

    await archiveResearchOriginal(INPUT);

    // Exact equality, deliberately. The earlier form of this test asserted
    // "no DELETE call", which no mutation of this module could ever fail.
    // This form fails if the module grows ANY extra request -- a delete, a
    // rename retry, a second write -- or moves either request off the
    // canonical path.
    expect(calls()).toEqual([`GET ${ITEM_URL}`, `PUT ${PUT_URL}`]);
  });

  test('a write that returns no item id fails, because an unaddressable original is not archived', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { webUrl: 'https://sharepoint/archive/item' }));

    await expect(archiveResearchOriginal(INPUT)).rejects.toThrow(/no item id/i);
  });
});

describe('names are validated before anything leaves the process', () => {
  // `encodePathSegment` keeps `/` un-encoded and URL normalization collapses
  // dot segments, so an unvalidated "../../evil.pdf" would write to the DRIVE
  // ROOT while the returned identity still claimed the domain folder. The
  // refusal must happen before ANY network call -- the token fetch included.

  test.each(['../../evil.pdf', 'a/b.pdf', 'a\\b.pdf', '..', ''])(
    'filename %j is refused with no request made',
    async (originalFilename) => {
      const error = await archiveResearchOriginal({ ...INPUT, originalFilename }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
      expect((error as Error).message).toMatch(/refusing research archive write/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getClientCredentialToken).not.toHaveBeenCalled();
    },
  );

  test.each(['R19/../', 'R19/..', '..', 'R191', ''])(
    'archive domain code %j is refused with no request made',
    async (archiveDomainCode) => {
      const error = await archiveResearchOriginal({ ...INPUT, archiveDomainCode }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ResearchArchiveConflictError);
      expect((error as Error).message).toMatch(/refusing research archive write/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getClientCredentialToken).not.toHaveBeenCalled();
    },
  );
});

describe('the hash is computed from the bytes, never accepted from a caller', () => {
  test('the returned contentSha256 is the sha256 of the buffer actually sent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id' }));

    const identity = await archiveResearchOriginal(INPUT);

    expect(identity.contentSha256).toBe(EXPECTED_SHA256);
  });

  test('different bytes yield a different hash', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id' }));

    const otherBuffer = Buffer.from('%PDF-1.4 different bytes');
    const identity = await archiveResearchOriginal({ ...INPUT, fileBuffer: otherBuffer });

    // Depends on the bytes, not on the input shape or a constant.
    expect(identity.contentSha256).toBe(createHash('sha256').update(otherBuffer).digest('hex'));
    expect(identity.contentSha256).not.toBe(EXPECTED_SHA256);
  });
});

describe('the identity it returns is the archive identity', () => {
  test('every structured value the contract requires is present', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(
        jsonResponse(201, { id: 'new-item-id', webUrl: 'https://sharepoint/sites/ops/Research%20Archive/R19/x.pdf' }),
      );

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
      contentSha256: EXPECTED_SHA256,
      acquisitionProvider: 'synthetic',
      acquisitionChannel: 'pilot_test',
      acquiredAt: '2026-08-24T00:00:00.000Z',
      duplicateStatus: 'original',
    });
  });

  test('an absent webUrl is null, never a fabricated address', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id' }));

    const identity = await archiveResearchOriginal(INPUT);

    // webUrl is only ever what Graph reported for the archive item. When
    // Graph reports none, the honest value is null -- constructing a
    // plausible-looking URL from config would be the publisher/DOI confusion
    // in a different coat. (An earlier assertion that the webUrl "is not a
    // DOI url" tested only this file's own mock and was removed as vacuous.)
    expect(identity.webUrl).toBeNull();
  });
});

describe('it is a different path from the generic intake uploader', () => {
  test('it addresses the archive root even when the generic uploader is configured', async () => {
    process.env.SHAREPOINT_FOLDER_PATH = 'PPBF/Intake';
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(404, graphError('itemNotFound')))
        .mockResolvedValueOnce(jsonResponse(201, { id: 'new-item-id' }));

      await archiveResearchOriginal(INPUT);

      // Exact equality with the env var set: were the module ever mutated to
      // read the generic uploader's config, the path would change and this
      // would fail. The earlier substring form ("no call contains
      // PPBF/Intake") said nothing about where the write DID go.
      expect(calls()).toEqual([`GET ${ITEM_URL}`, `PUT ${PUT_URL}`]);
    } finally {
      delete process.env.SHAREPOINT_FOLDER_PATH;
    }
  });
});
