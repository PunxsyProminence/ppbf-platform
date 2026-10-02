'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';
import {
  INTAKE_MAX_TEXT_LENGTH,
  normalizeIntakeText,
  splitIntakeText,
  submitLibraryTextIntake,
  validateIntakeInput,
  type IntakeResume,
} from '@/src/client/libraryTextIntake';

/* RINT-01: manual research text intake.

   The curator picks a source that is already registered on this gym's shelf
   and pastes that source's own words with where they came from. One document
   and its ordered chunks are written through the existing Library routes and
   land pending review. Nothing here approves, verifies or indexes: Evidence
   Review stays the only gate, and the copy says so at both ends.

   The page mounts this only inside its curator block (the sources probe
   succeeded), so a viewer the routes would refuse never sees the form. */

export interface LibraryTextIntakeSource {
  source_id: string;
  title: string;
}

const EMPTY_DRAFT = { sourceId: '', documentName: '', locator: '', text: '' };

type Outcome =
  | { kind: 'saved'; chunkCount: number; documentName: string }
  | { kind: 'incomplete'; message: string }
  | { kind: 'refused'; message: string };

export default function LibraryTextIntakePanel({ sources }: { readonly sources: readonly LibraryTextIntakeSource[] }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Set while a document exists without all of its chunks. The form is locked
  // until it is finished or deliberately abandoned, so the retry always writes
  // the text that document was created for.
  const [resume, setResume] = useState<IntakeResume | null>(null);

  const { textLength, partCount } = useMemo(() => {
    const length = normalizeIntakeText(draft.text).length;
    return {
      textLength: length,
      partCount: length > 0 && length <= INTAKE_MAX_TEXT_LENGTH ? splitIntakeText(draft.text).length : 0,
    };
  }, [draft.text]);
  const locked = busy || resume !== null;

  async function handleSubmit() {
    if (!resume) {
      const invalid = validateIntakeInput(draft);
      if (invalid) {
        setOutcome({ kind: 'refused', message: invalid });
        return;
      }
    }
    setBusy(true);
    try {
      const result = await submitLibraryTextIntake(apiBase(), draft, { resume });
      if (result.ok) {
        setOutcome({ kind: 'saved', chunkCount: result.chunkCount, documentName: draft.documentName.trim() });
        setResume(null);
        // The source stays selected: several excerpts from one source is the
        // common case.
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

      {sources.length === 0 ? (
        <p className="t-muted" role="status">
          No sources are registered for this gym yet. Register one under General Research Intake first.
        </p>
      ) : (
        <>
          <div className="grid gap-[var(--s3)] md:grid-cols-2">
            <label className="field md:col-span-2">
              <span className="t-label">Registered source</span>
              <select aria-label="Registered source" className="select" value={draft.sourceId} disabled={locked}
                onChange={(event) => setDraft((current) => ({ ...current, sourceId: event.target.value }))}>
                <option value="">Choose a source…</option>
                {sources.map((source) => (
                  <option key={source.source_id} value={source.source_id}>{source.title}</option>
                ))}
              </select>
            </label>
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

          <p className="t-muted">
            {textLength.toLocaleString('en-US')} of {INTAKE_MAX_TEXT_LENGTH.toLocaleString('en-US')} characters
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
                    message: 'Left incomplete. The partial entry is still listed in Evidence Review, where it can be rejected.',
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
