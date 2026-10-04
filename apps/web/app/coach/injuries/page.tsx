'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import WorkAxis from '@/components/WorkAxis';

// The coach's injury record (map item 11). A separate page, linked from the
// sports-medicine board, because that board's surface rule (owner decision
// 2026-08-15) keeps body areas and clinical detail off it; Jason chose this
// page 2026-10-04.
//
// NOT DIAGNOSTIC: the coach records what a person reported or a clinician
// stated, and says which. Nothing here pauses training -- a training hold does,
// and an injury only links to one. Authorization is entirely the route's
// (/api/pilot/coach/injuries): this page sends the form and shows what the
// server says back.
//
// The vocabularies below mirror athleteInjuries.ts (a client page cannot import
// the server module); page.test.tsx pins them to it.

const BODY_AREAS = [
  'head', 'face', 'neck', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand',
  'chest', 'ribs', 'abdomen', 'back', 'hip', 'groin', 'thigh', 'knee', 'lower_leg',
  'ankle', 'foot', 'other',
];
const TYPES: Record<string, string> = {
  sprain_strain: 'Sprain / strain', cut: 'Cut', fracture: 'Fracture', head_injury: 'Head injury', other: 'Other',
};
const CONTEXTS: Record<string, string> = { training: 'Training', competition: 'Competition' };
const REPORTED_BY: Record<string, string> = {
  athlete: 'The athlete told us', parent_guardian: 'A parent or guardian told us',
  coach_observed: 'A coach saw it', clinician: 'A clinician stated it',
};

interface RosterAthlete { athlete_id: string; full_name?: string }

interface Injury {
  injury_id: string;
  injury_date: string;
  body_area: string;
  injury_type: string;
  context: string;
  reported_by: string;
  staff_note: string;
  expected_return_date: string | null;
  returned_on: string | null;
  linked_rtt_plan_id: string | null;
  linked_hold_id: string | null;
  linked_clearance_status_id: string | null;
  linked_pain_report_id: string | null;
  plan_earliest_return_date: string | null;
}

interface Candidates {
  holds: Array<{ hold_id: string; scope: string; status: string; placed_at: string }>;
  plans: Array<{ plan_id: string; triggering_event: string; event_date: string; earliest_return_date: string | null; status: string }>;
  clearances: Array<{ status_id: string; status: string; effective_at: string }>;
  painReports: Array<{ near_miss_id: string; severity: string; created_at: string }>;
}

const NO_CANDIDATES: Candidates = { holds: [], plans: [], clearances: [], painReports: [] };

const EMPTY_FORM = {
  injury_date: '', body_area: 'other', injury_type: 'other', context: 'training', reported_by: 'athlete',
  staff_note: '', expected_return_date: '', returned_on: '',
  linked_rtt_plan_id: '', linked_hold_id: '', linked_clearance_status_id: '', linked_pain_report_id: '',
};
type Form = typeof EMPTY_FORM;

function words(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A date-only value (YYYY-MM-DD), shown as that calendar day. */
function day(value: string | null): string {
  return value ? formatGymDateNumeric(`${value.slice(0, 10)}T12:00:00Z`) ?? value : '';
}

/** A Postgres timestamptz text ('2026-09-01 01:30:00+00'), shown as the gym's local day, not UTC's. */
function stamp(value: string): string {
  const iso = value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return formatGymDateNumeric(iso) ?? value.slice(0, 10);
}

/** The current link stays visible even when it is older than the newest twenty offered. */
function keepCurrent(current: string, ids: string[]) {
  return current && !ids.includes(current) ? <option value={current}>Linked record (older)</option> : null;
}

/** Whole days between two YYYY-MM-DD dates -- arithmetic on what was entered, nothing inferred. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function formFrom(injury: Injury): Form {
  return {
    injury_date: injury.injury_date, body_area: injury.body_area, injury_type: injury.injury_type,
    context: injury.context, reported_by: injury.reported_by, staff_note: injury.staff_note,
    expected_return_date: injury.expected_return_date ?? '', returned_on: injury.returned_on ?? '',
    linked_rtt_plan_id: injury.linked_rtt_plan_id ?? '', linked_hold_id: injury.linked_hold_id ?? '',
    linked_clearance_status_id: injury.linked_clearance_status_id ?? '',
    linked_pain_report_id: injury.linked_pain_report_id ?? '',
  };
}

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
}

export default function CoachInjuriesPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [athleteId, setAthleteId] = useState('');
  const [injuries, setInjuries] = useState<Injury[] | null>(null);
  const [candidates, setCandidates] = useState<Candidates>(NO_CANDIDATES);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The athlete on screen now. A reply that arrives for an athlete no longer
  // selected is dropped, so one child's injuries never show under another's name.
  const current = useRef('');
  const fail = (text: string) => setMessage({ text, error: true });

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        setRoster(payload.items as RosterAthlete[]);
      } catch {
        fail('Your roster could not be loaded. Reload to try again.');
      }
    })();
  }, []);

  const load = useCallback(async (id: string) => {
    setInjuries(null);
    setCandidates(NO_CANDIDATES);
    if (!id) return;
    try {
      const res = await fetch(`${apiBase()}/api/pilot/coach/injuries?athlete_id=${encodeURIComponent(id)}`, {
        method: 'GET', credentials: 'include',
      });
      if (!res.ok) {
        const text = await errorOf(res, 'Injuries could not be loaded.');
        if (current.current === id) fail(text);
        return;
      }
      const payload = (await res.json()) as { injuries?: unknown; candidates?: Candidates };
      if (current.current !== id) return;
      if (!Array.isArray(payload.injuries)) throw new Error('shape');
      setInjuries(payload.injuries as Injury[]);
      setCandidates(payload.candidates ?? NO_CANDIDATES);
    } catch {
      if (current.current === id) fail('Injuries could not be loaded.');
    }
  }, []);

  const choose = (id: string) => {
    current.current = id;
    setAthleteId(id);
    setForm(EMPTY_FORM);
    setEditing(null);
    setMessage(null);
    void load(id);
  };

  const post = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/coach/injuries`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        fail(await errorOf(res, 'That was not saved.'));
        return;
      }
      setMessage({ text: done, error: false });
      setForm(EMPTY_FORM);
      setEditing(null);
      await load(current.current);
    } catch {
      fail('That was not saved: the connection failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    // The full record every time: an update replaces the record with what is sent.
    const fields = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]));
    void post(
      editing
        ? { action: 'update', injury_id: editing, ...fields }
        : { action: 'record', athlete_id: athleteId, ...fields },
      editing ? 'Injury updated.' : 'Injury recorded.',
    );
  };

  const field = (key: keyof Form) => ({
    id: `injury-${key}`,
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const planLinked = form.linked_rtt_plan_id !== '';

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/injuries" allowedRoles={['coach', 'admin']} room="clinic" showShellHeader={false}>
      <div className="mx-auto max-w-4xl">
        <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
          <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Injury Record
          </h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            Record what the athlete, a parent, a coach or a clinician reported, and say which. This is a record, not a
            diagnosis, and it does not pause training: place a training hold for that, then link it here.
          </p>
        </div>

        {message?.error && (
          <div className="alert alert--warning mb-[var(--s4)]" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Not done</p>
              <p className="alert-msg">{message.text}</p>
            </div>
          </div>
        )}
        {message && !message.error && <p className="t-body mb-[var(--s4)]" role="status">{message.text}</p>}

        <div className="field mb-[var(--s4)]">
          <label className="t-label" htmlFor="injury-athlete">Athlete</label>
          <select id="injury-athlete" className="select" value={athleteId} onChange={(e) => choose(e.target.value)} disabled={!roster || busy}>
            <option value="">{roster ? 'Choose an athlete' : 'Loading roster...'}</option>
            {(roster ?? []).map((a) => (
              <option key={a.athlete_id} value={a.athlete_id}>{a.full_name || a.athlete_id}</option>
            ))}
          </select>
        </div>

        {athleteId && injuries === null && !message && <p className="working">Loading injuries...</p>}

        {injuries && (
          <section aria-label="Injuries" className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            {injuries.length === 0 ? (
              <p className="t-body">No injuries recorded for this athlete.</p>
            ) : (
              <ul className="grid gap-[var(--s3)]">
                {injuries.map((i) => {
                  const expected = i.linked_rtt_plan_id ? i.plan_earliest_return_date : i.expected_return_date;
                  return (
                    <li key={i.injury_id} className="border-b border-[var(--hide-700)] pb-[var(--s3)]">
                      <p className="t-label">
                        {day(i.injury_date)} · {words(i.body_area)} · {TYPES[i.injury_type] ?? i.injury_type} · {CONTEXTS[i.context] ?? i.context}
                      </p>
                      <p className="t-body">{REPORTED_BY[i.reported_by] ?? i.reported_by}</p>
                      {expected && (
                        <p className="t-body">
                          Expected back {day(expected)}{i.linked_rtt_plan_id ? ' (from the return-to-training plan)' : ''}
                        </p>
                      )}
                      {i.returned_on && (
                        <p className="t-body">Returned {day(i.returned_on)} · {daysBetween(i.injury_date, i.returned_on)} days lost</p>
                      )}
                      {i.staff_note && <p className="t-body">Staff note: {i.staff_note}</p>}
                      <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => { setEditing(i.injury_id); setForm(formFrom(i)); setMessage(null); }}>
                          Edit
                        </button>
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => { if (window.confirm('Mark this injury as entered in error? It leaves the list.')) void post({ action: 'mark_entered_in_error', injury_id: i.injury_id }, 'Marked as entered in error.'); }}>
                          Entered in error
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {injuries && (
          <form aria-label={editing ? 'Edit injury' : 'Record an injury'} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]"
            onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2 className="t-label mb-[var(--s3)]">{editing ? 'Edit injury' : 'Record an injury'}</h2>
            <div className="grid gap-[var(--s3)] sm:grid-cols-2">
              <div className="field"><label className="t-label" htmlFor="injury-injury_date">Date of injury</label>
                <input type="date" className="input" required {...field('injury_date')} /></div>
              <div className="field"><label className="t-label" htmlFor="injury-body_area">Body area</label>
                <select className="select" {...field('body_area')}>
                  {BODY_AREAS.map((a) => <option key={a} value={a}>{words(a)}</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-injury_type">Type</label>
                <select className="select" {...field('injury_type')}>
                  {Object.entries(TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-context">When</label>
                <select className="select" {...field('context')}>
                  {Object.entries(CONTEXTS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-reported_by">Who it came from</label>
                <select className="select" {...field('reported_by')}>
                  {Object.entries(REPORTED_BY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-expected_return_date">Expected back</label>
                <input type="date" className="input" disabled={planLinked} {...field('expected_return_date')} />
                {planLinked && <p className="t-muted">The linked return-to-training plan holds this date.</p>}</div>
              <div className="field"><label className="t-label" htmlFor="injury-returned_on">Returned on</label>
                <input type="date" className="input" {...field('returned_on')} /></div>
            </div>
            <div className="field mt-[var(--s3)]"><label className="t-label" htmlFor="injury-staff_note">Staff note (what was reported or stated; staff only)</label>
              <textarea className="textarea" rows={2} maxLength={2000} {...field('staff_note')} /></div>
            <div className="mt-[var(--s3)] grid gap-[var(--s3)] sm:grid-cols-2">
              <div className="field"><label className="t-label" htmlFor="injury-linked_rtt_plan_id">Return-to-training plan</label>
                <select className="select" {...field('linked_rtt_plan_id')}
                  onChange={(e) => setForm((f) => ({ ...f, linked_rtt_plan_id: e.target.value, expected_return_date: e.target.value ? '' : f.expected_return_date }))}>
                  <option value="">None</option>
                  {keepCurrent(form.linked_rtt_plan_id, candidates.plans.map((p) => p.plan_id))}
                  {candidates.plans.map((p) => <option key={p.plan_id} value={p.plan_id}>{words(p.triggering_event)} {day(p.event_date)} ({p.status})</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-linked_hold_id">Training hold</label>
                <select className="select" {...field('linked_hold_id')}>
                  <option value="">None</option>
                  {keepCurrent(form.linked_hold_id, candidates.holds.map((h) => h.hold_id))}
                  {candidates.holds.map((h) => <option key={h.hold_id} value={h.hold_id}>{words(h.scope)} {stamp(h.placed_at)} ({h.status})</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-linked_clearance_status_id">Clearance record</label>
                <select className="select" {...field('linked_clearance_status_id')}>
                  <option value="">None</option>
                  {keepCurrent(form.linked_clearance_status_id, candidates.clearances.map((c) => c.status_id))}
                  {candidates.clearances.map((c) => <option key={c.status_id} value={c.status_id}>{words(c.status)} {stamp(c.effective_at)}</option>)}
                </select></div>
              <div className="field"><label className="t-label" htmlFor="injury-linked_pain_report_id">Athlete&apos;s pain report</label>
                <select className="select" {...field('linked_pain_report_id')}>
                  <option value="">None</option>
                  {keepCurrent(form.linked_pain_report_id, candidates.painReports.map((n) => n.near_miss_id))}
                  {candidates.painReports.map((n) => <option key={n.near_miss_id} value={n.near_miss_id}>{words(n.severity)} {stamp(n.created_at)}</option>)}
                </select></div>
            </div>
            <div className="mt-[var(--s4)] flex gap-[var(--s2)]">
              <button type="submit" className="btn" disabled={busy}>{editing ? 'Save changes' : 'Record injury'}</button>
              {editing && (
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        <div className="mt-[var(--s5)]">
          <Link href="/coach/sports-medicine" className="btn btn--ghost">Clearance Board</Link>
        </div>
        <WorkAxis />
      </div>
    </RoleStandaloneView>
  );
}
