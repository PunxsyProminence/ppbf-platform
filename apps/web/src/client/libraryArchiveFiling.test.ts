import {
  fileLibraryPdfOriginal,
  linkableOriginal,
  readArchiveFilingStatus,
  readLibraryPdf,
  submitLibraryTextIntake,
  type FiledOriginal,
} from './libraryTextIntake';

// Lane L57 (issue #345): the client half of filing a research PDF in the
// SharePoint Research Archive, and of linking an excerpt to what was filed.

const SHA = 'a'.repeat(64);

function answering(status: number, json: unknown) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return { status, ok: status < 400, json: async () => json } as Response;
  }) as typeof fetch;
  return { seen, impl };
}

const pdf = () => new File(['%PDF-1.7 body'], 'paper.pdf', { type: 'application/pdf' });

const FIELDS = {
  sourceId: 'source_a',
  acquisitionProvider: 'Penn State University Libraries',
  acquisitionChannel: 'library_database' as const,
  versionKind: 'version_of_record' as const,
  acquiredAt: '2026-10-01',
};

const FILED: FiledOriginal = {
  archivedOriginalId: 'arc_11111111-2222-3333-4444-555555555555',
  sourceId: 'source_a',
  archiveDomainCode: 'R19',
  archiveFilename: 'paper--aaaaaaaaaaaa.pdf',
  webUrl: null,
  contentSha256: SHA,
};

describe('readArchiveFilingStatus', () => {
  it.each([
    [200, { ok: true, archive: 'on' }, undefined, 'on', '/api/pilot/shadow/library/archive-original'],
    [200, { ok: true, archive: 'off' }, 'platform', 'off', '/api/pilot/shadow/library/archive-original?shelf=platform'],
    [403, { error: 'Forbidden' }, undefined, 'off', '/api/pilot/shadow/library/archive-original'],
    [500, {}, undefined, 'unavailable', '/api/pilot/shadow/library/archive-original'],
    [200, { ok: true, archive: 'maybe' }, undefined, 'unavailable', '/api/pilot/shadow/library/archive-original'],
  ] as const)('a %s %j for shelf %s reads as %s', async (status, json, shelf, expected, path) => {
    const { seen, impl } = answering(status, json);
    expect(await readArchiveFilingStatus('https://app.test', shelf, { fetchImpl: impl })).toBe(expected);
    expect(seen.map((call) => [call.url, call.init?.method])).toEqual([[`https://app.test${path}`, 'GET']]);
  });

  it('no answer at all reads as unavailable', async () => {
    const impl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await readArchiveFilingStatus('', undefined, { fetchImpl: impl })).toBe('unavailable');
  });
});

describe('fileLibraryPdfOriginal', () => {
  it('posts the file and its provenance as multipart, and reads back the filed original', async () => {
    const { seen, impl } = answering(201, {
      ok: true,
      status: 'filed',
      archived_original: {
        archived_original_id: FILED.archivedOriginalId,
        source_id: 'source_a',
        archive_domain_code: 'R19',
        archive_filename: FILED.archiveFilename,
        web_url: 'https://example.sharepoint.com/x.pdf',
        content_sha256: SHA,
      },
    });

    const result = await fileLibraryPdfOriginal('https://app.test', pdf(), { ...FIELDS, shelf: 'platform' }, { fetchImpl: impl });

    expect(result).toEqual({ ok: true, alreadyFiled: false, original: { ...FILED, webUrl: 'https://example.sharepoint.com/x.pdf' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://app.test/api/pilot/shadow/library/archive-original');
    expect(seen[0].init?.method).toBe('POST');
    expect(seen[0].init?.headers).toBeUndefined();
    const form = seen[0].init?.body as FormData;
    expect([...form.keys()]).toEqual([
      'file',
      'source_id',
      'acquisition_provider',
      'acquisition_channel',
      'version_kind',
      'acquired_at',
      'shelf',
    ]);
    expect(form.get('shelf')).toBe('platform');
  });

  it('an empty date and the gym shelf are not sent at all', async () => {
    const { seen, impl } = answering(200, { ok: true, status: 'already_filed', archived_original: {} });

    await fileLibraryPdfOriginal('', pdf(), { ...FIELDS, acquiredAt: '  ' }, { fetchImpl: impl });

    const form = seen[0].init?.body as FormData;
    expect(form.has('acquired_at')).toBe(false);
    expect(form.has('shelf')).toBe(false);
  });

  it('a refusal keeps the server sentence and code; a malformed success is not a success', async () => {
    const refused = answering(409, { error: 'Classify this source first.', code: 'SOURCE_NOT_CLASSIFIED' });
    expect(await fileLibraryPdfOriginal('', pdf(), FIELDS, { fetchImpl: refused.impl })).toEqual({
      ok: false,
      status: 409,
      serverMessage: 'Classify this source first.',
      code: 'SOURCE_NOT_CLASSIFIED',
    });

    const malformed = answering(201, { ok: true, status: 'filed', archived_original: { archived_original_id: 'arc_x' } });
    expect(await fileLibraryPdfOriginal('', pdf(), FIELDS, { fetchImpl: malformed.impl })).toMatchObject({ ok: false, status: 201 });
  });
});

describe('linking an excerpt to the filed original', () => {
  it('only for the same source and the same bytes as were read', () => {
    expect(linkableOriginal(FILED, 'source_a', SHA)).toBe(FILED);
    expect(linkableOriginal(FILED, 'source_b', SHA)).toBeNull();
    expect(linkableOriginal(FILED, 'source_a', 'b'.repeat(64))).toBeNull();
    expect(linkableOriginal(FILED, 'source_a', null)).toBeNull();
    expect(linkableOriginal(null, 'source_a', SHA)).toBeNull();
  });

  it('the reader passes on a well-formed hash only', async () => {
    const good = answering(200, { ok: true, content_sha256: SHA, pages: [{ num: 1, text: 'one' }] });
    expect(await readLibraryPdf('', pdf(), { fetchImpl: good.impl })).toMatchObject({ ok: true, contentSha256: SHA });
    const bad = answering(200, { ok: true, content_sha256: 'not-a-hash', pages: [{ num: 1, text: 'one' }] });
    expect(await readLibraryPdf('', pdf(), { fetchImpl: bad.impl })).toMatchObject({ ok: true, contentSha256: null });
  });

  it('the document write carries the link only with a PDF page', async () => {
    const base = { sourceId: 'source_a', documentName: 'Agreement', locator: 'p. 2', text: 'one', archivedOriginalId: FILED.archivedOriginalId };
    const withPage = answering(201, { ok: true, document: { document_id: 'doc_1' } });
    await submitLibraryTextIntake('', { ...base, pdfPage: { num: 2, text: 'one', notOnPageMessage: 'x' } }, { fetchImpl: withPage.impl });
    expect(JSON.parse(String(withPage.seen[0].init?.body))).toMatchObject({ archived_original_id: FILED.archivedOriginalId });

    const typed = answering(201, { ok: true, document: { document_id: 'doc_2' } });
    await submitLibraryTextIntake('', base, { fetchImpl: typed.impl });
    expect(JSON.parse(String(typed.seen[0].init?.body))).not.toHaveProperty('archived_original_id');
  });
});
