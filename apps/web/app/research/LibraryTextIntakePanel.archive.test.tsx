/**
 * @jest-environment jsdom
 */

// Lane L57 (issue #345). What these pin at the screen: where filing is ON for
// the shelf, a PDF read in the panel can be filed in the Research Archive, and
// an excerpt saved from one of its pages is linked to that filed original only
// when it is the same file (same hash) for the same source. Filing that fails
// leaves excerpts saving as before, unlinked, and says so (Overwatch Q3). Where
// filing is OFF there is no box and nothing is filed.

import { act, fireEvent, render, screen } from '@testing-library/react';

import { FILING_WORDS } from './ArchiveFilingBox';
import LibraryTextIntakePanel, { ARCHIVE_LINK_WORDS, PDF_WORDS } from './LibraryTextIntakePanel';

const SOURCES = [
  { source_id: 'source_a', title: 'RPE reliability in adolescents' },
  { source_id: 'source_b', title: 'Hydration position stand' },
];
const PAGE_TWO = 'Session RPE agreed with heart-rate load in twelve adolescent boxers across the block.';
const READ_SHA = 'a'.repeat(64);

interface Call {
  url: string;
  method: string;
  form: FormData | null;
  body: Record<string, unknown> | null;
}

function filedAnswer(overrides: Record<string, unknown> = {}) {
  return {
    status: 201,
    json: {
      ok: true,
      status: 'filed',
      archived_original: {
        archived_original_id: 'arc_11111111-2222-3333-4444-555555555555',
        source_id: 'source_a',
        archive_domain_code: 'R19',
        archive_filename: 'paper--aaaaaaaaaaaa.pdf',
        web_url: 'https://example.sharepoint.com/x.pdf',
        content_sha256: READ_SHA,
        version_kind: 'unknown',
        ...overrides,
      },
    },
  };
}

function installFetch(options: { archive: 'on' | 'off'; filing?: { status: number; json?: unknown } }) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ url, method, form, body: !form && init?.body ? JSON.parse(String(init.body)) : null });
    const answer = (status: number, json: unknown) => ({ status, ok: status < 400, json: async () => json }) as Response;
    if (url.includes('/library/archive-original') && method === 'GET') return answer(200, { ok: true, archive: options.archive });
    if (url.endsWith('/library/pdf-text')) {
      return answer(200, {
        ok: true,
        page_count: 2,
        empty_page_count: 0,
        content_sha256: READ_SHA,
        pages: [
          { num: 1, text: 'Title page.' },
          { num: 2, text: PAGE_TWO },
        ],
      });
    }
    if (url.endsWith('/library/archive-original')) {
      const filing = options.filing ?? filedAnswer();
      return answer(filing.status, filing.json ?? {});
    }
    if (url.endsWith('/library/documents')) return answer(201, { ok: true, document: { document_id: 'doc_1' } });
    return answer(201, { ok: true });
  }) as unknown as typeof fetch;
  return calls;
}

async function renderPanel() {
  await act(async () => {
    render(<LibraryTextIntakePanel sources={SOURCES} />);
  });
}

async function choosePdf() {
  const file = new File(['%PDF-1.7 body'], 'paper.pdf', { type: 'application/pdf' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(PDF_WORDS.fileLabel), { target: { files: [file] } });
  });
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function saveExcerptFromPageTwo() {
  fireEvent.change(screen.getByLabelText('Excerpt label'), { target: { value: 'Agreement' } });
  await click(`${PDF_WORDS.usePage}: ${PDF_WORDS.page(2)}`);
  await click('Save to Library as pending');
}

function paragraphStartingWith(text: string) {
  return screen.queryByText((_content, element) => element?.tagName === 'P' && (element.textContent ?? '').startsWith(text));
}

function documentWrite(calls: Call[]) {
  return calls.find((call) => call.url.endsWith('/library/documents'));
}

describe('LibraryTextIntakePanel: filing the original (lane L57)', () => {
  it('files the PDF with its provenance, and links an excerpt from it', async () => {
    const calls = installFetch({ archive: 'on' });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();

    expect(screen.getByText(PDF_WORDS.helpFiling, { exact: false })).toBeTruthy();
    expect(screen.getByText(FILING_WORDS.notYet)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(FILING_WORDS.provider), { target: { value: 'Penn State University Libraries' } });
    fireEvent.change(screen.getByLabelText(FILING_WORDS.version), { target: { value: 'version_of_record' } });
    fireEvent.change(screen.getByLabelText(FILING_WORDS.acquiredAt), { target: { value: '2026-10-01' } });
    await click(FILING_WORDS.file);

    const filing = calls.find((call) => call.url.endsWith('/library/archive-original') && call.method === 'POST');
    expect(filing?.form?.get('source_id')).toBe('source_a');
    expect(filing?.form?.get('acquisition_provider')).toBe('Penn State University Libraries');
    expect(filing?.form?.get('acquisition_channel')).toBe('library_database');
    expect(filing?.form?.get('version_kind')).toBe('version_of_record');
    expect(filing?.form?.get('acquired_at')).toBe('2026-10-01');
    expect(filing?.form?.get('file')).toBeInstanceOf(File);
    expect(paragraphStartingWith(FILING_WORDS.filed('R19', 'paper--aaaaaaaaaaaa.pdf'))).toBeTruthy();
    expect(screen.getByRole('link', { name: FILING_WORDS.open }).getAttribute('href')).toBe('https://example.sharepoint.com/x.pdf');
    expect(screen.getByText(FILING_WORDS.linked)).toBeTruthy();

    await saveExcerptFromPageTwo();

    expect(documentWrite(calls)?.body).toMatchObject({
      source_id: 'source_a',
      archived_original_id: 'arc_11111111-2222-3333-4444-555555555555',
      metadata: { text_origin: 'pdf_page' },
    });
    expect(screen.getByText(ARCHIVE_LINK_WORDS.saved)).toBeTruthy();
  });

  it('does not link an excerpt to a filed PDF whose bytes differ from the one read', async () => {
    const calls = installFetch({ archive: 'on', filing: filedAnswer({ content_sha256: 'b'.repeat(64) }) });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await click(FILING_WORDS.file);
    await saveExcerptFromPageTwo();

    expect(screen.getByText(FILING_WORDS.differentFile)).toBeTruthy();
    expect(documentWrite(calls)?.body).not.toHaveProperty('archived_original_id');
    expect(screen.queryByText(ARCHIVE_LINK_WORDS.saved)).toBeNull();
  });

  it('does not link once the excerpt is for another source than the one filed', async () => {
    const calls = installFetch({ archive: 'on' });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await click(FILING_WORDS.file);
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_b' } });

    expect(screen.getByText(FILING_WORDS.otherSource)).toBeTruthy();
    await saveExcerptFromPageTwo();

    expect(documentWrite(calls)?.body).toMatchObject({ source_id: 'source_b' });
    expect(documentWrite(calls)?.body).not.toHaveProperty('archived_original_id');
  });

  it('when filing fails, says so plainly, and the excerpt still saves unlinked', async () => {
    const calls = installFetch({
      archive: 'on',
      filing: { status: 502, json: { error: 'The Research Archive did not confirm the filing. Try again with the same file.' } },
    });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await click(FILING_WORDS.file);

    // A 502 may have landed: never "Not filed".
    expect(screen.getByRole('alert').textContent).toBe(
      FILING_WORDS.mayNotBeFiled('The Research Archive did not confirm the filing. Try again with the same file.'),
    );
    await saveExcerptFromPageTwo();

    expect(documentWrite(calls)?.body).not.toHaveProperty('archived_original_id');
    expect(screen.getByRole('status').textContent).toContain('Pending Review');
  });

  it('a refusal is "Not filed", and says why', async () => {
    installFetch({ archive: 'on', filing: { status: 409, json: { error: 'Classify this source first.', code: 'SOURCE_NOT_CLASSIFIED' } } });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await click(FILING_WORDS.file);

    expect(screen.getByRole('alert').textContent).toBe(FILING_WORDS.notFiled('Classify this source first.'));
  });

  it('the same PDF filed before is "already filed", and its excerpts are linked', async () => {
    const calls = installFetch({ archive: 'on', filing: { status: 200, json: { ...filedAnswer().json, status: 'already_filed' } } });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await click(FILING_WORDS.file);

    expect(paragraphStartingWith(FILING_WORDS.alreadyFiled('R19', 'paper--aaaaaaaaaaaa.pdf'))).toBeTruthy();
    expect(paragraphStartingWith(FILING_WORDS.filed('R19', 'paper--aaaaaaaaaaaa.pdf'))).toBeNull();
    await saveExcerptFromPageTwo();
    expect(documentWrite(calls)?.body).toMatchObject({ archived_original_id: 'arc_11111111-2222-3333-4444-555555555555' });
  });

  it('a second PDF starts unfiled, and a late answer for the first is not taken for it', async () => {
    let answerFirst: (value: Response) => void = () => undefined;
    const calls = installFetch({ archive: 'on' });
    const plain = global.fetch;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/library/archive-original') && init?.method === 'POST') {
        calls.push({ url: String(input), method: 'POST', form: init.body as FormData, body: null });
        return new Promise<Response>((resolve) => {
          answerFirst = resolve;
        });
      }
      return plain(input, init);
    }) as unknown as typeof fetch;
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: FILING_WORDS.file }));
    });
    await choosePdf();
    await act(async () => {
      answerFirst({ status: 201, ok: true, json: async () => filedAnswer().json } as Response);
    });

    expect(paragraphStartingWith(FILING_WORDS.filed('R19', 'paper--aaaaaaaaaaaa.pdf'))).toBeNull();
    expect(screen.getByRole('button', { name: FILING_WORDS.file })).toBeTruthy();
    expect(screen.getByText(FILING_WORDS.notYet)).toBeTruthy();
    await saveExcerptFromPageTwo();
    expect(documentWrite(calls)?.body).not.toHaveProperty('archived_original_id');
  });

  it('asks for the source before filing, and files nothing', async () => {
    const calls = installFetch({ archive: 'on' });
    await renderPanel();
    await choosePdf();
    await click(FILING_WORDS.file);

    expect(screen.getByRole('alert').textContent).toBe(FILING_WORDS.chooseSource);
    expect(calls.some((call) => call.url.endsWith('/library/archive-original') && call.method === 'POST')).toBe(false);
  });

  it('where filing is off, shows no box, keeps the old help, and files nothing', async () => {
    const calls = installFetch({ archive: 'off' });
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    await choosePdf();

    expect(screen.queryByRole('group', { name: FILING_WORDS.heading })).toBeNull();
    expect(screen.getByText(PDF_WORDS.help, { exact: false })).toBeTruthy();
    await saveExcerptFromPageTwo();

    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url.split('/library/')[1])).toEqual([
      'pdf-text',
      'documents',
      'chunks',
    ]);
    expect(documentWrite(calls)?.body).not.toHaveProperty('archived_original_id');
  });
});
