'use client';

import { useCallback, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

import CapacityNotesPanel from './CapacityNotesPanel';
import SessionStaffNotesPanel from './SessionStaffNotesPanel';

// Where the organization admin reads what the gym's coaches wrote about one
// athlete (OD-2026-10-10-004 ruling 4, Jason: "A: Block on an admin page"):
// the capacity notes, and the staff notes on a session. Mounted under the
// selected athlete on the admin athlete-records page, which is already
// organization-admin only. The coach page is NOT opened to the admin.
//
// NOTHING NEW IS DECIDED HERE. Both panels are the coach screen's own,
// unchanged, over the routes they already call; the routes and the modules
// behind them decide who may read, write and withdraw. That is also where the
// admin withdraws a capacity note whose author has left the gym
// (OD-2026-10-10-003 ruling 4): the capacity panel shows Withdraw on exactly
// the notes the server marks.
//
// STAFF ONLY (OD-2026-10-10-003 ruling 3): no athlete or parent page mounts
// this block.
//
// READS NOTHING UNTIL OPENED, like the panels it holds. A session has to be
// picked before its staff notes can be read, so "Session notes" reads this
// athlete's sessions (the existing per-athlete session read) only when opened.

/** A row of GET /api/pilot/sessions/list, cut to what an option is labelled with. */
interface PickableSession {
  sessionId: string;
  date: string;
  completed: boolean;
  createdAt: string;
}

function pickableSession(row: unknown): PickableSession | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
  // Sliced to the day and shown as stored: the column can be date-only, and a
  // timezone formatter would invent a time (and sometimes the wrong day).
  const date = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
  if (!sessionId || !date) return null;
  return {
    sessionId,
    date,
    completed: Boolean(record.completed_flag),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
  };
}

type Sessions =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; sessions: PickableSession[] };

export default function AdminAthleteCoachNotes({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [sessions, setSessions] = useState<Sessions>({ state: 'closed' });
  const [sessionId, setSessionId] = useState('');
  // Only the newest read of an OPEN list may land, so a reply that arrives
  // after the admin closed it never reopens it.
  const latestRead = useRef(0);
  const isOpen = useRef(false);

  const readSessions = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    isOpen.current = true;
    setSessions({ state: 'loading' });
    const landed = () => isOpen.current && latestRead.current === ticket;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as { items?: unknown } | null;
      if (!response.ok || !payload || !Array.isArray(payload.items)) throw new Error('unreadable');
      if (!landed()) return;
      setSessions({
        state: 'loaded',
        sessions: payload.items
          .map(pickableSession)
          .filter((session): session is PickableSession => session !== null)
          // The route orders by date alone, which cannot separate two sessions on one day.
          .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)),
      });
    } catch {
      // Unknown is never shown as "no sessions".
      if (landed()) setSessions({ state: 'unavailable' });
    }
  }, [athleteId]);

  const toggleSessions = useCallback(() => {
    if (isOpen.current) {
      isOpen.current = false;
      setSessionId('');
      setSessions({ state: 'closed' });
    } else {
      void readSessions();
    }
  }, [readSessions]);

  const open = sessions.state !== 'closed';
  const listId = `admin-session-notes-${athleteId}`;

  return (
    <section
      aria-labelledby={`${listId}-heading`}
      className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]"
    >
      <div>
        <h2 id={`${listId}-heading`} className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Coach notes</h2>
        <p className="t-body mt-[var(--s3)]">
          What this gym&apos;s coaches have written about {athleteName}: capacity notes, and staff notes on a
          session. Staff only. A capacity note stays its coach&apos;s to withdraw; once that coach has left the gym,
          you can withdraw it here.
        </p>
      </div>

      <CapacityNotesPanel athleteId={athleteId} athleteName={athleteName} />

      <div>
        <button
          type="button"
          className="btn btn--ghost"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={toggleSessions}
        >
          {open ? 'Hide session notes' : 'Session notes'}
        </button>

        {open ? (
          <div id={listId} className="mt-[var(--s3)]">
            {sessions.state === 'loading' ? <p className="t-body" role="status">Reading…</p> : null}

            {sessions.state === 'unavailable' ? (
              <div role="alert">
                <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                  This athlete’s sessions could not be read just now. Unknown is not “no sessions” — check again.
                </p>
                <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void readSessions()}>
                  Check again
                </button>
              </div>
            ) : null}

            {sessions.state === 'loaded' && sessions.sessions.length === 0 ? (
              <p className="t-body">No sessions are recorded for this athlete yet.</p>
            ) : null}

            {sessions.state === 'loaded' && sessions.sessions.length > 0 ? (
              <>
                <label className="field">
                  <span className="t-label">Session</span>
                  <select className="select" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
                    <option value="">Select a session</option>
                    {sessions.sessions.map((session) => (
                      <option key={session.sessionId} value={session.sessionId}>
                        {session.date} - {session.completed ? 'completed' : 'open'}
                      </option>
                    ))}
                  </select>
                </label>
                {sessionId ? (
                  <SessionStaffNotesPanel key={`${athleteId}-${sessionId}`} sessionId={sessionId} athleteId={athleteId} />
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
