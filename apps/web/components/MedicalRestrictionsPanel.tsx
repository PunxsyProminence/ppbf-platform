'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { apiBase } from '@/lib/apiBase';
import { refusalWords } from '@/src/lib/serverRefusalWords';
import { RestrictedMark } from '@/components/MedicalRestrictionNotice';
import { getRoleSessionSnapshot, subscribeRoleSession } from '@/components/roleSession';

// USA Boxing medical restrictions, the staff record (Backbone P22, lane P22a).
// Rendered on Athlete Safety (/coach/athlete-safety; the old page
// /coach/medical-restrictions opens that section), never on the Sports
// Medicine clearance board: that board's 2026-08-15 rule is "clearance and holds
// only, never diagnoses or clinical detail", and Jason has twice put records of
// this kind on their own page linked from it (OD-2026-10-04-001, the injury
// log; OD-2026-10-04-017, the sparring cap editor).
//
// ONE ATHLETE (lane AS-5). Given `athleteId`, the panel shows that athlete and
// offers no member picker of its own: the page has already chosen. The page
// remounts it (a key) for another athlete, so nothing of one shows under another.
//
// WHO SEES WHAT. This is the staff view: the roles that may write a restriction
// (a coach of this gym, organization_admin, admin; Overwatch's approved design,
// "staff: full row") see the whole record -- source, loss of consciousness,
// dates, note, incident link, release and LBC dates, and whether it was marked
// entered in error, with the reason. The member and their parent never reach
// this page or its route; what they see is a separate, narrower view (OW25-06
// A: on file, minimum end date, release needed).
//
// It reimplements NO authorization. The route decides standing, the roles that
// may void, the set-once rule and every date check; this sends the form and
// shows what the server answered. The void control is hidden from a coach only
// because the route would refuse it.

interface RosterAthlete {
  athlete_id: string;
  full_name?: string;
}

type RestrictionState = 'voided' | 'not_started' | 'in_force' | 'release_needed' | 'lifted';

interface StaffRestriction {
  restriction_id: string;
  athlete_id: string;
  start_date: string;
  minimum_end_date: string;
  release_signed_on: string | null;
  lbc_informed_on: string | null;
  source: string;
  loss_of_consciousness: string;
  linked_incident_id: string | null;
  note: string;
  voided_at: string | null;
  void_reason: string | null;
  state: RestrictionState;
}

const SOURCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'ringside_affidavit', label: 'Ringside Restriction Affidavit' },
  { value: 'training_knockout_or_concussion', label: 'Training knockout or concussion' },
  { value: 'other', label: 'Other' },
];

const LOC_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'under_1_min', label: 'Under 1 minute' },
  { value: 'over_1_min', label: 'Over 1 minute' },
  { value: 'unknown', label: 'Unknown' },
];

const STATE_WORDS: Record<RestrictionState, string> = {
  in_force: 'In force',
  release_needed: 'In force — release needed',
  not_started: 'Starts later',
  lifted: 'Lifted — release on file',
  voided: 'Marked entered in error',
};

// NOTHING PRE-PICKED (Jason's card OW25-36 "A: 'Choose…', Save asks for both
// (Recommended)"). Source and Loss of consciousness start empty, at "Choose…",
// and Save refuses until both are chosen. A pre-picked "None" saved an answer
// nobody gave whenever a coach skipped the field. The route refuses a missing
// value too (requiredEnum in the route), and the columns have no default.
const EMPTY_RECORD = {
  source: '',
  loss_of_consciousness: '',
  start_date: '',
  minimum_end_date: '',
  linked_incident_id: '',
  note: '',
};

// GYM-FLOOR SIZE (OD-2026-11-17-009 ruling 4, OW25-37 A). The route's layout
// marks the page kiosk, which lifts .btn, .t-body and .t-label. Three things it
// does not reach are sized here: .input/.select/.textarea (an unlayered 46px
// that outranks the layered kiosk floor, so each wears input--kiosk, as
// Workout templates does), and .alert-title/.alert-msg/.working (unlayered
// fixed sizes; only an inline size outranks them).
const KIOSK_TEXT = { fontSize: 'var(--t-md)' } as const;
// .alert-title's `font` shorthand also sets line-height 1, which crowds a wrapped 19.1px title.
const KIOSK_TITLE = { fontSize: 'var(--t-md)', lineHeight: 1.25 } as const;

// The states in which the restriction is in force (the gate refuses sparring):
// these carry the Restricted mark (OD-2026-11-17-009 ruling 5, OW25-38 A).
const IN_FORCE_STATES: ReadonlySet<RestrictionState> = new Set(['in_force', 'release_needed']);

/** Rows the server sent that this screen could not show, said as a count (never dropped silently). */
function hiddenWords(count: number): string {
  return count === 1 ? '1 record could not be shown.' : `${count} records could not be shown.`;
}

function labelFor(options: ReadonlyArray<{ value: string; label: string }>, value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** 'YYYY-MM-DD' as M/D/YYYY, read as a calendar day (never through a time zone). */
function dayWords(day: string | null): string {
  if (!day) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

function isStaffRestriction(value: unknown): value is StaffRestriction {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.restriction_id === 'string'
    && typeof row.athlete_id === 'string'
    && typeof row.start_date === 'string'
    && typeof row.minimum_end_date === 'string'
    && typeof row.source === 'string'
    && typeof row.loss_of_consciousness === 'string'
    && typeof row.state === 'string'
    && row.state in STATE_WORDS;
}

export default function MedicalRestrictionsPanel({
  athletes = [],
  athleteId: chosenAthlete,
}: { athletes?: readonly RosterAthlete[]; athleteId?: string }) {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  // The client session names a gym admin 'admin' (ClubRole); the route admits
  // organization_admin and admin to void and refuses everyone else.
  const viewerCanVoid = session?.role === 'admin';

  const [athleteId, setAthleteId] = useState(chosenAthlete ?? '');
  const [rows, setRows] = useState<StaffRestriction[] | null>(null);
  // Rows the server sent that failed the shape check. Counted, so the screen
  // never reads "No medical restriction on file" while one exists (P2).
  const [hiddenCount, setHiddenCount] = useState(0);
  const [readError, setReadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [record, setRecord] = useState(EMPTY_RECORD);
  const [dates, setDates] = useState<Record<string, string>>({});
  // The athlete the panel is showing NOW. A read that comes back after the
  // coach picked someone else must not paint that other child's list.
  const shownFor = useRef('');

  const read = useCallback(async (forAthlete: string) => {
    shownFor.current = forAthlete;
    setRows(null);
    setHiddenCount(0);
    setReadError(null);
    if (!forAthlete) return;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/coach/medical-restrictions?athlete_id=${encodeURIComponent(forAthlete)}`,
        { method: 'GET', credentials: 'include' },
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string; restrictions?: unknown };
      if (shownFor.current !== forAthlete) return;
      if (!response.ok || !Array.isArray(payload.restrictions)) {
        setReadError(refusalWords({ error: payload.error, status: response.status }));
        return;
      }
      const shown = payload.restrictions.filter(isStaffRestriction);
      setHiddenCount(payload.restrictions.length - shown.length);
      setRows(shown);
    } catch {
      if (shownFor.current === forAthlete) setReadError('The medical restrictions could not be read. Nothing is shown as clear because of it.');
    }
  }, []);

  // The athlete the page chose: read once, on mount. The read is the outside
  // system this effect keeps in step with; its first set only clears the list.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (chosenAthlete) void read(chosenAthlete);
  }, [chosenAthlete, read]);

  const chooseAthlete = (next: string) => {
    setAthleteId(next);
    setRefusal(null);
    setRecordOpen(false);
    setRecord(EMPTY_RECORD);
    setDates({});
    void read(next);
  };

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setRefusal(null);
    const forAthlete = athleteId;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/medical-restrictions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (shownFor.current === forAthlete) setRefusal(refusalWords({ error: payload.error, status: response.status }));
        return false;
      }
      return true;
    } catch {
      if (shownFor.current === forAthlete) setRefusal('Nothing was saved: the request did not reach the server.');
      return false;
    } finally {
      setBusy(false);
      // Re-read so the list on screen is what the server says, never what this
      // form assumed -- but only while the same member is still shown. The
      // member picker is also locked while a save runs; this covers the rest.
      if (shownFor.current === forAthlete) await read(forAthlete);
    }
  };

  const submitRecord = async () => {
    if (!record.source || !record.loss_of_consciousness) {
      setRefusal('Choose a Source and a Loss of consciousness answer; Save needs both.');
      return;
    }
    if (!record.start_date || !record.minimum_end_date) {
      setRefusal('Enter the start date and the minimum end date.');
      return;
    }
    const saved = await post({
      action: 'record',
      athlete_id: athleteId,
      source: record.source,
      loss_of_consciousness: record.loss_of_consciousness,
      start_date: record.start_date,
      minimum_end_date: record.minimum_end_date,
      ...(record.linked_incident_id.trim() ? { linked_incident_id: record.linked_incident_id.trim() } : {}),
      ...(record.note.trim() ? { note: record.note.trim() } : {}),
    });
    if (saved) {
      setRecordOpen(false);
      setRecord(EMPTY_RECORD);
    }
  };

  const dateKey = (restrictionId: string, field: string) => `${restrictionId}:${field}`;

  const submitDate = async (restrictionId: string, action: 'release' | 'lbc_informed') => {
    const field = action === 'release' ? 'release_signed_on' : 'lbc_informed_on';
    const value = dates[dateKey(restrictionId, field)] ?? '';
    if (!value) {
      setRefusal('Enter the date first.');
      return;
    }
    await post({ action, restriction_id: restrictionId, [field]: value });
  };

  const submitVoid = async (restrictionId: string) => {
    const reason = (dates[dateKey(restrictionId, 'void_reason')] ?? '').trim();
    if (!reason) {
      setRefusal('Say why this record was entered in error.');
      return;
    }
    await post({ action: 'void', restriction_id: restrictionId, reason });
  };

  return (
    <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]" aria-label="Medical restrictions">
      <p className="t-body">
        A restriction applies from its start date until its minimum end date has passed and the date the
        physician&apos;s release was signed is on file. Record that date here once it is signed; nothing else ends
        it. A record entered against the wrong member or with wrong dates is marked entered in error by a gym admin,
        and kept.
      </p>

      {chosenAthlete === undefined ? (
        <div className="field mt-[var(--s3)]">
          <label className="t-label" htmlFor="medical-restrictions-athlete">Member</label>
          <select
            id="medical-restrictions-athlete"
            className="select input--kiosk"
            value={athleteId}
            // Locked while a save, date or void is in flight, so its answer and
            // re-read can only ever belong to the member on screen.
            disabled={busy}
            aria-busy={busy}
            onChange={(event) => chooseAthlete(event.target.value)}
          >
            <option value="">Choose a member</option>
            {athletes.map((athlete) => (
              <option key={athlete.athlete_id} value={athlete.athlete_id}>
                {athlete.full_name || athlete.athlete_id}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {athleteId ? (
        <div className="mt-[var(--s3)]">
          {/* Above the list, so it is read before any row looks like the whole record. */}
          {rows !== null && !readError && hiddenCount > 0 ? (
            <p className="t-body mb-[var(--s3)]" data-testid="medical-restrictions-hidden">{hiddenWords(hiddenCount)}</p>
          ) : null}
          {readError ? (
            <div className="alert alert--warning" role="alert">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title" style={KIOSK_TITLE}>Not read</p>
                <p className="alert-msg" style={KIOSK_TEXT}>{readError}</p>
              </div>
            </div>
          ) : rows === null ? (
            <span className="working" style={KIOSK_TEXT}>Reading medical restrictions...</span>
          ) : rows.length === 0 ? (
            // "None on file" only when the server sent none; a row this screen
            // could not show is counted above instead.
            hiddenCount === 0 ? <p className="t-body">No medical restriction on file for this member.</p> : null
          ) : (
            <ul className="grid gap-[var(--s3)]" aria-label="Medical restrictions on file">
              {rows.map((row) => {
                const releaseKey = dateKey(row.restriction_id, 'release_signed_on');
                const lbcKey = dateKey(row.restriction_id, 'lbc_informed_on');
                const voidKey = dateKey(row.restriction_id, 'void_reason');
                const open = row.state !== 'voided';
                return (
                  <li key={row.restriction_id} className="rounded-[var(--r-md)] border border-[color:var(--bone-300)] p-[var(--s3)]">
                    <p className="t-label flex flex-wrap items-center gap-[var(--s2)]">
                      {IN_FORCE_STATES.has(row.state) ? <RestrictedMark /> : null}
                      <span>{STATE_WORDS[row.state]}</span>
                    </p>
                    <p className="t-body mt-[var(--s2)]">
                      From {dayWords(row.start_date)}; minimum end date {dayWords(row.minimum_end_date)}.
                    </p>
                    <p className="t-body">
                      Source: {labelFor(SOURCES, row.source)}. Loss of consciousness: {labelFor(LOC_VALUES, row.loss_of_consciousness)}.
                    </p>
                    <p className="t-body">
                      {row.release_signed_on
                        ? `Physician's release signed ${dayWords(row.release_signed_on)}.`
                        : "Physician's release: not on file."}
                      {' '}
                      {row.lbc_informed_on ? `LBC informed ${dayWords(row.lbc_informed_on)}.` : 'LBC: not yet informed.'}
                    </p>
                    {row.linked_incident_id ? <p className="t-body">Incident: {row.linked_incident_id}</p> : null}
                    {row.note ? <p className="t-body">Staff note: {row.note}</p> : null}
                    {row.voided_at ? (
                      <p className="t-body">
                        Marked entered in error{row.void_reason ? `: ${row.void_reason}` : ''}.
                      </p>
                    ) : null}

                    {open && !row.release_signed_on ? (
                      <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
                        <div className="field">
                          <label className="t-label" htmlFor={`release-${row.restriction_id}`}>Date the release was signed</label>
                          <input
                            id={`release-${row.restriction_id}`}
                            type="date"
                            className="input input--kiosk"
                            value={dates[releaseKey] ?? ''}
                            onChange={(event) => setDates((d) => ({ ...d, [releaseKey]: event.target.value }))}
                          />
                        </div>
                        <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => void submitDate(row.restriction_id, 'release')}>
                          Record release
                        </button>
                      </div>
                    ) : null}

                    {open && !row.lbc_informed_on ? (
                      <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
                        <div className="field">
                          <label className="t-label" htmlFor={`lbc-${row.restriction_id}`}>Date the LBC was informed</label>
                          <input
                            id={`lbc-${row.restriction_id}`}
                            type="date"
                            className="input input--kiosk"
                            value={dates[lbcKey] ?? ''}
                            onChange={(event) => setDates((d) => ({ ...d, [lbcKey]: event.target.value }))}
                          />
                        </div>
                        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void submitDate(row.restriction_id, 'lbc_informed')}>
                          Record LBC date
                        </button>
                      </div>
                    ) : null}

                    {open && viewerCanVoid ? (
                      <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s3)]">
                        <div className="field grow">
                          <label className="t-label" htmlFor={`void-${row.restriction_id}`}>
                            Entered in error? Say why (gym admin only)
                          </label>
                          <input
                            id={`void-${row.restriction_id}`}
                            className="input input--kiosk"
                            maxLength={500}
                            value={dates[voidKey] ?? ''}
                            onChange={(event) => setDates((d) => ({ ...d, [voidKey]: event.target.value }))}
                          />
                        </div>
                        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void submitVoid(row.restriction_id)}>
                          Mark entered in error
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {recordOpen ? (
            <div className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
              <p className="t-eyebrow">Record a medical restriction</p>
              <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="mr-source">Source</label>
                  <select id="mr-source" className="select input--kiosk" required value={record.source} onChange={(event) => setRecord((r) => ({ ...r, source: event.target.value }))}>
                    <option value="">Choose…</option>
                    {SOURCES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="mr-loc">Loss of consciousness</label>
                  <select id="mr-loc" className="select input--kiosk" required value={record.loss_of_consciousness} onChange={(event) => setRecord((r) => ({ ...r, loss_of_consciousness: event.target.value }))}>
                    <option value="">Choose…</option>
                    {LOC_VALUES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="mr-start">Start date</label>
                  <input id="mr-start" type="date" className="input input--kiosk" value={record.start_date} onChange={(event) => setRecord((r) => ({ ...r, start_date: event.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="mr-end">Minimum end date</label>
                  <input id="mr-end" type="date" className="input input--kiosk" value={record.minimum_end_date} onChange={(event) => setRecord((r) => ({ ...r, minimum_end_date: event.target.value }))} />
                </div>
              </div>
              <div className="field mt-[var(--s3)]">
                <label className="t-label" htmlFor="mr-incident">Incident id (optional)</label>
                <input id="mr-incident" className="input input--kiosk" maxLength={200} value={record.linked_incident_id} onChange={(event) => setRecord((r) => ({ ...r, linked_incident_id: event.target.value }))} />
              </div>
              <div className="field mt-[var(--s3)]">
                <label className="t-label" htmlFor="mr-note">Staff note (optional — the member and their parent never see this)</label>
                <textarea id="mr-note" className="textarea input--kiosk" rows={2} maxLength={2000} value={record.note} onChange={(event) => setRecord((r) => ({ ...r, note: event.target.value }))} />
              </div>
              <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                <button type="button" className="btn" disabled={busy} aria-busy={busy} onClick={() => void submitRecord()}>
                  {busy ? 'Saving…' : 'Save restriction'}
                </button>
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setRecordOpen(false); setRecord(EMPTY_RECORD); setRefusal(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : rows !== null && !readError ? (
            <button type="button" className="btn mt-[var(--s3)]" onClick={() => setRecordOpen(true)}>
              Record a restriction
            </button>
          ) : null}

          {refusal ? (
            <div className="mt-[var(--s3)]" role="alert">
              <span className="stamp stamp--brass stamp--flat stamp--kiosk">
                <i aria-hidden="true">▲</i> Not saved
              </span>
              <p className="t-body mt-[var(--s2)]">{refusal}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
