import {
  INTAKE_CHUNK_TARGET_LENGTH,
  INTAKE_MAX_TEXT_LENGTH,
  normalizeIntakeText,
  rejoinIntakeChunks,
  splitIntakeText,
  submitLibraryTextIntake,
  validateIntakeInput,
  type IntakeInput,
} from './libraryTextIntake';

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
