'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymDateTimeShort } from '@/src/lib/gymTime';
import { UNKNOWN_OUTCOME, unknownOutcomeWords } from '@/components/SessionRunClass';
import { keepSave, readSaveQueue, subscribeSaveQueue, type KeptSave } from '@/src/lib/saveQueue';

// Staff notes on one athlete's session (OD-2026-10-06-025 ruling 4): the
// athlete's own note stays theirs, and a coach or organization admin adds a
// separate note in their own name. Rendered closed under the session a coach
// picked in the review section; it reads nothing until a coach opens it.
//
// STAFF ONLY (OD-2026-10-10-003 ruling 3: "no athlete or parent view"). This
// panel is mounted on the coach screen and in the organization admin's
// coach-notes block on the admin athlete-records page (AdminAthleteCoachNotes.tsx,
// OD-2026-10-10-004 ruling 4) and nowhere else, and the route it calls refuses
// every athlete and parent.
//
// EVERY staff note on the session is listed, each under its author's display
// NAME (the server's author_name); the panel never sees an account id. Change
// and Remove appear only on the reader's own notes (`own` from the server),
// and the server decides again on every write.
//
// Authorization is the route's: this panel sends the form and shows what the
// server answers. A read that did not land is shown as unknown, never as "no
// notes".
//
// ON A SESSION OR ON A RUN. The same notes, the same route, either on the
// athlete's own session (sessionId) or on the athlete in a session a coach ran
// (runId, audit finding F-067), where the server takes a note only for an
// athlete marked present in that run. Exactly one of the two is given.
//
// A WRITE IS REPORTED AS THE SERVER ANSWERED IT. A yes (2xx) is a yes. The
// route's own refusals (400, 401, 403, 404, 409, 422) say the note was not
// saved. Anything else, or no answer, says it is not known, and the list is
// read again so the coach can see.
//
// KEPT ON THE LIVE FLOOR (W4 item 7, OQ-4; OW27-35 A). Only where the live session's "Who is here"
// list mounts this panel (keptOnThisPage), a write whose answer is lost is kept on the open page and
// sent again until it goes through: a new note with one request key and the account that made it, so
// it is written once however often it is sent. Every other mount keeps today's behaviour (Overwatch
// condition 4).

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

const ROUTE = '/api/pilot/coach/session-staff-notes';

// The route's own refusals: the server said no and wrote nothing.
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

type Subject = { sessionId: string; runId?: undefined } | { runId: string; sessionId?: undefined };

export default function SessionStaffNotesPanel(
  props: Subject & {
    athleteId: string;
    /** The closed button's words, when "on this session" is not enough (several athletes on one screen).
     *  The open panel's heading says the same words (F-173), so the button and the panel name one thing. */
    buttonLabel?: string;
    /** The live floor only: writes are kept on the open page and sent again until they go through. */
    keptOnThisPage?: boolean;
  },
) {
  const { athleteId, buttonLabel, keptOnThisPage = false } = props;
  const subjectKey = props.runId !== undefined ? 'run_id' : 'session_id';
  const subjectId = props.runId !== undefined ? props.runId : props.sessionId;
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ noteId: string; text: string } | null>(null);
  // Removal takes two taps: the first asks, the second removes.
  const [removing, setRemoving] = useState<string | null>(null);
  // Which write is in flight, so only that action's button says so.
  const [busy, setBusy] = useState<'add' | 'change' | 'remove' | null>(null);
  // The heading names the action that failed: a refused removal is not "not saved".
  const [refusal, setRefusal] = useState<{ heading: string; text: string } | null>(null);
  // Each read gets a number; only the newest read of an OPEN panel may land.
  // A reply that arrives after the coach closed the panel, or after a newer
  // read started, is dropped -- so a panel never reopens itself.
  const latestRead = useRef(0);
  const isOpen = useRef(false);
  // Kept writes of this panel not yet saved, said in the panel; cleared once nothing kept waits on the
  // page (a sign-out drop tells this panel nothing otherwise).
  const [waitingWrites, setWaitingWrites] = useState(0);
  useEffect(
    () =>
      subscribeSaveQueue(() => {
        const state = readSaveQueue();
        if (state.waiting.length === 0 && state.checking === 0) setWaitingWrites(0);
      }),
    [],
  );
  // While this panel is on the page; a refusal after it has gone gives its words to the page's list.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    isOpen.current = true;
    setReading({ state: 'loading' });
    const landed = () => isOpen.current && latestRead.current === ticket;
    try {
      const response = await fetch(
        `${apiBase()}${ROUTE}?${subjectKey}=${encodeURIComponent(subjectId)}&athlete_id=${encodeURIComponent(athleteId)}`,
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
  }, [athleteId, subjectId, subjectKey]);

  // The notes as the server has them now, for a kept write's landed check: null when they cannot be read.
  const readNotes = useCallback(
    async (signal: AbortSignal): Promise<NoteRow[] | null> => {
      try {
        const response = await fetch(
          `${apiBase()}${ROUTE}?${subjectKey}=${encodeURIComponent(subjectId)}&athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', signal },
        );
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.notes) || !payload.notes.every(isNoteRow)) {
          return null;
        }
        return payload.notes as NoteRow[];
      } catch {
        return null;
      }
    },
    [athleteId, subjectId, subjectKey],
  );

  const toggle = useCallback(() => {
    setEditing(null);
    setRemoving(null);
    if (isOpen.current) {
      isOpen.current = false;
      setReading({ state: 'closed' });
      // Cleared on closing only: a refusal that lands after the coach closed
      // the panel is still there to read when it is opened again.
      setRefusal(null);
    } else {
      void read();
    }
  }, [read]);

  // One write path for add, change and remove. `done` runs only on the
  // server's own yes; the list is then re-read (unless the coach closed the
  // panel meanwhile -- a write must never reopen what the coach closed).
  const keptWrite = useCallback(
    (
      kind: 'add' | 'change' | 'remove',
      request: { url: string; method: string; body?: unknown },
      failed: { heading: string; verb: string },
      what: { noteId?: string; text: string; before: ReadonlySet<string> | null },
      resolved: { done: boolean; counted: boolean },
    ): KeptSave => {
      let reason = '';
      // No note text and no name: the line can outlive this panel on a shared floor screen.
      const label = kind === 'add' ? 'Staff note' : kind === 'change' ? 'Staff note change' : 'Staff note removal';
      const settle = () => {
        resolved.done = true;
        if (!resolved.counted) return;
        resolved.counted = false;
        setWaitingWrites((count) => Math.max(0, count - 1));
      };
      return {
        label,
        send: ({ signal, requestKey, madeByAccountId }) =>
          fetch(`${apiBase()}${request.url}`, {
            method: request.method,
            credentials: 'include',
            ...(request.body === undefined
              ? {}
              : {
                headers: { 'content-type': 'application/json' },
                // A new note carries its key and the account that made it (OQ-1); a change or removal is
                // the author's own note, which the server already checks.
                body: JSON.stringify(kind === 'add'
                  ? { ...(request.body as Record<string, unknown>), request_key: requestKey, made_by_account_id: madeByAccountId }
                  : request.body),
              }),
            signal,
          }),
        // A yes is a yes (as today); the route's own refusals are a no; anything else proves nothing.
        answerOf: async (response) => {
          if (response.ok) return 'saved';
          if (!REFUSAL_STATUSES.has(response.status)) return 'unknown';
          const payload = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
          reason = typeof payload?.error === 'string' && payload.error ? payload.error : `The note was not ${failed.verb} (${response.status}).`;
          return 'refused';
        },
        // A refused resend: do the notes now show what this write asked?
        checkLanded: async (signal) => {
          const notes = await readNotes(signal);
          if (notes === null) return null;
          const text = what.text.trim();
          if (kind === 'remove') return !notes.some((row) => row.note_id === what.noteId);
          if (kind === 'change') return notes.some((row) => row.note_id === what.noteId && row.note === text);
          if (what.before === null) return null;
          const before = what.before;
          return notes.some((row) => row.own && !before.has(row.note_id) && row.note === text);
        },
        onSaved: () => {
          settle();
          if (onPage.current && isOpen.current) void read();
        },
        // Refused: said in this panel, where the coach wrote; a refused new note's words come back to the draft.
        onRefused: (_response, landed) => {
          settle();
          if (!onPage.current) return landed === null ? UNKNOWN_OUTCOME : reason;
          if (kind === 'add') setDraft((current) => (current === '' ? what.text : current));
          setRefusal(landed === null ? { heading: 'NOT KNOWN', text: unknownOutcomeWords(label) } : { heading: failed.heading, text: reason });
          if (isOpen.current) void read();
          return undefined;
        },
      };
    },
    [read, readNotes],
  );

  const write = useCallback(
    async (
      kind: 'add' | 'change' | 'remove',
      request: { url: string; method: string; body?: unknown },
      failed: { heading: string; verb: string },
      done: () => void,
      what: { noteId?: string; text: string } = { text: '' },
    ) => {
      setRefusal(null);
      setBusy(kind);
      try {
        if (keptOnThisPage) {
          // Kept: done at once (the draft clears), so a second tap is a new write, not this one twice.
          // Not kept (the page does not know who is signed in): sent once, as before.
          const before = reading.state === 'loaded' ? new Set(reading.notes.map((row) => row.note_id)) : null;
          const resolved = { done: false, counted: false };
          if ((await keepSave(keptWrite(kind, request, failed, { ...what, before }, resolved))) === 'kept') {
            if (!resolved.done) {
              resolved.counted = true;
              setWaitingWrites((count) => count + 1);
            }
            done();
            return;
          }
        }
        const response = await fetch(`${apiBase()}${request.url}`, {
          method: request.method,
          credentials: 'include',
          ...(request.body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
        if (!response.ok && !REFUSAL_STATUSES.has(response.status)) {
          setRefusal({
            heading: 'NOT KNOWN',
            text: `It is not known whether the note was ${failed.verb} (${response.status}). Check the list below before trying again.`,
          });
          if (isOpen.current) await read();
          return;
        }
        if (!response.ok) {
          setRefusal({
            heading: failed.heading,
            text: typeof payload?.error === 'string' && payload.error
              ? payload.error
              : `The note was not ${failed.verb} (${response.status}).`,
          });
          // "No such note" means the list on screen is out of date (removed
          // on another device): show what is there now.
          if (response.status === 404 && isOpen.current) await read();
          return;
        }
        done();
        if (isOpen.current) await read();
      } catch {
        // The request may have reached the server before the connection
        // dropped, so "nothing changed" would be a guess. Say what is known
        // and re-read, so a coach does not add the same note twice.
        setRefusal({
          heading: 'CONNECTION FAILED',
          text: `The note may not have been ${failed.verb}. Check the list below before trying again.`,
        });
        if (isOpen.current) await read();
      } finally {
        setBusy(null);
      }
    },
    [keptOnThisPage, keptWrite, read, reading],
  );

  const add = () => write(
    'add',
    { url: ROUTE, method: 'POST', body: { [subjectKey]: subjectId, athlete_id: athleteId, note: draft } },
    { heading: 'NOT SAVED', verb: 'saved' },
    () => setDraft(''),
    { text: draft },
  );

  const saveEdit = (noteId: string, text: string) => write(
    'change',
    { url: ROUTE, method: 'PATCH', body: { note_id: noteId, note: text } },
    { heading: 'NOT CHANGED', verb: 'changed' },
    () => setEditing(null),
    { noteId, text },
  );

  const remove = (noteId: string) => write(
    'remove',
    { url: `${ROUTE}?note_id=${encodeURIComponent(noteId)}`, method: 'DELETE' },
    { heading: 'NOT REMOVED', verb: 'removed' },
    () => setRemoving(null),
    { noteId, text: '' },
  );

  const open = reading.state !== 'closed';
  // What the notes are on, in the words the button used (F-173). A note belongs to
  // ONE athlete in one session or run, never to the whole session: where several
  // athletes share a screen the button names the athlete, and so does this heading.
  const subjectWords = buttonLabel ?? 'Staff notes on this session';
  // A run holds many athletes, so its panel ids carry the athlete too.
  const panelId = props.runId !== undefined
    ? `session-staff-notes-run-${props.runId}-${athleteId}`
    : `session-staff-notes-${subjectId}`;

  return (
    <div className="mt-[var(--s3)]">
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        {open ? 'Hide staff notes' : subjectWords}
      </button>

      {open ? (
        <div id={panelId} className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
          <p className="t-eyebrow">{subjectWords}</p>

          {reading.state === 'loading' ? (
            <p className="t-body mt-[var(--s2)]" role="status">Reading…</p>
          ) : null}

          {reading.state === 'unavailable' ? (
            <div className="mt-[var(--s2)]" role="alert">
              <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                This session’s staff notes could not be read just now. Unknown is not “no notes” — check again.
              </p>
              <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
                Check again
              </button>
            </div>
          ) : null}

          {reading.state === 'loaded' ? (
            <>
              <div className="mt-[var(--s3)]" data-notes-state={reading.notes.length > 0 ? 'some' : 'none'}>
                {reading.notes.length === 0 ? (
                  <p className="t-body">
                    {/* PROPOSED copy. In a run the notes are this athlete's, not the whole session's (F-173). */}
                    {props.runId !== undefined ? 'No staff notes for this athlete in this session yet.' : 'No staff notes on this session yet.'}
                  </p>
                ) : (
                  <ul className="space-y-[var(--s3)]" aria-label="Staff notes, oldest first">
                    {reading.notes.map((row) => {
                      // Date and time: a coach may add one note before a
                      // session and another after it on the same day.
                      const when = formatGymDateTimeShort(row.created_at) ?? formatGymDateNumeric(row.created_at);
                      const edit = editing?.noteId === row.note_id ? editing : null;
                      return (
                        <li key={row.note_id} className="t-body">
                          <p className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                            {when} · {row.author_name}{row.own ? ' (you)' : ''}
                          </p>
                          {edit ? (
                            <div className="field mt-[var(--s1)]">
                              <label className="t-label" htmlFor={`${panelId}-edit`}>Change your note</label>
                              <textarea
                                id={`${panelId}-edit`}
                                className="input"
                                rows={3}
                                maxLength={reading.noteMax}
                                value={edit.text}
                                onChange={(event) => setEditing({ noteId: row.note_id, text: event.target.value })}
                              />
                              <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s3)]">
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busy !== null || edit.text.trim() === '' || edit.text.trim() === row.note}
                                  aria-busy={busy === 'change'}
                                  onClick={() => void saveEdit(row.note_id, edit.text)}
                                >
                                  {busy === 'change' ? 'Saving…' : 'Save change'}
                                </button>
                                <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p style={{ whiteSpace: 'pre-wrap' }}>{row.note}</p>
                          )}
                          {row.own && !edit ? (
                            <div className="mt-[var(--s1)] flex flex-wrap gap-[var(--s3)]">
                              {removing === row.note_id ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={busy !== null}
                                    aria-busy={busy === 'remove'}
                                    onClick={() => void remove(row.note_id)}
                                  >
                                    {busy === 'remove' ? 'Removing…' : 'Yes, remove this note'}
                                  </button>
                                  <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => setRemoving(null)}>
                                    Keep it
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    disabled={busy !== null}
                                    onClick={() => { setRefusal(null); setRemoving(null); setEditing({ noteId: row.note_id, text: row.note }); }}
                                    aria-label={`Change your note from ${when}`}
                                  >
                                    Change
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--ghost"
                                    disabled={busy !== null}
                                    onClick={() => { setRefusal(null); setEditing(null); setRemoving(row.note_id); }}
                                    aria-label={`Remove your note from ${when}`}
                                  >
                                    Remove
                                  </button>
                                </>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Mounted always, so a screen reader announces the line when it fills. */}
              <p className={waitingWrites > 0 ? 't-body mt-[var(--s3)] font-semibold' : 'sr-only'} role="status">
                {waitingWrites === 0
                  ? ''
                  : waitingWrites === 1
                    ? 'One change to these notes is not saved yet. This page keeps sending it while it stays open.'
                    : `${waitingWrites} changes to these notes are not saved yet. This page keeps sending them while it stays open.`}
              </p>

              {refusal ? (
                <div className="mt-[var(--s3)]" role="alert">
                  {/* Plain body text, not the brass stamp: brass ink on this
                      paper panel reads below text contrast. ▲ is the
                      CANNOT_BE_DONE glyph, never the medical red. */}
                  <p className="t-body font-semibold">
                    <span aria-hidden="true">▲ </span>{refusal.heading}
                  </p>
                  <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{refusal.text}</p>
                </div>
              ) : null}

              <div className="field mt-[var(--s3)]">
                <label className="t-label" htmlFor={`${panelId}-draft`}>New note — in your name</label>
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
                  Staff only: athletes and families do not see these notes. {draft.length} of {reading.noteMax} characters.
                </p>
              </div>
              <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null || draft.trim() === ''}
                  aria-busy={busy === 'add'}
                  onClick={() => void add()}
                >
                  {busy === 'add' ? 'Saving…' : 'Add note'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
