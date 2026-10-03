'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';
import {
  INTAKE_MAX_TEXT_LENGTH,
  formatIntakeCount,
  isTextFromPage,
  normalizeIntakeText,
  pdfPageLocator,
  readLibraryPdf,
  splitIntakeText,
  submitLibraryTextIntake,
  validateIntakeInput,
  type IntakeInput,
  type IntakeResume,
  type IntakeShelf,
  type PdfPageText,
} from '@/src/client/libraryTextIntake';
import LibrarySourcePicker from './LibrarySourcePicker';

/* RINT-01: manual research text intake.

   The curator picks a source that is already registered on this gym's shelf
   and pastes that source's own words with where they came from. One document
   and its ordered chunks are written through the existing Library routes and
   land pending review. Nothing here approves, verifies or indexes: Evidence
   Review stays the only gate, and the copy says so at both ends.

   The page mounts this only inside its curator block (the sources probe
   succeeded), so a viewer the routes would refuse never sees the form.

   RINT-02: the curator may also read a PDF. The reader route returns its text
   page by page and keeps nothing; "Use this page" puts that page's words in the
   excerpt with its page filled in, and the entry is saved through the SAME path
   as a pasted one (intake_method stays manual_text). The pages live only in
   this component's state, in memory.

   RINT-05b: the page passes shelf 'platform' when the platform owner is signed
   in (OD-2026-10-02-013 1B; OD-2026-10-02-015 D2/D3). The sources it is given
   are then the platform shelf's, and every write names that shelf. Any other
   curator gets no shelf prop and sends exactly what it sent before. */

export interface LibraryTextIntakeSource {
  source_id: string;
  title: string;
}

// RINT-05b words for the platform shelf. Approved by Jason in the RINT-05b
// lane, 2026-10-03 ("Approve all five").
export const SHELF_WORDS = {
  platformNotice: "Adding to the platform shelf. Every gym's SHADOW can cite this once it is approved.",
  platformEmpty: 'No sources are registered on the platform shelf yet. Register one under General Research Intake first.',
};

// RINT-02 words, all in one place so they can be approved or changed together.
// DRAFT wording, awaiting Jason's approval (listed in the pull request).
export const PDF_WORDS = {
  heading: 'Read a PDF',
  help: "Choose the PDF this source's words come from. The app reads it and does not keep it; file the original in the SharePoint Research Archive.",
  limit: 'PDFs up to 10 MB.',
  fileLabel: 'Choose the PDF',
  reading: 'Reading…',
  page: (num: number) => `Page ${num}`,
  usePage: 'Use this page',
  pageEmpty: 'no text',
  noText: 'This PDF has no text the app can read (it may be a scan). Type the excerpt instead.',
  notOnPage: (num: number) => `The excerpt must be words from page ${num}. Trim it; do not retype it.`,
  clear: 'Clear PDF',
  readFailed: 'The PDF could not be read. Try again, or type the excerpt instead.',
  signIn: 'Sign in again, then retry.',
  forbidden: 'Your role cannot read PDFs here.',
};

const EMPTY_DRAFT = { sourceId: '', documentName: '', locator: '', text: '', pdfPageNum: null as number | null };

interface LoadedPdf {
  pages: PdfPageText[];
  emptyPageCount: number;
}

// First words of a page: enough to recognise it in the list.
const PREVIEW_LENGTH = 90;
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH).trimEnd()}…` : flat;
}

function readRefusalMessage(status: number, serverMessage: string | null): string {
  if (serverMessage) return serverMessage;
  if (status === 413) return PDF_WORDS.limit;
  if (status === 401) return PDF_WORDS.signIn;
  if (status === 403) return PDF_WORDS.forbidden;
  return PDF_WORDS.readFailed;
}

type Outcome =
  | { kind: 'saved'; chunkCount: number; documentName: string }
  | { kind: 'incomplete'; message: string }
  | { kind: 'refused'; message: string };

export default function LibraryTextIntakePanel({
  sources,
  shelf = 'gym',
  truncated = false,
}: {
  readonly sources: readonly LibraryTextIntakeSource[];
  readonly shelf?: IntakeShelf;
  readonly truncated?: boolean;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Set while a document exists without all of its chunks. The form is locked
  // until it is finished or deliberately abandoned, so the retry always writes
  // the text that document was created for.
  const [resume, setResume] = useState<IntakeResume | null>(null);
  // RINT-02: the PDF chosen in this session, held in memory only.
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [reading, setReading] = useState(false);
  const [pdfMessage, setPdfMessage] = useState<string | null>(null);

  const { textLength, partCount } = useMemo(() => {
    const length = normalizeIntakeText(draft.text).length;
    return {
      textLength: length,
      partCount: length > 0 && length <= INTAKE_MAX_TEXT_LENGTH ? splitIntakeText(draft.text).length : 0,
    };
  }, [draft.text]);
  const locked = busy || resume !== null;

  // The page the excerpt is tied to, while it is tied to one.
  const linkedPage = useMemo(
    () => (draft.pdfPageNum === null ? null : (pdf?.pages.find((page) => page.num === draft.pdfPageNum) ?? null)),
    [draft.pdfPageNum, pdf],
  );
  const notOnLinkedPage = linkedPage !== null
    && normalizeIntakeText(draft.text).length > 0
    && !isTextFromPage(draft.text, linkedPage.text);

  // What goes to the intake client. pdfPage is present only while the excerpt is
  // linked to a page of the PDF read in this session.
  function intakeInput(): IntakeInput {
    return {
      sourceId: draft.sourceId,
      documentName: draft.documentName,
      locator: draft.locator,
      text: draft.text,
      ...(shelf === 'platform' ? { shelf } : {}),
      ...(linkedPage
        ? { pdfPage: { num: linkedPage.num, text: linkedPage.text, notOnPageMessage: PDF_WORDS.notOnPage(linkedPage.num) } }
        : {}),
    };
  }

  async function handleChoosePdf(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setPdfMessage(null);
    try {
      const result = await readLibraryPdf(apiBase(), file);
      if (!result.ok) {
        setPdfMessage(readRefusalMessage(result.status, result.serverMessage));
        return;
      }
      // A different PDF voids any page link to the old one. Text already in the
      // box stays, unlinked, so nothing the curator did is lost.
      setPdf({ pages: result.pages, emptyPageCount: result.emptyPageCount });
      setDraft((current) => ({ ...current, pdfPageNum: null }));
      if (result.pages.every((page) => page.text === '')) setPdfMessage(PDF_WORDS.noText);
    } finally {
      setReading(false);
    }
  }

  function handleUsePage(page: PdfPageText) {
    setPdfMessage(null);
    setOutcome(null);
    setDraft((current) => ({ ...current, text: page.text, locator: pdfPageLocator(page.num), pdfPageNum: page.num }));
  }

  function handleClearPdf() {
    setPdf(null);
    setPdfMessage(null);
    setDraft((current) => ({ ...current, pdfPageNum: null }));
  }

  async function handleSubmit() {
    if (!resume) {
      const invalid = validateIntakeInput(intakeInput());
      if (invalid) {
        setOutcome({ kind: 'refused', message: invalid });
        return;
      }
    }
    setBusy(true);
    try {
      const result = await submitLibraryTextIntake(apiBase(), intakeInput(), { resume });
      if (result.ok) {
        setOutcome({ kind: 'saved', chunkCount: result.chunkCount, documentName: draft.documentName.trim() });
        setResume(null);
        // The source stays selected: several excerpts from one source is the
        // common case. So does the PDF; the page link does not.
        setDraft((current) => ({ ...EMPTY_DRAFT, sourceId: current.sourceId }));
      } else if (result.resume) {
        setResume(result.resume);
        setOutcome({ kind: 'incomplete', message: result.message });
      } else {
        setOutcome({ kind: 'refused', message: result.message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Add source text to the Library"
      className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)] space-y-[var(--s4)]"
    >
      <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
        Add Source Text
      </h2>
      <p className="t-body text-[color:var(--bone-300)]">
        Paste the source&apos;s own words, exactly as written, and say where they are in it. Do not summarize
        or reword: SHADOW shows this text as the evidence. It is saved as pending and nothing can cite it
        until it is indexed and approved in Evidence Review.
      </p>
      {shelf === 'platform' ? <p className="t-body">{SHELF_WORDS.platformNotice}</p> : null}

      {sources.length === 0 ? (
        <p className="t-muted" role="status">
          {shelf === 'platform'
            ? SHELF_WORDS.platformEmpty
            : 'No sources are registered for this gym yet. Register one under General Research Intake first.'}
        </p>
      ) : (
        <>
          <div className="grid gap-[var(--s3)] md:grid-cols-2">
            <div className="md:col-span-2">
              <LibrarySourcePicker sources={sources} value={draft.sourceId} disabled={locked}
                label="Registered source" placeholder="Choose a source…" truncated={truncated}
                onChange={(sourceId) => setDraft((current) => ({ ...current, sourceId }))} />
            </div>
            <div className="field md:col-span-2 space-y-[var(--s2)]">
              <span className="t-label">{PDF_WORDS.heading}</span>
              <p className="t-muted">{PDF_WORDS.help} {PDF_WORDS.limit}</p>
              <div className="flex flex-wrap items-center gap-[var(--s3)]">
                <input type="file" accept="application/pdf" aria-label={PDF_WORDS.fileLabel} className="input"
                  disabled={locked || reading}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    input.value = '';
                    void handleChoosePdf(file);
                  }} />
                {pdf && !reading ? (
                  <button type="button" className="btn btn--ghost" disabled={locked} onClick={handleClearPdf}>
                    {PDF_WORDS.clear}
                  </button>
                ) : null}
              </div>
              {reading ? <p className="t-muted" role="status">{PDF_WORDS.reading}</p> : null}
              {pdfMessage ? <p className="t-body" role="alert">{pdfMessage}</p> : null}
              {pdf && pdf.emptyPageCount < pdf.pages.length ? (
                <ul aria-label={PDF_WORDS.heading} className="max-h-72 overflow-y-auto space-y-[var(--s2)]">
                  {pdf.pages.map((page) => (
                    <li key={page.num} className="flex items-start gap-[var(--s3)]">
                      <div className="min-w-0 flex-1">
                        <span className="t-label">{PDF_WORDS.page(page.num)}</span>{' '}
                        <span className="t-muted">{page.text ? previewOf(page.text) : PDF_WORDS.pageEmpty}</span>
                      </div>
                      {page.text ? (
                        <button type="button" className="btn btn--ghost" disabled={locked}
                          aria-label={`${PDF_WORDS.usePage}: ${PDF_WORDS.page(page.num)}`}
                          onClick={() => handleUsePage(page)}>
                          {PDF_WORDS.usePage}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <label className="field">
              <span className="t-label">Excerpt label</span>
              <input aria-label="Excerpt label" className="input" value={draft.documentName} disabled={locked}
                placeholder="e.g. Methods, load monitoring"
                onChange={(event) => setDraft((current) => ({ ...current, documentName: event.target.value }))} />
            </label>
            <label className="field">
              <span className="t-label">Where in the source</span>
              <input aria-label="Where in the source" className="input" value={draft.locator} disabled={locked}
                placeholder="e.g. pp. 4-6, section 2.3"
                onChange={(event) => setDraft((current) => ({ ...current, locator: event.target.value }))} />
            </label>
            <label className="field md:col-span-2">
              <span className="t-label">Source text</span>
              <textarea aria-label="Source text" className="textarea w-full" rows={10} value={draft.text} disabled={locked}
                onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))} />
            </label>
          </div>

          {notOnLinkedPage && linkedPage ? (
            <p className="t-body" role="alert">{PDF_WORDS.notOnPage(linkedPage.num)}</p>
          ) : null}

          <p className="t-muted">
            {formatIntakeCount(textLength)} of {formatIntakeCount(INTAKE_MAX_TEXT_LENGTH)} characters
            {partCount > 0 ? ` · saved as ${partCount} ${partCount === 1 ? 'part' : 'parts'}, in order` : ''}
          </p>

          <div className="flex flex-wrap items-center gap-[var(--s4)]">
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSubmit()}>
              {busy ? 'Saving…' : resume ? 'Finish saving' : 'Save to Library as pending'}
            </button>
            {resume && !busy ? (
              <button type="button" className="btn btn--ghost"
                onClick={() => {
                  setResume(null);
                  setOutcome({
                    kind: 'refused',
                    message: 'Left incomplete. The partial entry is still listed in Evidence Review. It cannot be indexed or approved there; reject it, then enter the text again.',
                  });
                }}>
                Leave it incomplete
              </button>
            ) : null}
          </div>
        </>
      )}

      {outcome?.kind === 'saved' ? (
        <div role="status" className="space-y-[var(--s2)]">
          <span className="badge badge--monitor"><i aria-hidden="true">◉</i>Pending Review</span>
          <p className="t-body">
            Saved &ldquo;{outcome.documentName}&rdquo; in {outcome.chunkCount}{' '}
            {outcome.chunkCount === 1 ? 'part' : 'parts'}. SHADOW cannot cite it yet. Next:{' '}
            <Link href="/evidence" className="underline">Evidence Review</Link> to index and approve it.
          </p>
        </div>
      ) : null}
      {outcome?.kind === 'incomplete' ? (
        <div role="alert" className="space-y-[var(--s2)]">
          <span className="badge badge--restricted"><i aria-hidden="true">▲</i>Incomplete</span>
          <p className="t-body">{outcome.message}</p>
        </div>
      ) : null}
      {outcome?.kind === 'refused' ? <p className="t-body" role="alert">{outcome.message}</p> : null}
    </section>
  );
}
