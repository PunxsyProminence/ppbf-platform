'use client';

import { useCallback, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// A coach's physical capacity notes for one athlete (module 013's slice,
// OD-2026-10-08-002): what a coach saw of the athlete's capacity, in the
// coach's own words, dated and kept as history newest first. Rendered closed
// under the selected athlete on the coach dashboard; it reads nothing until a
// coach opens it.
//
// WORDS, NOT NUMBERS. The panel shows the text the server stored and sends the
// text the coach typed. Nothing here parses, counts, grades or colours a note:
// module 013's boundaries (no automatic safety-gate changes, no invented
// sensor readings, no board rows) and OD-2026-09-21-001 (in-app AI never
// diagnoses) hold by there being nothing to compute. The author is shown by
// NAME (the server's author_name); the panel never sees an account id.
//
// HISTORY. A note is never edited. The coach who wrote one may withdraw it
// (`own` from the server); it leaves the list, the server keeps the row.
//
// Authorization is the route's: this panel sends the form and shows what the
// server answers. Whether the athlete or family sees these notes is NOT
// decided; nothing here is reachable by them.

interface NoteRow {
  note_id: string;
  note: string;
  author_name: string;
  created_at: string;
  own: boolean;
}

type Reading =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; notes: NoteRow[]; noteMax: number };

function isNoteRow(value: unknown): value is NoteRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.note_id === 'string'
    && typeof row.note === 'string'
    && typeof row.author_name === 'string'
    && typeof row.created_at === 'string'
    && typeof row.own === 'boolean';
}

export default function CapacityNotesPanel({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Each read gets a number; only the newest read of an OPEN panel may land.
  // A reply that arrives after the coach closed the panel, or after a newer
  // read started, is dropped -- so a panel never reopens itself.
  const latestRead = useRef(0);
  const isOpen = useRef(false);

  const read = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    isOpen.current = true;
    setReading({ state: 'loading' });
    const landed = () => isOpen.current && latestRead.current === ticket;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/athlete-capacity-notes?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !response.ok
        || !payload
        || payload.ok !== true
        || !Array.isArray(payload.notes)
        || !payload.notes.every(isNoteRow)
        || typeof payload.note_max !== 'number'
      ) {
        throw new Error('unreadable');
      }
      if (!landed()) return;
      setReading({ state: 'loaded', notes: payload.notes as NoteRow[], noteMax: payload.note_max });
    } catch {
      // Unknown is never shown as "no notes".
      if (landed()) setReading({ state: 'unavailable' });
    }
  }, [athleteId]);

  const toggle = useCallback(() => {
    setRefusal(null);
    if (isOpen.current) {
      isOpen.current = false;
      setReading({ state: 'closed' });
    } else {
      void read();
    }
  }, [read]);

  const describeFailure = (payload: { error?: unknown } | null, status: number, verb: string) =>
    typeof payload?.error === 'string' && payload.error ? payload.error : `The note was not ${verb} (${status}).`;

  const add = useCallback(async () => {
    setRefusal(null);
    if (draft.trim() === '') {
      setRefusal('Write the note first.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/athlete-capacity-notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_id: athleteId, note: draft }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
      if (!response.ok || !payload || payload.ok !== true) {
        setRefusal(describeFailure(payload, response.status, 'saved'));
        return;
      }
      setDraft('');
      // The read that follows shows the list with the new note first -- only
      // if the coach has not closed the panel meanwhile: read() opens the
      // panel, and a save must never reopen what the coach closed.
      if (isOpen.current) await read();
    } catch {
      setRefusal('The note was not saved — the connection failed. Nothing changed.');
    } finally {
      setBusy(false);
    }
  }, [athleteId, draft, read]);

  const withdraw = useCallback(
    async (noteId: string) => {
      setRefusal(null);
      setBusy(true);
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/athlete-capacity-notes?athlete_id=${encodeURIComponent(athleteId)}&note_id=${encodeURIComponent(noteId)}`,
          { method: 'DELETE', credentials: 'include' },
        );
        const payload = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
        if (!response.ok || !payload || payload.ok !== true) {
          setRefusal(describeFailure(payload, response.status, 'withdrawn'));
          return;
        }
        if (isOpen.current) await read();
      } catch {
        setRefusal('The note was not withdrawn — the connection failed. Nothing changed.');
      } finally {
        setBusy(false);
      }
    },
    [athleteId, read],
  );

  const open = reading.state !== 'closed';
  const panelId = `capacity-notes-${athleteId}`;

  return (
    <div className="mt-[var(--s3)]">
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        {open ? 'Hide capacity notes' : 'Capacity notes'}
      </button>

      {open ? (
        <div id={panelId} className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
          <p className="t-eyebrow">Capacity notes — {athleteName}</p>

          {reading.state === 'loading' ? (
            <p className="t-body mt-[var(--s2)]" role="status">Reading…</p>
          ) : null}

          {reading.state === 'unavailable' ? (
            <div className="mt-[var(--s2)]" role="alert">
              <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                This athlete’s notes could not be read just now. Unknown is not “no notes” — check again.
              </p>
              <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
                Check again
              </button>
            </div>
          ) : null}

          {reading.state === 'loaded' ? (
            <>
              <div className="field mt-[var(--s3)]">
                <label className="t-label" htmlFor={`${panelId}-draft`}>New note — what you saw, in your words</label>
                <textarea
                  id={`${panelId}-draft`}
                  className="input"
                  rows={3}
                  maxLength={reading.noteMax}
                  aria-describedby={`${panelId}-draft-hint`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <p id={`${panelId}-draft-hint`} className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>
                  Staff only; dated and kept with the athlete’s history. {draft.length} of {reading.noteMax} characters.
                </p>
              </div>
              <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || draft.trim() === ''}
                  aria-busy={busy}
                  onClick={() => void add()}
                >
                  {busy ? 'Saving…' : 'Add note'}
                </button>
              </div>

              {refusal ? (
                <div className="mt-[var(--s3)]" role="alert">
                  {/* Plain body text, not the brass stamp: brass ink on this
                      paper panel reads below text contrast. ▲ is the
                      CANNOT_BE_DONE glyph, never the medical red. */}
                  <p className="t-body font-semibold">
                    <span aria-hidden="true">▲ </span>NOT SAVED
                  </p>
                  <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{refusal}</p>
                </div>
              ) : null}

              <div className="mt-[var(--s3)]" data-notes-state={reading.notes.length > 0 ? 'some' : 'none'}>
                {reading.notes.length === 0 ? (
                  <p className="t-body">No capacity notes yet for this athlete.</p>
                ) : (
                  <ul className="space-y-[var(--s2)]" aria-label="Capacity notes, newest first">
                    {reading.notes.map((row) => (
                      <li key={row.note_id} className="t-body">
                        <p className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          {formatGymDateNumeric(row.created_at)} · {row.author_name}
                        </p>
                        <p style={{ whiteSpace: 'pre-wrap' }}>{row.note}</p>
                        {row.own ? (
                          <button
                            type="button"
                            className="btn btn--ghost mt-[var(--s1)]"
                            disabled={busy}
                            onClick={() => void withdraw(row.note_id)}
                            aria-label={`Withdraw your note from ${formatGymDateNumeric(row.created_at)}`}
                          >
                            Withdraw
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
