import {
  INTAKE_CHUNK_TARGET_LENGTH,
  INTAKE_MAX_TEXT_LENGTH,
  INTAKE_METHOD,
  PDF_READ_MAX_BYTES,
  TEXT_ORIGIN_PDF_PAGE,
  isTextFromPage,
  normalizeIntakeText,
  pdfPageLocator,
  readLibraryPdf,
  rejoinIntakeChunks,
  splitIntakeText,
  submitLibraryTextIntake,
  validateIntakeInput,
  type IntakeInput,
} from './libraryTextIntake';
import { MANUAL_TEXT_INTAKE_COMPLETE_SQL } from '@/src/server/pilot/shadowLibrary';
import { LIBRARY_PDF_MAX_BYTES } from '@/src/server/pilot/libraryPdfText';

// RINT-02 imports the server's gate SQL and size limit only to pin the client
// to them. Neither module's heavy dependency is wanted here.
jest.mock('pdf-parse', () => ({ PDFParse: class {} }));
jest.mock('@/src/server/pilot/db', () => ({}));

// What these pin (RINT-01): the split is mechanical and lossless, ordinals are
// contiguous from 0, the document is written once and before any chunk, the
// evidence review route is never called, and a failure part-way through is
// reported with a resume token that finishes the same document.

const SENTENCE = 'Session RPE tracked training load in adolescent boxers across a twelve week block.';

function longText(): string {
  const paragraphs: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    paragraphs.push(`${index + 1}. ${SENTENCE} ${SENTENCE}`);
  }
  // Mixed separators on purpose: blank lines, a triple break, a single break.
  return `${paragraphs.slice(0, 10).join('\n\n')}\n\n\n${paragraphs.slice(10, 20).join('\n')}\n \n${paragraphs.slice(20).join('  \n\n')}`;
}

const INPUT: IntakeInput = {
  sourceId: 'source_abc',
  documentName: 'Methods, load monitoring',
  locator: 'pp. 4-6',
  text: longText(),
};

interface Call {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
}

function recordingFetch(respond: (call: Call, index: number) => { status: number; json?: unknown } | 'throw') {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const answer = respond(call, calls.length - 1);
    if (answer === 'throw') throw new Error('network down');
    return { status: answer.status, ok: answer.status < 400, json: async () => answer.json ?? {} } as Response;
  }) as typeof fetch;
  return { calls, impl };
}

const created = { status: 201, json: { ok: true, document: { document_id: 'doc_1' } } };

describe('splitIntakeText', () => {
  it('rejoins to exactly the normalized submitted text', () => {
    const chunks = splitIntakeText(INPUT.text);
    expect(chunks.length).toBeGreaterThan(3);
    expect(rejoinIntakeChunks(chunks)).toBe(normalizeIntakeText(INPUT.text));
  });

  it('changes only line endings and outer whitespace', () => {
    expect(normalizeIntakeText('  a\r\nb\rc  d\n\n\ne \n')).toBe('a\nb\nc  d\n\n\ne');
  });

  it('numbers chunks contiguously from 0 and keeps every chunk within the target', () => {
    const chunks = splitIntakeText(INPUT.text);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks[0].joinBefore).toBe('');
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.text.length).toBeLessThanOrEqual(INTAKE_CHUNK_TARGET_LENGTH);
    }
  });

  it('starts and ends every chunk on text, because the route trims what it stores', () => {
    for (const chunk of splitIntakeText(INPUT.text)) {
      expect(chunk.text).toBe(chunk.text.trim());
    }
  });

  // The chunk route trims what it stores, so a chunk edge that lands on any
  // whitespace JS trims -- not only space and newline -- would lose text. Each
  // case puts one such run on, just before, or just after the cut.
  it.each([
    ['space', ' '], ['tab', '\t'], ['newline', '\n'], ['blank line', '\n\n'], ['no-break space', ' '],
    ['line separator', ' '], ['ideographic space', '　'], ['mixed run', ' \t \n '],
  ])('never leaves a %s on a chunk edge at the window boundary', (_name, gap) => {
    for (const lead of [INTAKE_CHUNK_TARGET_LENGTH - 1, INTAKE_CHUNK_TARGET_LENGTH, INTAKE_CHUNK_TARGET_LENGTH + 1]) {
      for (const head of ['x'.repeat(lead), `${'word '.repeat(40)}${'x'.repeat(lead - 200)}`]) {
        const text = `${head}${gap}${'y'.repeat(INTAKE_CHUNK_TARGET_LENGTH + 5)}${gap}tail`;
        const chunks = splitIntakeText(text);
        expect(rejoinIntakeChunks(chunks)).toBe(normalizeIntakeText(text));
        for (const chunk of chunks) {
          expect(chunk.text).toBe(chunk.text.trim());
          expect(chunk.text.length).toBeGreaterThan(0);
          expect(chunk.text.length).toBeLessThanOrEqual(INTAKE_CHUNK_TARGET_LENGTH);
        }
      }
    }
  });

  it('is deterministic', () => {
    expect(splitIntakeText(INPUT.text)).toEqual(splitIntakeText(INPUT.text));
  });

  it('keeps a short excerpt as one chunk', () => {
    expect(splitIntakeText(`  ${SENTENCE}\n`)).toEqual([{ ordinal: 0, text: SENTENCE, joinBefore: '' }]);
  });

  it('hard-cuts text with no whitespace and still rejoins, without splitting a surrogate pair', () => {
    const token = `${'x'.repeat(INTAKE_CHUNK_TARGET_LENGTH - 1)}\u{1F94A}${'y'.repeat(50)}`;
    const chunks = splitIntakeText(token);
    expect(rejoinIntakeChunks(chunks)).toBe(token);
    expect(chunks[0].text).toBe('x'.repeat(INTAKE_CHUNK_TARGET_LENGTH - 1));
  });
});

describe('validateIntakeInput', () => {
  it('requires source, label, locator and text', () => {
    expect(validateIntakeInput({ ...INPUT, sourceId: ' ' })).toMatch(/registered source/);
    expect(validateIntakeInput({ ...INPUT, documentName: '' })).toMatch(/label/);
    expect(validateIntakeInput({ ...INPUT, locator: '' })).toMatch(/page, section/);
    expect(validateIntakeInput({ ...INPUT, text: ' \n ' })).toMatch(/source text/);
    expect(validateIntakeInput(INPUT)).toBeNull();
  });

  it('refuses a NUL or an unpaired surrogate instead of storing altered text', () => {
    expect(validateIntakeInput({ ...INPUT, text: 'a\u0000b' })).toMatch(/damaged character/);
    expect(validateIntakeInput({ ...INPUT, text: 'a\ud83eb' })).toMatch(/damaged character/);
    expect(validateIntakeInput({ ...INPUT, text: 'a\udd4ab' })).toMatch(/damaged character/);
    expect(validateIntakeInput({ ...INPUT, text: 'a \u{1F94A} b' })).toBeNull();
  });

  it('refuses text over the per-entry bound', () => {
    expect(validateIntakeInput({ ...INPUT, text: 'a'.repeat(INTAKE_MAX_TEXT_LENGTH + 1) })).toMatch(/split it/);
  });
});

describe('submitLibraryTextIntake', () => {
  it('writes one document, then every chunk in order, and nothing else', async () => {
    const { calls, impl } = recordingFetch((_call, index) => (index === 0 ? created : { status: 201 }));
    const result = await submitLibraryTextIntake('https://app.test', INPUT, { fetchImpl: impl });

    const chunks = splitIntakeText(INPUT.text);
    expect(result).toEqual({ ok: true, documentId: 'doc_1', chunkCount: chunks.length });

    expect(calls[0].url).toBe('https://app.test/api/pilot/shadow/library/documents');
    expect(calls[0].body).toEqual({
      source_id: 'source_abc',
      document_name: 'Methods, load monitoring',
      metadata: {
        intake_method: 'manual_text',
        locator: 'pp. 4-6',
        chunk_count: chunks.length,
        text_length: normalizeIntakeText(INPUT.text).length,
      },
    });
    // The document never claims an ingest or review state of its own.
    expect(calls[0].body).not.toHaveProperty('ingest_state');

    const chunkCalls = calls.slice(1);
    expect(chunkCalls).toHaveLength(chunks.length);
    expect(chunkCalls.every((call) => call.url.endsWith('/api/pilot/shadow/library/chunks'))).toBe(true);
    expect(chunkCalls.map((call) => call.body.ordinal)).toEqual(chunks.map((chunk) => chunk.ordinal));
    expect(chunkCalls.every((call) => call.body.document_id === 'doc_1')).toBe(true);
    // What was sent rebuilds what was submitted.
    expect(rejoinIntakeChunks(chunkCalls.map((call) => ({
      text: call.body.text_content as string,
      joinBefore: (call.body.metadata as { join_before: string }).join_before,
    })))).toBe(normalizeIntakeText(INPUT.text));
    expect(chunkCalls.every((call) => (call.body.metadata as { locator: string }).locator === 'pp. 4-6')).toBe(true);

    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(calls.some((call) => call.url.includes('/evidence/review'))).toBe(false);
  });

  it('sends nothing when the input is invalid', async () => {
    const { calls, impl } = recordingFetch(() => created);
    const result = await submitLibraryTextIntake('', { ...INPUT, locator: '' }, { fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports a refused document as nothing saved, with no resume', async () => {
    const { calls, impl } = recordingFetch(() => ({ status: 403 }));
    const result = await submitLibraryTextIntake('', INPUT, { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, resume: null, writtenChunks: 0 });
    expect(result.ok === false && result.message).toMatch(/cannot add text.*Nothing was saved/);
    expect(calls).toHaveLength(1);
  });

  it.each([[500], [0], [201]])('does not claim nothing was saved when the document answer is %s without an id', async (status) => {
    const { calls, impl } = recordingFetch(() => (status === 0 ? 'throw' : { status }));
    const result = await submitLibraryTextIntake('', INPUT, { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, resume: null });
    expect(result.ok === false && result.message).toMatch(/did not confirm.*check Evidence Review/);
    expect(result.ok === false && result.message).not.toMatch(/Nothing was saved/);
    expect(calls).toHaveLength(1);
  });

  it('stops at the first failed chunk, says how far it got, and resumes the same document', async () => {
    const first = recordingFetch((_call, index) => (index === 0 ? created : index === 3 ? 'throw' : { status: 201 }));
    const failed = await submitLibraryTextIntake('', INPUT, { fetchImpl: first.impl });

    const total = splitIntakeText(INPUT.text).length;
    expect(failed.ok).toBe(false);
    if (failed.ok || !failed.resume) throw new Error('expected a resumable failure');
    expect(failed.writtenChunks).toBe(2);
    expect(failed.totalChunks).toBe(total);
    expect(failed.message).toMatch(new RegExp(`Saved 2 of ${total} parts`));
    expect(failed.resume).toMatchObject({ documentId: 'doc_1', nextOrdinal: 2 });
    // Nothing after the failure was attempted.
    expect(first.calls).toHaveLength(4);

    // The retry: no second document, starts at the failed ordinal, and a 409
    // there (the lost request did land) counts as written.
    const second = recordingFetch((_call, index) => (index === 0 ? { status: 409 } : { status: 201 }));
    const finished = await submitLibraryTextIntake('', { ...INPUT, text: 'changed since' }, {
      resume: failed.resume,
      fetchImpl: second.impl,
    });
    expect(finished).toEqual({ ok: true, documentId: 'doc_1', chunkCount: total });
    expect(second.calls.some((call) => call.url.endsWith('/documents'))).toBe(false);
    expect(second.calls.map((call) => call.body.ordinal)).toEqual(
      Array.from({ length: total - 2 }, (_, index) => index + 2),
    );
    const all = [...first.calls.slice(1, 3), ...second.calls];
    expect(rejoinIntakeChunks(all.map((call) => ({
      text: call.body.text_content as string,
      joinBefore: (call.body.metadata as { join_before: string }).join_before,
    })))).toBe(normalizeIntakeText(INPUT.text));
  });

  it('does not treat a 409 on a first attempt as written', async () => {
    const { impl } = recordingFetch((_call, index) => (index === 0 ? created : { status: 409 }));
    const result = await submitLibraryTextIntake('', INPUT, { fetchImpl: impl });
    expect(result).toMatchObject({ ok: false, writtenChunks: 0, resume: { nextOrdinal: 0 } });
  });
});

// ---- RINT-02: the PDF path -------------------------------------------------
// A PDF-sourced excerpt is written through the SAME two routes as a pasted one
// and keeps intake_method 'manual_text' (the only value the completeness gate
// keys on), its origin in a separate key; the excerpt must be words from the
// chosen page; and the reader call sends the file to the reader route only.

const PAGE_TEXT = 'Session RPE tracked training\nload in adolescent boxers  across a twelve week block.';
const NOT_ON_PAGE = 'NOT ON PAGE (test sentence)';

function pdfInput(overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    sourceId: 'source_abc',
    documentName: 'Methods',
    locator: 'p. 12',
    text: PAGE_TEXT,
    pdfPage: { num: 12, text: PAGE_TEXT, notOnPageMessage: NOT_ON_PAGE },
    ...overrides,
  };
}

interface PdfCall {
  url: string;
  body: Record<string, unknown>;
}

function jsonFetch() {
  const calls: PdfCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: PdfCall = { url: String(input), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const isDocument = call.url.endsWith('/library/documents');
    return {
      status: 201,
      ok: true,
      json: async () => (isDocument ? { ok: true, document: { document_id: 'doc_1' } } : { ok: true }),
    } as Response;
  }) as typeof fetch;
  return { calls, impl };
}

describe('isTextFromPage', () => {
  it('accepts the whole page, a trimmed span, and the page with its whitespace changed', () => {
    expect(isTextFromPage(PAGE_TEXT, PAGE_TEXT)).toBe(true);
    expect(isTextFromPage('boxers across a twelve week', PAGE_TEXT)).toBe(true);
    expect(isTextFromPage('  Session RPE   tracked\ntraining ', PAGE_TEXT)).toBe(true);
  });

  it('refuses reworded, retyped or empty text', () => {
    expect(isTextFromPage('Session RPE followed training load', PAGE_TEXT)).toBe(false);
    expect(isTextFromPage('boxers across a thirteen week block', PAGE_TEXT)).toBe(false);
    expect(isTextFromPage('   ', PAGE_TEXT)).toBe(false);
  });
});

describe('pdfPageLocator', () => {
  it('names the page the way a citation does', () => {
    expect(pdfPageLocator(12)).toBe('p. 12');
  });
});

describe('validateIntakeInput with a PDF page', () => {
  it('passes words from the page and refuses anything else with the panel\'s sentence', () => {
    expect(validateIntakeInput(pdfInput())).toBeNull();
    expect(validateIntakeInput(pdfInput({ text: 'boxers across a twelve week' }))).toBeNull();
    expect(validateIntakeInput(pdfInput({ text: 'an invented sentence' }))).toBe(NOT_ON_PAGE);
  });

  it('leaves a pasted entry (no pdfPage) alone', () => {
    expect(validateIntakeInput(pdfInput({ pdfPage: undefined, text: 'an invented sentence' }))).toBeNull();
  });
});

describe('submitLibraryTextIntake with a PDF page', () => {
  it('writes the document and chunks through the RINT-01 routes, intake_method manual_text, origin in its own key', async () => {
    const { calls, impl } = jsonFetch();

    const result = await submitLibraryTextIntake('', pdfInput(), { fetchImpl: impl });

    expect(result).toMatchObject({ ok: true, documentId: 'doc_1' });
    expect(calls.map((call) => call.url)).toEqual([
      '/api/pilot/shadow/library/documents',
      '/api/pilot/shadow/library/chunks',
    ]);
    expect(calls[0].body.metadata).toEqual({
      intake_method: 'manual_text',
      text_origin: 'pdf_page',
      locator: 'p. 12',
      chunk_count: 1,
      text_length: PAGE_TEXT.length,
    });
    expect(calls[1].body.metadata).toMatchObject({ intake_method: 'manual_text', locator: 'p. 12' });
  });

  it('sends nothing at all when the text is not from the page', async () => {
    const { calls, impl } = jsonFetch();

    const result = await submitLibraryTextIntake('', pdfInput({ text: 'an invented sentence' }), { fetchImpl: impl });

    expect(result).toMatchObject({ ok: false, message: NOT_ON_PAGE, resume: null });
    expect(calls).toHaveLength(0);
  });

  it('a pasted entry carries no text_origin', async () => {
    const { calls, impl } = jsonFetch();

    await submitLibraryTextIntake('', pdfInput({ pdfPage: undefined }), { fetchImpl: impl });

    expect(calls[0].body.metadata).not.toHaveProperty('text_origin');
    expect((calls[0].body.metadata as Record<string, unknown>).intake_method).toBe('manual_text');
  });
});

describe('MUST NOT CHANGE: a PDF excerpt is still held to the completeness gate', () => {
  it('uses the exact intake_method value the gate SQL keys on', () => {
    // MANUAL_TEXT_INTAKE_COMPLETE_SQL applies its chunk-count check only when
    // metadata.intake_method = <this literal>; any other value passes the gate
    // unchecked, which would let a half-saved PDF excerpt be indexed.
    const gateLiteral = /intake_method'\s+is distinct from\s+'([^']+)'/.exec(MANUAL_TEXT_INTAKE_COMPLETE_SQL)?.[1];
    expect(gateLiteral).toBe('manual_text');
    expect(INTAKE_METHOD).toBe(gateLiteral);
    expect(TEXT_ORIGIN_PDF_PAGE).not.toBe(INTAKE_METHOD);
  });

  it('writes the document metadata the gate reads: that intake_method and a chunk_count it accepts', async () => {
    const { calls, impl } = jsonFetch();
    await submitLibraryTextIntake('', pdfInput(), { fetchImpl: impl });
    const metadata = calls[0].body.metadata as Record<string, unknown>;

    expect(metadata.intake_method).toBe(/is distinct from\s+'([^']+)'/.exec(MANUAL_TEXT_INTAKE_COMPLETE_SQL)?.[1]);
    const countPattern = /chunk_count'\s+~\s+'([^']+)'/.exec(MANUAL_TEXT_INTAKE_COMPLETE_SQL)?.[1];
    expect(countPattern).toBeDefined();
    expect(new RegExp(countPattern as string).test(String(metadata.chunk_count))).toBe(true);
  });

  it('the file-size limit here is the server\'s', () => {
    expect(PDF_READ_MAX_BYTES).toBe(LIBRARY_PDF_MAX_BYTES);
  });
});

describe('readLibraryPdf', () => {
  function pdfFile(size?: number): File {
    const file = new File(['%PDF-1.7 body'], 'paper.pdf', { type: 'application/pdf' });
    if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
    return file;
  }

  function answer(status: number, json: unknown) {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return { status, ok: status < 400, json: async () => json } as Response;
    }) as typeof fetch;
    return { seen, impl };
  }

  it('posts the file as multipart to the reader route only, and returns the pages', async () => {
    const { seen, impl } = answer(200, {
      ok: true,
      pages: [{ num: 1, text: 'one' }, { num: 2, text: '' }],
    });

    const result = await readLibraryPdf('https://app.test', pdfFile(), { fetchImpl: impl });

    expect(result).toEqual({
      ok: true,
      pages: [{ num: 1, text: 'one' }, { num: 2, text: '' }],
      emptyPageCount: 1,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://app.test/api/pilot/shadow/library/pdf-text');
    expect(seen[0].init?.method).toBe('POST');
    expect(seen[0].init?.body).toBeInstanceOf(FormData);
    expect((seen[0].init?.body as FormData).get('file')).toBeInstanceOf(File);
    // The browser must set the boundary itself.
    expect(seen[0].init?.headers).toBeUndefined();
  });

  it('does not even send a file over the limit', async () => {
    const { seen, impl } = answer(200, { ok: true, pages: [] });

    const result = await readLibraryPdf('', pdfFile(PDF_READ_MAX_BYTES + 1), { fetchImpl: impl });

    expect(result).toEqual({ ok: false, status: 413, serverMessage: null });
    expect(seen).toHaveLength(0);
  });

  it('passes on the route\'s own sentence for a refusal', async () => {
    const { impl } = answer(422, { ok: false, error: 'That PDF could not be read.' });

    expect(await readLibraryPdf('', pdfFile(), { fetchImpl: impl })).toEqual({
      ok: false,
      status: 422,
      serverMessage: 'That PDF could not be read.',
    });
  });

  it('reports status and no message for a refusal without one', async () => {
    const { impl } = answer(403, null);

    expect(await readLibraryPdf('', pdfFile(), { fetchImpl: impl })).toEqual({ ok: false, status: 403, serverMessage: null });
  });

  it('never throws: no answer is status 0, and a malformed page list is a failure', async () => {
    const down = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await readLibraryPdf('', pdfFile(), { fetchImpl: down })).toEqual({ ok: false, status: 0, serverMessage: null });

    const { impl } = answer(200, { ok: true, pages: [{ num: 'one', text: 5 }] });
    expect(await readLibraryPdf('', pdfFile(), { fetchImpl: impl })).toMatchObject({ ok: false });
  });
});

// RINT-05b. The platform owner's entries go to the platform shelf: the document
// AND every chunk carry shelf 'platform' (the chunk route resolves the shelf
// too, and a platform owner's gym-shelf write is refused, D3). A gym entry
// carries no shelf field at all, so gym curators' requests are unchanged.
describe('submitLibraryTextIntake on a shelf', () => {
  it('sends shelf platform on the document and on every chunk', async () => {
    const { calls, impl } = recordingFetch((_call, index) => (index === 0 ? created : { status: 201 }));
    const result = await submitLibraryTextIntake('', { ...INPUT, shelf: 'platform' }, { fetchImpl: impl });
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.body.shelf === 'platform')).toBe(true);
  });

  it('sends no shelf field for the gym shelf, named or not', async () => {
    for (const input of [INPUT, { ...INPUT, shelf: 'gym' as const }]) {
      const { calls, impl } = recordingFetch((_call, index) => (index === 0 ? created : { status: 201 }));
      await submitLibraryTextIntake('', input, { fetchImpl: impl });
      expect(calls.some((call) => 'shelf' in call.body)).toBe(false);
    }
  });

  it('a resumed platform entry finishes on the platform shelf, whatever the form says now', async () => {
    const first = recordingFetch((_call, index) => (index === 0 ? created : index === 2 ? { status: 500 } : { status: 201 }));
    const failed = await submitLibraryTextIntake('', { ...INPUT, shelf: 'platform' }, { fetchImpl: first.impl });
    if (failed.ok || !failed.resume) throw new Error('expected a resumable failure');
    expect(failed.resume.shelf).toBe('platform');

    const second = recordingFetch(() => ({ status: 201 }));
    const finished = await submitLibraryTextIntake('', INPUT, { resume: failed.resume, fetchImpl: second.impl });
    expect(finished.ok).toBe(true);
    expect(second.calls.every((call) => call.body.shelf === 'platform')).toBe(true);
  });

  it('a gym resume token carries no shelf', async () => {
    const { impl } = recordingFetch((_call, index) => (index === 0 ? created : { status: 500 }));
    const failed = await submitLibraryTextIntake('', INPUT, { fetchImpl: impl });
    if (failed.ok || !failed.resume) throw new Error('expected a resumable failure');
    expect(failed.resume).not.toHaveProperty('shelf');
  });

  it('names the shelf a 404 came from', async () => {
    const platform = recordingFetch(() => ({ status: 404 }));
    const onPlatform = await submitLibraryTextIntake('', { ...INPUT, shelf: 'platform' }, { fetchImpl: platform.impl });
    expect(onPlatform.ok ? '' : onPlatform.message).toMatch(/The source was not found on the platform shelf\./);

    const gym = recordingFetch(() => ({ status: 404 }));
    const onGym = await submitLibraryTextIntake('', INPUT, { fetchImpl: gym.impl });
    expect(onGym.ok ? '' : onGym.message).toMatch(/The source was not found in this gym's Library\./);
  });
});
