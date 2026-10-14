'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import SessionStaffNotesPanel from '@/components/SessionStaffNotesPanel';

// "Who is here" on the live session screen (audit finding F-067).
//
// The coach delivering the session taps each athlete who is in the room. A mark is SESSION
// DETAIL, not attendance: it feeds no attendance report (CT-13), and it never touches the
// athlete's own check-in. Taking a mark back keeps the record of it on the server.
//
// THE LIST IS THE SERVER'S. GET /api/pilot/session-scripts/runs/[runId]/athletes answers with who
// is marked and with `gym`, the athletes this coach may mark: the gym's live athletes (a coach's
// reach is the whole gym, OD-2026-10-11-007). Nothing here decides who may be marked; the server
// refuses anything else, and its answer is what the screen shows.
//
// A marked athlete gets a staff note box for this session (staff only, OD-2026-10-10-003 items 3
// and 4). The note panel reads nothing until the coach opens it.
//
// HONEST ABOUT WHAT IS KNOWN. A read that failed is "could not be read", never "nobody here". A
// tap the server refused (400, 401, 403, 404, 409, 422) says nothing was saved; a tap whose answer
// never arrived, or came back as any other error, says it is not known and reads the list again.

interface Athlete {
  athlete_id: string;
  full_name: string;
}

type Reading =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; gym: Athlete[]; present: Set<string> };

// The route's own refusals: when one of these comes back, the server said no and wrote nothing.
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

function isAthlete(value: unknown): value is Athlete {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.athlete_id === 'string' && typeof row.full_name === 'string';
}

function refusalText(code: unknown): string {
  if (code === 'SESSION_RUN_NOT_LIVE') return 'This session has already ended, so nothing was saved.';
  if (code === 'SESSION_RUN_NOT_FOUND') return 'Only the coach delivering this session can mark who is here. Nothing was saved.';
  if (code === 'SESSION_RUN_ATHLETE_NOT_PERMITTED') return 'This account cannot mark that athlete here. Nothing was saved.';
  return 'The server refused, so nothing was saved.';
}

// Brass and bone: an ordinary message, not the medical stop colour.
const ALERT = 'mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export default function SessionRunPresence({
  runId,
  onPresentCount,
}: {
  runId: string;
  /** The number of athletes marked here, each time the server says so; null while it is not known. */
  onPresentCount?: (count: number | null) => void;
}) {
  const [reading, setReading] = useState<Reading>({ state: 'loading' });
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const latestRead = useRef(0);

  const read = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => null)) as { present?: unknown; gym?: unknown } | null;
      if (
        !response.ok
        || !payload
        || !Array.isArray(payload.present)
        || !Array.isArray(payload.gym)
        || !payload.present.every(isAthlete)
        || !payload.gym.every(isAthlete)
      ) {
        throw new Error('unreadable');
      }
      if (latestRead.current !== ticket) return;
      setReading({
        state: 'loaded',
        gym: payload.gym as Athlete[],
        present: new Set((payload.present as Athlete[]).map((athlete) => athlete.athlete_id)),
      });
    } catch {
      if (latestRead.current === ticket) setReading({ state: 'unavailable' });
    }
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);

  const presentCount = reading.state === 'loaded' ? reading.present.size : null;
  useEffect(() => {
    onPresentCount?.(presentCount);
  }, [onPresentCount, presentCount]);

  const mark = useCallback(
    async (athlete: Athlete, present: boolean) => {
      if (busy) return;
      setBusy(athlete.athlete_id);
      setMessage('');
      try {
        let response: Response;
        try {
          response = await fetch(
            `${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ athlete_id: athlete.athlete_id, present }),
            },
          );
        } catch {
          setMessage(`The connection dropped. It is not known whether ${athlete.full_name} was ${present ? 'marked' : 'unmarked'}; the list has been read again.`);
          await read();
          return;
        }
        if (response.ok) {
          // A yes from the server is a yes, whatever its body: the mark is now what was asked for.
          setReading((current) => {
            if (current.state !== 'loaded') return current;
            const next = new Set(current.present);
            if (present) next.add(athlete.athlete_id);
            else next.delete(athlete.athlete_id);
            return { ...current, present: next };
          });
          return;
        }
        const payload = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
        if (REFUSAL_STATUSES.has(response.status)) {
          setMessage(refusalText(payload?.code ?? payload?.error));
          return;
        }
        setMessage(`It is not known whether ${athlete.full_name} was ${present ? 'marked' : 'unmarked'} (${response.status}); the list has been read again.`);
        await read();
      } finally {
        setBusy(null);
      }
    },
    [busy, read, runId],
  );

  const shown = useMemo(() => {
    if (reading.state !== 'loaded') return [];
    const needle = filter.trim().toLowerCase();
    const matching = reading.gym.filter((athlete) => needle === '' || athlete.full_name.toLowerCase().includes(needle));
    // Here first, then everyone else; each in the server's name order.
    return [
      ...matching.filter((athlete) => reading.present.has(athlete.athlete_id)),
      ...matching.filter((athlete) => !reading.present.has(athlete.athlete_id)),
    ];
  }, [filter, reading]);

  return (
    <div className="mt-[var(--s6)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]" aria-label="Who is here">
      <h3 className="t-label">Who is here</h3>

      {reading.state === 'loading' ? (
        <p className="t-body mt-[var(--s2)]" role="status">Reading who is marked here…</p>
      ) : null}

      {reading.state === 'unavailable' ? (
        <div role="alert" className={ALERT}>
          <p>Who is marked here could not be read just now. That is not the same as nobody.</p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
            Check again
          </button>
        </div>
      ) : null}

      {reading.state === 'loaded' ? (
        <>
          <p className="t-body mt-[var(--s2)]" role="status">
            {reading.present.size === 0
              ? 'Nobody marked here yet. Tap each athlete in the room.'
              : `${reading.present.size} marked here.`}
          </p>
          <p className="t-body mt-[var(--s1)] text-[color:var(--bone-400)]" style={{ fontSize: 'var(--t-xs)' }}>
            Staff only. This is who was in this session; it does not change anyone’s own check-in or attendance.
          </p>

          {message ? <p role="alert" className={ALERT}>{message}</p> : null}

          {reading.gym.length === 0 ? (
            <p className="t-body mt-[var(--s3)]">There are no athletes in this gym to mark.</p>
          ) : (
            <>
              <label className="field mt-[var(--s3)] block">
                <span className="t-label">Find an athlete</span>
                <input
                  className="input"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  autoComplete="off"
                />
              </label>
              {shown.length === 0 ? (
                <p className="t-body mt-[var(--s3)]">No athlete’s name matches “{filter.trim()}”.</p>
              ) : (
                <ul className="mt-[var(--s3)] space-y-[var(--s3)]" aria-label="Athletes of this gym">
                  {shown.map((athlete) => {
                    const here = reading.present.has(athlete.athlete_id);
                    return (
                      <li key={athlete.athlete_id}>
                        <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                          <span className="t-body font-semibold">{athlete.full_name}</span>
                          <button
                            type="button"
                            className={here ? 'btn' : 'btn btn--ghost'}
                            aria-pressed={here}
                            aria-label={here ? `${athlete.full_name} is marked here. Tap to take the mark back.` : `Mark ${athlete.full_name} here`}
                            disabled={busy !== null}
                            aria-busy={busy === athlete.athlete_id}
                            onClick={() => void mark(athlete, !here)}
                          >
                            {busy === athlete.athlete_id ? 'Saving…' : here ? 'Here' : 'Mark here'}
                          </button>
                        </div>
                        {here ? (
                          <SessionStaffNotesPanel
                            runId={runId}
                            athleteId={athlete.athlete_id}
                            buttonLabel={`Staff notes on ${athlete.full_name}`}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
