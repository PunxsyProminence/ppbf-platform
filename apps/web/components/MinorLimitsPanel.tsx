'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// A coach's limits for one athlete (OD-2026-10-06-024 ruling 2: coach-set
// limits for minors, stored as data): heat exposure in minutes per session,
// the most weight cut as a percentage of body weight, and the supervision the
// coach requires in their own words (OD-2026-10-08-007: Q2 free text, Q3
// per session). Rendered closed inside each athlete row of
// /coach/athlete-limits; it reads nothing until a coach opens it.
//
// COACH-SET, NEVER APP-MADE. With no limit set the field is empty and the app
// offers no suggested number; "No limit set" is said as exactly that. Each
// type is saved or cleared ON ITS OWN, with the coach's reason for THAT write
// (the reason field starts empty; the old reason is shown beside the limit),
// so touching one limit can never erase another, and a reason given for one
// write is never recorded against the next.
//
// WHO IS A MINOR comes from the server (date of birth; unknown counts as a
// minor), shown as a label. An adult's limits are recorded the same way and
// labelled adult (OD-2026-10-07-005 "A").
//
// CONTACT LEVEL is not set here: it already lives in the sparring cap
// (pilot.athlete_contact_caps), so this panel shows the cap in force read-only
// and links to /coach/sparring-caps, one home per limit.
//
// Authorization is the route's: this panel sends the form and shows what the
// server answers. Staff only (OD-2026-10-08-007 Q5): nothing here is reachable
// by an athlete or a guardian.

export const LIMIT_TYPES = [
  'heat_exposure_minutes_per_session',
  'weight_cut_max_percent_body_weight',
  'supervision',
] as const;
export type LimitType = (typeof LIMIT_TYPES)[number];

export const LIMIT_LABELS: Readonly<Record<LimitType, string>> = {
  heat_exposure_minutes_per_session: 'Heat exposure — minutes per session',
  weight_cut_max_percent_body_weight: 'Weight cut — most percent of body weight',
  supervision: 'Supervision the coach requires',
};

/** Mirrors the server's SUPERVISION_TEXT_MAX and NOTE_MAX; the server refuses longer. */
const SUPERVISION_MAX = 500;
const NOTE_MAX = 1000;
/** numeric(8,2): the column's own bound, as the server's NUMBER_MAX. */
const NUMBER_MAX = 999999.99;

interface LimitRow {
  limit_id: string;
  limit_type: LimitType;
  value_number: number | null;
  value_text: string | null;
  note: string;
  set_by_name: string;
  set_at: string;
}

interface CapRow {
  cap_id: string;
  highest_allowed_stage: string | null;
  max_hard_open_sessions_per_7_days: number | null;
}

type Reading =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'loaded'; isMinor: boolean; limits: Record<LimitType, LimitRow | null>; history: LimitRow[] };

type CapReading = { state: 'loading' } | { state: 'unavailable' } | { state: 'loaded'; cap: CapRow | null };

function isLimitType(value: unknown): value is LimitType {
  return typeof value === 'string' && (LIMIT_TYPES as readonly string[]).includes(value);
}

function isLimitRow(value: unknown): value is LimitRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.limit_id === 'string'
    && isLimitType(row.limit_type)
    && (row.value_number === null || typeof row.value_number === 'number')
    && (row.value_text === null || typeof row.value_text === 'string')
    && typeof row.note === 'string'
    && typeof row.set_by_name === 'string'
    && typeof row.set_at === 'string';
}

/** A limit in force must actually limit something; "set" with both empty is malformed. */
function isSetLimit(value: unknown): value is LimitRow {
  return isLimitRow(value) && (value.value_number !== null || value.value_text !== null);
}

function isCapRow(value: unknown): value is CapRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.cap_id === 'string'
    && (row.highest_allowed_stage === null || typeof row.highest_allowed_stage === 'string')
    && (row.max_hard_open_sessions_per_7_days === null || typeof row.max_hard_open_sessions_per_7_days === 'number');
}

/** The limit a row records, in words; a cleared row says so. */
export function describeLimit(row: LimitRow): string {
  switch (row.limit_type) {
    case 'heat_exposure_minutes_per_session':
      return row.value_number === null ? 'Heat exposure limit cleared' : `Heat exposure: at most ${row.value_number} minutes per session`;
    case 'weight_cut_max_percent_body_weight':
      return row.value_number === null ? 'Weight cut limit cleared' : `Weight cut: at most ${row.value_number}% of body weight`;
    case 'supervision':
      return row.value_text === null ? 'Supervision requirement cleared' : `Supervision: ${row.value_text}`;
  }
}

function describeCap(cap: CapRow): string {
  const parts: string[] = [];
  if (cap.highest_allowed_stage !== null) parts.push(`highest stage ${humanizeContactLevel(cap.highest_allowed_stage)}`);
  if (cap.max_hard_open_sessions_per_7_days !== null) {
    parts.push(`at most ${cap.max_hard_open_sessions_per_7_days} hard or open sessions in any 7 days`);
  }
  return parts.join(', ');
}

const EMPTY: Record<LimitType, string> = {
  heat_exposure_minutes_per_session: '',
  weight_cut_max_percent_body_weight: '',
  supervision: '',
};

export default function MinorLimitsPanel({ athleteId, athleteName }: { athleteId: string; athleteName: string }) {
  const [reading, setReading] = useState<Reading>({ state: 'closed' });
  const [capReading, setCapReading] = useState<CapReading>({ state: 'loading' });
  const [values, setValues] = useState<Record<LimitType, string>>(EMPTY);
  const [notes, setNotes] = useState<Record<LimitType, string>>(EMPTY);
  const [busy, setBusy] = useState<LimitType | null>(null);
  const [refusal, setRefusal] = useState<{ type: LimitType; message: string } | null>(null);
  const [saved, setSaved] = useState<LimitType | null>(null);
  // Each read gets a number; only the newest read of an OPEN panel may land,
  // so a reply that arrives after the coach closed the panel, or after a
  // newer read started, is dropped and a panel never reopens itself.
  const latestRead = useRef(0);
  const isOpen = useRef(false);

  // The value field starts from the coach's own saved value, never from a
  // suggestion; the reason field starts empty. After a save only THAT type is
  // refilled, so typing in the other two is not thrown away.
  const fillForm = useCallback((limits: Record<LimitType, LimitRow | null>, only?: LimitType) => {
    const types = only ? [only] : LIMIT_TYPES;
    setValues((prev) => {
      const next = { ...prev };
      for (const type of types) {
        const row = limits[type];
        next[type] = row ? row.value_text ?? (row.value_number === null ? '' : String(row.value_number)) : '';
      }
      return next;
    });
    setNotes((prev) => {
      const next = { ...prev };
      for (const type of types) next[type] = '';
      return next;
    });
  }, []);

  const readCap = useCallback(async (landed: () => boolean) => {
    setCapReading({ state: 'loading' });
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/athlete-contact-caps?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !payload || payload.ok !== true || !('cap' in payload) || (payload.cap !== null && !isCapRow(payload.cap))) {
        throw new Error('unreadable');
      }
      if (landed()) setCapReading({ state: 'loaded', cap: payload.cap as CapRow | null });
    } catch {
      if (landed()) setCapReading({ state: 'unavailable' });
    }
  }, [athleteId]);

  const read = useCallback(async (only?: LimitType) => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    isOpen.current = true;
    // A re-read after a save keeps the sections on screen (no "Reading…"
    // flash, no lost focus); only the first read of an open shows it.
    if (!only) setReading({ state: 'loading' });
    const landed = () => isOpen.current && latestRead.current === ticket;
    void readCap(landed);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/athlete-minor-limits?athlete_id=${encodeURIComponent(athleteId)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const limits = payload?.limits as Record<string, unknown> | undefined;
      if (
        !response.ok
        || !payload
        || payload.ok !== true
        || typeof payload.athlete_is_minor !== 'boolean'
        || !limits || typeof limits !== 'object'
        || !LIMIT_TYPES.every((type) => type in limits && (limits[type] === null || isSetLimit(limits[type])))
        || !Array.isArray(payload.history)
        || !payload.history.every(isLimitRow)
      ) {
        throw new Error('unreadable');
      }
      if (!landed()) return;
      const inForce = limits as Record<LimitType, LimitRow | null>;
      setReading({ state: 'loaded', isMinor: payload.athlete_is_minor, limits: inForce, history: payload.history as LimitRow[] });
      fillForm(inForce, only);
    } catch {
      // Unknown is never shown as "no limit set".
      if (landed()) setReading({ state: 'unavailable' });
    }
  }, [athleteId, fillForm, readCap]);

  const toggle = useCallback(() => {
    setRefusal(null);
    setSaved(null);
    if (isOpen.current) {
      isOpen.current = false;
      setReading({ state: 'closed' });
    } else {
      void read();
    }
  }, [read]);

  const save = useCallback(
    async (type: LimitType, clear: boolean) => {
      setRefusal(null);
      setSaved(null);
      let value: number | string | null = null;
      if (!clear) {
        const typed = values[type].trim();
        if (type === 'supervision') {
          if (typed === '') {
            setRefusal({ type, message: 'Write the supervision you require, or use Clear to remove the requirement.' });
            return;
          }
          value = typed;
        } else {
          // Plain decimal digits only ("1e2" is not a limit a coach typed);
          // ".5" and "5." are what a thumb on a tablet produces, so both pass.
          // No ceiling of the app's own: the only bound is the column's
          // (numeric(8,2)), said in words here so the server's shape message
          // is not the coach's only clue.
          if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(typed)) {
            setRefusal({ type, message: 'Enter a number, 0 or more, with at most two decimal places — or use Clear to remove the limit.' });
            return;
          }
          value = Number(typed);
          if (value > NUMBER_MAX) {
            setRefusal({ type, message: `The record holds numbers up to ${NUMBER_MAX}.` });
            return;
          }
        }
      }
      setBusy(type);
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athlete-minor-limits`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ athlete_id: athleteId, limit_type: type, value, note: notes[type] }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
        if (!response.ok || !payload || payload.ok !== true) {
          setRefusal({
            type,
            message: typeof payload?.error === 'string' && payload.error ? payload.error : `The limit was not saved (${response.status}).`,
          });
          return;
        }
        // The read that follows fills the form from the limits now in force,
        // only if the coach has not closed the panel meanwhile.
        if (isOpen.current) {
          await read(type);
          setSaved(type);
        }
      } catch {
        setRefusal({ type, message: 'The limit was not saved — the connection failed. Nothing changed.' });
      } finally {
        setBusy(null);
      }
    },
    [athleteId, notes, read, values],
  );

  const open = reading.state !== 'closed';
  const panelId = `minor-limits-${athleteId}`;

  return (
    <div className="mt-[var(--s3)]">
      <button type="button" className="btn btn--ghost" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={toggle}>
        {open ? 'Hide limits' : 'Limits'}
      </button>

      {open ? (
        <div id={panelId} className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
          <p className="t-eyebrow">Limits — {athleteName}</p>

          {reading.state === 'loading' ? <p className="t-body mt-[var(--s2)]" role="status">Reading…</p> : null}

          {reading.state === 'unavailable' ? (
            <div className="mt-[var(--s2)]" role="alert">
              <p className="t-body">
                <span aria-hidden="true">▲ </span>This athlete’s limits could not be read just now. Unknown is not “no limit set” — check again before training.
              </p>
              <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => void read()}>Check again</button>
            </div>
          ) : null}

          {reading.state === 'loaded' ? (
            <>
              <p className="t-body mt-[var(--s2)] font-semibold" data-athlete-age={reading.isMinor ? 'minor' : 'adult'}>
                {reading.isMinor
                  ? 'Minor — these limits are the coach’s limits for a child.'
                  : 'Adult — limits are recorded the same way and labelled adult.'}
              </p>

              <div className="mt-[var(--s3)]" data-contact-cap={capReading.state === 'loaded' ? (capReading.cap ? 'set' : 'none') : capReading.state}>
                <p className="t-label">Contact level (sparring cap)</p>
                {capReading.state === 'loading' ? <p className="t-body" role="status">Reading the sparring cap…</p> : null}
                {capReading.state === 'unavailable' ? (
                  <p className="t-body" role="alert"><span aria-hidden="true">▲ </span>The sparring cap could not be read just now. Unknown is not “no cap set”.</p>
                ) : null}
                {capReading.state === 'loaded' ? (
                  <p className="t-body">
                    {capReading.cap ? `Cap in force: ${describeCap(capReading.cap)}.` : 'No sparring cap set.'}
                  </p>
                ) : null}
                <p className="t-body mt-[var(--s1)]">Contact level is set on the Sparring Caps page, not here.</p>
                {/* An anchor is outside the kiosk attribute's selector list, so the 55px floor is asked for by class. */}
                <Link href="/coach/sparring-caps" className="btn btn--ghost min-h-[var(--tap)] mt-[var(--s2)]">Sparring Caps</Link>
              </div>

              {LIMIT_TYPES.map((type) => {
                const row = reading.limits[type];
                const fieldId = `${panelId}-${type}`;
                return (
                  <section key={type} className="mt-[var(--s4)] border-t border-[color:var(--brass-700)] pt-[var(--s3)]" aria-labelledby={`${fieldId}-heading`} data-limit-state={row ? 'set' : 'none'}>
                    <h3 id={`${fieldId}-heading`} className="t-label">{LIMIT_LABELS[type]}</h3>
                    {row ? (
                      <>
                        <p className="t-body font-semibold">{describeLimit(row)}</p>
                        {row.note ? <p className="t-body mt-[var(--s1)]">Reason: {row.note}</p> : null}
                        <p className="t-data mt-[var(--s1)]">Set by {row.set_by_name} on {formatGymDateNumeric(row.set_at)}</p>
                      </>
                    ) : (
                      <p className="t-body">No limit set. The app never picks one — if this athlete needs a limit, a coach sets it here.</p>
                    )}
                    <div className="mt-[var(--s2)] grid gap-[var(--s3)] md:grid-cols-2">
                      <div className="field">
                        <label className="t-label" htmlFor={fieldId}>
                          {type === 'supervision' ? 'What you require' : type === 'heat_exposure_minutes_per_session' ? 'Minutes per session' : 'Percent of body weight'}
                        </label>
                        <input
                          id={fieldId}
                          type="text"
                          className="input"
                          inputMode={type === 'supervision' ? 'text' : 'decimal'}
                          maxLength={type === 'supervision' ? SUPERVISION_MAX : 12}
                          placeholder={type === 'supervision' ? 'In your own words' : undefined}
                          value={values[type]}
                          onChange={(event) => setValues((prev) => ({ ...prev, [type]: event.target.value }))}
                        />
                      </div>
                      <div className="field">
                        <label className="t-label" htmlFor={`${fieldId}-note`}>Reason for this change (staff only)</label>
                        <input
                          id={`${fieldId}-note`}
                          type="text"
                          className="input"
                          maxLength={NOTE_MAX}
                          value={notes[type]}
                          onChange={(event) => setNotes((prev) => ({ ...prev, [type]: event.target.value }))}
                        />
                      </div>
                    </div>
                    <div className="mt-[var(--s2)] flex flex-wrap gap-[var(--s3)]">
                      <button type="button" className="btn" disabled={busy !== null} aria-busy={busy === type} onClick={() => void save(type, false)}>
                        {busy === type ? 'Saving…' : `Save ${type === 'supervision' ? 'supervision' : 'limit'}`}
                      </button>
                      {row ? (
                        <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => void save(type, true)}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                    {saved === type && refusal?.type !== type ? (
                      <p className="t-body mt-[var(--s2)] font-semibold" role="status"><span aria-hidden="true">✓ </span>Saved</p>
                    ) : null}
                    {refusal?.type === type ? (
                      <div className="mt-[var(--s2)]" role="alert">
                        {/* ▲ is the CANNOT_BE_DONE glyph, never the medical red. */}
                        <p className="t-body font-semibold"><span aria-hidden="true">▲ </span>NOT SAVED</p>
                        <p className="t-body mt-[var(--s1)]">{refusal.message}</p>
                      </div>
                    ) : null}
                  </section>
                );
              })}

              <p className="t-body mt-[var(--s3)]">
                Saving replaces that one limit; the old one stays in the history below. Nothing here blocks training — the coach decides.
              </p>

              {reading.history.length > 0 ? (
                <details className="mt-[var(--s3)]">
                  <summary className="t-label">Limit history ({reading.history.length})</summary>
                  <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                    {reading.history.map((item) => (
                      <li key={item.limit_id} className="t-data">
                        {formatGymDateNumeric(item.set_at)} · {item.set_by_name} · {describeLimit(item)}{item.note ? ` · ${item.note}` : ''}
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
