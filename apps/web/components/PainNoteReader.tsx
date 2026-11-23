'use client';

import { useState } from 'react';

import { PAIN_NOTE_ADMIN_ONLY_LINE } from '@/components/PainReportsPanel';
import { apiBase } from '@/lib/apiBase';

/** The panel's own words when the note could not be read; never the browser's. */
export const PAIN_NOTE_READ_FAILED = 'Could not load the note. Try again.';

/**
 * Whether an escalation was filed from a pain report's note (painReportNotes.ts
 * filePainNoteEscalation): its metadata carries the channel and the near miss it points at, and
 * nothing of the note itself.
 */
export function painNoteEscalationTarget(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || metadata.channel !== 'pain_report_note') return null;
  const id = metadata.near_miss_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

type ReadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'shown'; note: string | null; adminOnly: boolean };

/**
 * "Read the note" on a pain-note escalation (DR-25; Overwatch Q12 A on #2139). The note is read
 * only when pressed, from the pain list's own gate and mask (the note route), so a coach never
 * receives a note held for admins; an admin's copy of one says so under the words.
 */
export default function PainNoteReader({ nearMissId }: { readonly nearMissId: string }) {
  const [state, setState] = useState<ReadState>({ kind: 'idle' });

  const read = async () => {
    setState({ kind: 'loading' });
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/pain-reports/${encodeURIComponent(nearMissId)}/note`,
        { method: 'GET', credentials: 'include', cache: 'no-store' },
      );
      if (!response.ok) throw new Error(PAIN_NOTE_READ_FAILED);
      const body = (await response.json().catch(() => null)) as { note?: unknown; noteAdminOnly?: unknown } | null;
      if (
        !body
        || !(body.note === null || typeof body.note === 'string')
        || !(body.noteAdminOnly === undefined || typeof body.noteAdminOnly === 'boolean')
      ) {
        throw new Error(PAIN_NOTE_READ_FAILED);
      }
      setState({ kind: 'shown', note: body.note, adminOnly: body.noteAdminOnly === true });
    } catch {
      setState({ kind: 'failed' });
    }
  };

  if (state.kind === 'shown') {
    return (
      <div className="mt-[var(--s2)]">
        <p className="font-mono uppercase tracking-[0.08em] text-[length:var(--t-md)] text-[color:var(--brass-300)]">
          Athlete&apos;s note
        </p>
        {state.note ? (
          <p className="whitespace-pre-wrap break-words text-[length:var(--t-md)] text-[color:var(--bone-200)]">{state.note}</p>
        ) : (
          <p className="text-[length:var(--t-md)] text-[color:var(--bone-400)]">No note</p>
        )}
        {state.note && state.adminOnly ? (
          <p className="text-[length:var(--t-md)] text-[color:var(--restricted-ink)]">{PAIN_NOTE_ADMIN_ONLY_LINE}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-[var(--s2)] flex flex-col items-start gap-[var(--s2)]">
      <button type="button" className="btn btn--ghost" disabled={state.kind === 'loading'} onClick={() => void read()}>
        {state.kind === 'loading' ? 'Loading the note…' : 'Read the note'}
      </button>
      {state.kind === 'failed' ? (
        <p role="alert" className="text-[length:var(--t-md)] text-[color:var(--restricted-ink)]">{PAIN_NOTE_READ_FAILED}</p>
      ) : null}
    </div>
  );
}
