'use client';

import { useCallback, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// A coach's sparring caps for one athlete (map item 15): the highest contact
// stage they may spar at, and the most hard or open sparring sessions in any
// 7 days. Rendered closed inside each athlete row of /coach/sparring-caps; it
// reads nothing until a coach opens it.
//
// COACH-SET, NEVER APP-MADE. With no cap set the form is empty and the app
// offers no suggested stage or count; "No cap set" is said as exactly that.
// With a cap set, the form starts from THAT cap -- the coach's own numbers --
// because saving replaces the whole cap: an empty field would otherwise erase
// the limit the coach did not mean to touch.
//
// WHERE (Jason, 2026-10-04: "Own page"). Not on the sports-medicine board,
// whose 2026-08-15 rule is clearance and holds only; its own page, linked
// from the board. THE NOTE (OD-2026-10-04-013: "Keep note, labelled") stays
// with the caps, labelled to keep medical detail out.
//
// WARN, NEVER BLOCK (Jason, 2026-10-04: "Warn only"). Nothing here stops
// sparring. The sparring screen does not check caps yet; the text below says
// so rather than promise a warning that is not live.
//
// Authorization is the route's: this panel sends the form and shows what the
// server answers.

/** The contact ladder, lowest first. Pinned to the server's CONTACT_STAGES by ContactCapPanel.test.tsx. */
export const CAP_STAGE_ORDER = ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'] as const;

interface CapRow {
  cap_id: string;
  highest_allowed_stage: string | null;
  max_hard_open_sessions_per_7_days: number | null;
  note: string;
  set_by_name: string;
  set_at: string;
}

type Reading =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; cap: CapRow | null; history: CapRow[] };

function describeCap(cap: CapRow): string[] {
  const parts: string[] = [];
  if (cap.highest_allowed_stage !== null) {
    parts.push(`Highest stage: ${humanizeContactLevel(cap.highest_allowed_stage)}`);
  }
  if (cap.max_hard_open_sessions_per_7_days !== null) {
    parts.push(`Hard or open sessions in any 7 days: at most ${cap.max_hard_open_sessions_per_7_days}`);
  }
  return parts.length > 0 ? parts : ['Cap cleared'];
}

function isCapRow(value: unknown): value is CapRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.cap_id === 'string'
    && typeof row.set_at === 'string'
    && typeof row.set_by_name === 'string'
    && typeof row.note === 'string'
    && (row.highest_allowed_stage === null
      || (typeof row.highest_allowed_stage === 'string'
        && (CAP_STAGE_ORDER as readonly string[]).includes(row.highest_allowed_stage)))
    && (row.max_hard_open_sessions_per_7_days === null
      || (typeof row.max_hard_open_sessions_per_7_days === 'number'
        && Number.isInteger(row.max_hard_open_sessions_per_7_days)));
}

/** A cap in force must actually limit something; "set" with both empty is malformed. */
function isSetCap(value: unknown): value is CapRow {
  return isCapRow(value)
    && (value.highest_allowed_stage !== null || value.max_hard_open_sessions_per_7_days !== null);
}

export default function ContactCapPanel({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const [stage, setStage] = useState('');
  const [sessions, setSessions] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Each read gets a number; only the newest read of an OPEN panel may land.
  // A reply that arrives after the coach closed the panel, or after a newer
  // read started, is dropped -- so a panel never reopens itself.
  const latestRead = useRef(0);
  const isOpen = useRef(false);

  const fillForm = useCallback((cap: CapRow | null) => {
    setStage(cap?.highest_allowed_stage ?? '');
    setSessions(cap?.max_hard_open_sessions_per_7_days !== null && cap?.max_hard_open_sessions_per_7_days !== undefined
      ? String(cap.max_hard_open_sessions_per_7_days)
      : '');
    setNote(cap?.note ?? '');
  }, []);

  const read = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    isOpen.current = true;
    setReading({ state: 'loading' });
    const landed = () => isOpen.current && latestRead.current === ticket;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/athlete-contact-caps?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !response.ok
        || !payload
        || payload.ok !== true
        || !Array.isArray(payload.history)
        || !payload.history.every(isCapRow)
        || !('cap' in payload)
        || (payload.cap !== null && !isSetCap(payload.cap))
      ) {
        throw new Error('unreadable');
      }
      if (!landed()) return;
      const cap = payload.cap as CapRow | null;
      setReading({ state: 'loaded', cap, history: payload.history as CapRow[] });
      fillForm(cap);
    } catch {
      // Unknown is never shown as "no cap set".
      if (landed()) setReading({ state: 'unavailable' });
    }
  }, [athleteId, fillForm]);

  const toggle = useCallback(() => {
    setRefusal(null);
    if (isOpen.current) {
      isOpen.current = false;
      setReading({ state: 'closed' });
    } else {
      void read();
    }
  }, [read]);

  const save = useCallback(
    async (clear: boolean) => {
      setRefusal(null);
      const trimmed = sessions.trim();
      let count: number | null = null;
      if (!clear && trimmed !== '') {
        // Digits only: "1e2" or "0x10" are not something a coach typed as a count.
        count = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
        // No ceiling of the app's own: any whole number from 0 is the coach's
        // to choose. The only bound is what the database column can hold.
        if (!Number.isInteger(count) || count < 0 || count > 2147483647) {
          setRefusal('Sessions in any 7 days must be a whole number, 0 or more, or left blank for no limit.');
          return;
        }
      }
      setBusy(true);
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athlete-contact-caps`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            athlete_id: athleteId,
            highest_allowed_stage: clear || stage === '' ? null : stage,
            max_hard_open_sessions_per_7_days: count,
            note: clear ? '' : note,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
        if (!response.ok || !payload || payload.ok !== true) {
          setRefusal(
            typeof payload?.error === 'string' && payload.error
              ? payload.error
              : `The cap was not saved (${response.status}).`,
          );
          return;
        }
        // The read that follows fills the form from the cap now in force --
        // only if the coach has not closed the panel meanwhile: read() opens
        // the panel, and a save must never reopen what the coach closed.
        if (isOpen.current) await read();
      } catch {
        setRefusal('The cap was not saved — the connection failed. Nothing changed.');
      } finally {
        setBusy(false);
      }
    },
    [athleteId, note, read, sessions, stage],
  );

  const open = reading.state !== 'closed';
  const panelId = `contact-cap-${athleteId}`;

  return (
    <div className="mt-[var(--s3)]">
      <button
        type="button"
        className="btn btn--ghost"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
      >
        {open ? 'Hide sparring cap' : 'Sparring cap'}
      </button>

      {open ? (
        <div id={panelId} className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
          <p className="t-eyebrow">Sparring cap — {athleteName}</p>

          {reading.state === 'loading' ? (
            <p className="t-body mt-[var(--s2)]" role="status">Reading…</p>
          ) : null}

          {reading.state === 'unavailable' ? (
            <div className="mt-[var(--s2)]" role="alert">
              <p className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                This athlete’s cap could not be read just now. Unknown is not “no cap” — check again
                before sparring.
              </p>
              <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>
                Check again
              </button>
            </div>
          ) : null}

          {reading.state === 'loaded' ? (
            <>
              <div className="mt-[var(--s2)]" data-cap-state={reading.cap ? 'set' : 'none'}>
                {reading.cap ? (
                  <>
                    {describeCap(reading.cap).map((line) => (
                      <p key={line} className="t-body font-semibold">{line}</p>
                    ))}
                    {reading.cap.note ? (
                      <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>{reading.cap.note}</p>
                    ) : null}
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>
                      Set by {reading.cap.set_by_name} on {formatGymDateNumeric(reading.cap.set_at)}
                    </p>
                  </>
                ) : (
                  <p className="t-body">
                    No cap set. The app never picks one — if this athlete needs a limit, a coach sets it here.
                  </p>
                )}
              </div>

              <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor={`${panelId}-stage`}>Highest contact stage allowed</label>
                  <select
                    id={`${panelId}-stage`}
                    className="select"
                    value={stage}
                    onChange={(event) => setStage(event.target.value)}
                  >
                    <option value="">No stage limit</option>
                    {CAP_STAGE_ORDER.map((value) => (
                      <option key={value} value={value}>{humanizeContactLevel(value)}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="t-label" htmlFor={`${panelId}-sessions`}>
                    Most hard or open sparring sessions in any 7 days
                  </label>
                  <input
                    id={`${panelId}-sessions`}
                    className="input"
                    inputMode="numeric"
                    placeholder="Blank = no limit"
                    aria-describedby={`${panelId}-sessions-hint`}
                    value={sessions}
                    onChange={(event) => setSessions(event.target.value)}
                  />
                  <p id={`${panelId}-sessions-hint`} className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>
                    A session is a gym day with any hard sparring or open sparring.
                  </p>
                </div>
              </div>
              <div className="field mt-[var(--s3)]">
                <label className="t-label" htmlFor={`${panelId}-note`}>Staff note (optional)</label>
                <input
                  id={`${panelId}-note`}
                  className="input"
                  maxLength={1000}
                  aria-describedby={`${panelId}-note-hint`}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <p id={`${panelId}-note-hint`} className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>
                  Staff only. No medical details here — those belong in the clearance record.
                </p>
              </div>
              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                Saving replaces the cap in force; the old one stays in the history below. A cap never
                blocks sparring — the coach decides. The sparring screen does not check caps yet.
              </p>
              <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || (stage === '' && sessions.trim() === '')}
                  aria-busy={busy}
                  onClick={() => void save(false)}
                >
                  {busy ? 'Saving…' : 'Save cap'}
                </button>
                {reading.cap ? (
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void save(true)}>
                    Clear cap
                  </button>
                ) : null}
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

              {reading.history.length > 0 ? (
                <details className="mt-[var(--s3)]">
                  <summary className="t-label">Cap history ({reading.history.length})</summary>
                  <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                    {reading.history.map((row) => (
                      <li key={row.cap_id} className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        {formatGymDateNumeric(row.set_at)} · {row.set_by_name} · {describeCap(row).join(' · ')}
                        {row.note ? ` · ${row.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
