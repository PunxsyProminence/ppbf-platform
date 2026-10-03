/**
 * @jest-environment jsdom
 */

// RINT-01. What these pin at the screen: a valid entry writes one document and
// then its chunks and ends on a pending-review message that points at Evidence
// Review; the evidence review route is never called from here; an incomplete
// save is reported as incomplete, locks the form, and Finish saving completes
// the SAME document; and with no registered source there is no form at all.

import { act, fireEvent, render, screen } from '@testing-library/react';

import LibraryTextIntakePanel, { PDF_WORDS } from './LibraryTextIntakePanel';
import { splitIntakeText } from '@/src/client/libraryTextIntake';

const SOURCES = [
  { source_id: 'source_a', title: 'RPE reliability in adolescents' },
  { source_id: 'source_b', title: 'Hydration position stand' },
];

const TEXT = Array.from({ length: 12 }, (_, index) =>
  `${index + 1}. Session RPE tracked training load in adolescent boxers across a twelve week block, and the agreement held.`,
).join('\n\n');

interface Call {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
}

function installFetch(respond: (call: Call, index: number) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const answer = respond(call, calls.length - 1);
    return { status: answer.status, ok: answer.status < 400, json: async () => answer.json ?? {} } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const created = { status: 201, json: { ok: true, document: { document_id: 'doc_9' } } };

function fillForm() {
  fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_b' } });
  fireEvent.change(screen.getByLabelText('Excerpt label'), { target: { value: 'Methods' } });
  fireEvent.change(screen.getByLabelText('Where in the source'), { target: { value: 'pp. 4-6' } });
  fireEvent.change(screen.getByLabelText('Source text'), { target: { value: TEXT } });
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('LibraryTextIntakePanel', () => {
  it('saves one document then its chunks and ends on pending review, never calling evidence review', async () => {
    const calls = installFetch((_call, index) => (index === 0 ? created : { status: 201 }));
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await click('Save to Library as pending');

    const total = splitIntakeText(TEXT).length;
    expect(total).toBeGreaterThan(1);
    expect(calls).toHaveLength(1 + total);
    expect(calls[0].url).toContain('/api/pilot/shadow/library/documents');
    expect(calls[0].body).toMatchObject({ source_id: 'source_b', document_name: 'Methods' });
    expect(calls.slice(1).map((call) => call.body.ordinal)).toEqual(Array.from({ length: total }, (_, index) => index));
    expect(calls.some((call) => call.url.includes('/evidence/review'))).toBe(false);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Pending Review');
    expect(status.textContent).toContain(`in ${total} parts`);
    expect(status.textContent).toContain('SHADOW cannot cite it yet');
    expect(screen.getByRole('link', { name: 'Evidence Review' }).getAttribute('href')).toBe('/evidence');

    // Cleared for the next excerpt, same source kept.
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('Registered source') as HTMLSelectElement).value).toBe('source_b');
  });

  it('sends nothing and says why when a field is missing', async () => {
    const calls = installFetch(() => created);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    fireEvent.change(screen.getByLabelText('Where in the source'), { target: { value: '' } });
    await click('Save to Library as pending');

    expect(calls).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/page, section or timestamp/);
  });

  it('reports an incomplete save, locks the form, and finishes the same document on retry', async () => {
    let failing = true;
    const calls = installFetch((call, index) => {
      if (call.url.includes('/documents')) return created;
      if (failing && index === 2) return { status: 500 };
      return { status: 201 };
    });
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await click('Save to Library as pending');

    const total = splitIntakeText(TEXT).length;
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Incomplete');
    expect(alert.textContent).toContain(`Saved 1 of ${total} parts`);
    // No success message alongside it.
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).value).toBe(TEXT);

    failing = false;
    const before = calls.length;
    await click('Finish saving');

    const retry = calls.slice(before);
    expect(retry.some((call) => call.url.includes('/documents'))).toBe(false);
    expect(retry.every((call) => call.body.document_id === 'doc_9')).toBe(true);
    expect(retry.map((call) => call.body.ordinal)).toEqual(Array.from({ length: total - 1 }, (_, index) => index + 1));
    expect(screen.getByRole('status').textContent).toContain(`in ${total} parts`);
    expect(screen.queryByRole('button', { name: 'Finish saving' })).toBeNull();
  });

  it('lets the curator leave an incomplete entry and says where it still is', async () => {
    installFetch((call) => (call.url.includes('/documents') ? created : { status: 500 }));
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await click('Save to Library as pending');
    await click('Leave it incomplete');

    expect(screen.getByRole('alert').textContent).toContain('still listed in Evidence Review');
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Save to Library as pending' })).toBeTruthy();
  });

  it('shows no form when the gym has no registered source', () => {
    render(<LibraryTextIntakePanel sources={[]} />);
    expect(screen.queryByLabelText('Source text')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Register one under General Research Intake first');
  });
});

// ---- RINT-02: reading a PDF -------------------------------------------------
// What these pin at the screen: choosing a PDF lists its pages (a page with no
// text has no button); "Use this page" fills the excerpt and its page; a
// trimmed span saves through the same two routes with intake_method
// manual_text; retyped words are refused with nothing sent; a refusal from the
// reader is shown, not swallowed; and the PDF is never sent anywhere but the
// reader route.


const PAGE_ONE = 'First page, about hydration and weight.';
const PAGE_TWO = 'Session RPE tracked training load in adolescent boxers across a twelve week block, and the agreement held.';

interface PdfCall {
  url: string;
  isForm: boolean;
  body: Record<string, unknown> | null;
}

function installPdfFetch(readerAnswer: { status: number; json?: unknown }) {
  const calls: PdfCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const isForm = init?.body instanceof FormData;
    calls.push({ url, isForm, body: isForm ? null : JSON.parse(String(init?.body)) });
    if (url.endsWith('/library/pdf-text')) {
      return { status: readerAnswer.status, ok: readerAnswer.status < 400, json: async () => readerAnswer.json ?? {} } as Response;
    }
    const isDocument = url.endsWith('/library/documents');
    return {
      status: 201,
      ok: true,
      json: async () => (isDocument ? { ok: true, document: { document_id: 'doc_pdf' } } : { ok: true }),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const READER_OK = {
  status: 200,
  json: {
    ok: true,
    page_count: 3,
    empty_page_count: 1,
    pages: [
      { num: 1, text: PAGE_ONE },
      { num: 2, text: PAGE_TWO },
      { num: 3, text: '' },
    ],
  },
};

async function choosePdf() {
  const file = new File(['%PDF-1.7 body'], 'paper.pdf', { type: 'application/pdf' });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(PDF_WORDS.fileLabel), { target: { files: [file] } });
  });
}

describe('LibraryTextIntakePanel: reading a PDF (RINT-02)', () => {
  it('lists the pages, gives a page with no text no button, and sends the file only to the reader route', async () => {
    const calls = installPdfFetch(READER_OK);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    await choosePdf();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/pilot/shadow/library/pdf-text');
    expect(calls[0].isForm).toBe(true);
    expect(screen.getByText(PDF_WORDS.page(1))).toBeTruthy();
    expect(screen.getByText(PDF_WORDS.page(3))).toBeTruthy();
    expect(screen.getByText(PDF_WORDS.pageEmpty)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Use this page/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: `${PDF_WORDS.usePage}: ${PDF_WORDS.page(3)}` })).toBeNull();
  });

  it('puts the page in the excerpt with its page filled in, and saves it as manual_text with its origin', async () => {
    const calls = installPdfFetch(READER_OK);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fireEvent.change(screen.getByLabelText('Registered source'), { target: { value: 'source_a' } });
    fireEvent.change(screen.getByLabelText('Excerpt label'), { target: { value: 'Agreement' } });
    await choosePdf();
    await click(`${PDF_WORDS.usePage}: ${PDF_WORDS.page(2)}`);

    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).value).toBe(PAGE_TWO);
    expect((screen.getByLabelText('Where in the source') as HTMLInputElement).value).toBe('p. 2');

    await click('Save to Library as pending');

    const writes = calls.slice(1);
    expect(writes.map((call) => call.url.split('/library/')[1])).toEqual(['documents', 'chunks']);
    expect(writes.every((call) => !call.isForm)).toBe(true);
    expect(writes[0].body).toMatchObject({
      source_id: 'source_a',
      document_name: 'Agreement',
      metadata: { intake_method: 'manual_text', text_origin: 'pdf_page', locator: 'p. 2' },
    });
    expect(writes[1].body).toMatchObject({ text_content: PAGE_TWO });
    expect(calls.some((call) => call.url.includes('/evidence/review'))).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Pending Review');
    // The PDF stays for the next excerpt; the page link does not.
    expect(screen.getAllByRole('button', { name: /^Use this page/ })).toHaveLength(2);
    expect((screen.getByLabelText('Source text') as HTMLTextAreaElement).value).toBe('');
  });

  it('saves a trimmed span of the page', async () => {
    const calls = installPdfFetch(READER_OK);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await choosePdf();
    await click(`${PDF_WORDS.usePage}: ${PDF_WORDS.page(2)}`);
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'adolescent boxers across a twelve week block' } });
    expect(screen.queryByText(PDF_WORDS.notOnPage(2))).toBeNull();
    await click('Save to Library as pending');

    expect(calls[1].body).toMatchObject({ metadata: { intake_method: 'manual_text', text_origin: 'pdf_page' } });
    expect(calls[2].body).toMatchObject({ text_content: 'adolescent boxers across a twelve week block' });
  });

  it('refuses retyped words, says so, and sends nothing', async () => {
    const calls = installPdfFetch(READER_OK);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await choosePdf();
    await click(`${PDF_WORDS.usePage}: ${PDF_WORDS.page(2)}`);
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'Session RPE followed load in teen boxers.' } });

    expect(screen.getAllByText(PDF_WORDS.notOnPage(2)).length).toBeGreaterThan(0);
    await click('Save to Library as pending');

    expect(calls).toHaveLength(1);
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent === PDF_WORDS.notOnPage(2))).toBe(true);
  });

  it('Clear PDF drops the pages and the link, so pasted text saves without an origin', async () => {
    const calls = installPdfFetch(READER_OK);
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    fillForm();
    await choosePdf();
    await click(`${PDF_WORDS.usePage}: ${PDF_WORDS.page(2)}`);
    await click(PDF_WORDS.clear);

    expect(screen.queryByText(PDF_WORDS.page(2))).toBeNull();
    fireEvent.change(screen.getByLabelText('Source text'), { target: { value: 'Typed afterwards, not on any page.' } });
    await click('Save to Library as pending');

    expect(calls[1].body?.metadata).not.toHaveProperty('text_origin');
    expect(calls[1].body?.metadata).toMatchObject({ intake_method: 'manual_text' });
  });

  it('says a scan has no readable text and offers no pages', async () => {
    installPdfFetch({ status: 200, json: { ok: true, page_count: 1, empty_page_count: 1, pages: [{ num: 1, text: '' }] } });
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    await choosePdf();

    expect(screen.getByRole('alert').textContent).toBe(PDF_WORDS.noText);
    expect(screen.queryByText(PDF_WORDS.page(1))).toBeNull();
  });

  it.each([
    [413, null, PDF_WORDS.limit],
    [401, null, PDF_WORDS.signIn],
    [403, null, PDF_WORDS.forbidden],
    [500, null, PDF_WORDS.readFailed],
    [422, { ok: false, error: 'That PDF could not be read.' }, 'That PDF could not be read.'],
  ])('shows a %s from the reader instead of swallowing it', async (status, json, expected) => {
    installPdfFetch({ status, json });
    render(<LibraryTextIntakePanel sources={SOURCES} />);
    await choosePdf();

    expect(screen.getByRole('alert').textContent).toBe(expected);
    expect(screen.queryByRole('button', { name: /^Use this page/ })).toBeNull();
  });

  it('shows no PDF reader when the gym has no registered source', () => {
    render(<LibraryTextIntakePanel sources={[]} />);
    expect(screen.queryByLabelText(PDF_WORDS.fileLabel)).toBeNull();
  });
});
