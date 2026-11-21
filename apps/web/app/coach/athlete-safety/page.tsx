'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import ClusterNav from '@/components/ClusterNav';
import MedicalRestrictionsPanel from '@/components/MedicalRestrictionsPanel';
import FamilyNotesPosted from '@/components/FamilyNotesPosted';
import {
  ATHLETE_SAFETY_PAGE,
  CLEARANCE_BOARD_PAGE,
  DECISION_LOOP_PAGE,
  POST_TO_FAMILY_SECTION,
  handOffArrivalAthlete,
  isPlainClick,
  takeArrivalAthlete,
} from '@/components/decisionLoopArrival';
import {
  CLEARANCE_UNREAD,
  clearanceBadge,
  readActiveHold,
  readClearance,
  whenPassed,
  type ActiveHold,
  type ClearanceReading,
} from '@/components/clearanceReading';
import { TRAINING_HOLD_GLYPH, TRAINING_HOLD_LABEL } from '@/components/RefusalStamp';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import ReturnPlanBlock, { type Outcome } from '@/components/ReturnPlanBlock';
import WorkAxis from '@/components/WorkAxis';
import { painScoreLabel } from '@/src/shared/painScoreLabel';

// ATHLETE SAFETY (S2-3 "A: One job page"; lane AS-5): one athlete's Injury
// Record, Medical Restrictions and the family's page, on one page. It is not
// the Clearance Board: that board stays "clearance + holds only" (2026-08-15,
// OD-2026-11-11-002; AS-5 Q1 = A), and holds are placed, lifted and clearance
// set there only (Q2 = A). The athlete arrives in page memory, never in the
// address (#1474 Q2 = C; Q3 = A); the old addresses /coach/injuries and
// /coach/medical-restrictions open their sections here by #anchor.
//
// The Injury Record section is the coach's injury record (map item 11). It was
// a separate page, linked from the sports-medicine board, because that board's
// surface rule (owner decision 2026-08-15) keeps body areas and clinical detail
// off it; Jason chose that page 2026-10-04.
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
  painReports: Array<{ near_miss_id: string; severity: string; pain_score?: number | null; created_at: string }>;
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

/** Active plans of the athlete that no listed injury links to (a plan whose link failed, or one unlinked since), worded for display. */
function loosePlansOf(injuries: Injury[], candidates: Candidates): string[] {
  const linked = new Set(injuries.map((i) => i.linked_rtt_plan_id));
  return candidates.plans
    .filter((p) => p.status === 'active' && !linked.has(p.plan_id))
    .map((p) => `${words(p.triggering_event)} ${day(p.event_date)}`);
}

/** The page alert's title when it repeats what a Return plan block answered. */
const SAID_TITLE: Record<Outcome['kind'], string> = { saved: 'Saved', refused: 'Not done', unknown: 'Not known' };

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
}

/**
 * The sections an old address or a link scrolls to. The Injury Record is not
 * one: it sits under the pick and the Training Hold section, and scrolling to
 * it would only push both off the screen.
 */
const SECTIONS = ['medical-restrictions', POST_TO_FAMILY_SECTION];

/** How long a read may go unanswered before it is said as unread: the Decision Loop's roster wait. */
const READ_WAIT_MS = 15_000;

/**
 * The chosen athlete's clearance and active Training Hold, read only (AS-5
 * Q2 = A): clearance is set, and a hold placed and lifted, on the Clearance
 * Board, and this section links there, on this athlete. The reads, the badge
 * and the end-date timer are the board's (components/clearanceReading.ts;
 * Q-B1, Q-B2 and Q-B3 = A on #2041) and so are the words (Q-B4 = A), each cut
 * before the part about the board's own controls.
 *
 * NOTHING IS DRAWN UNTIL BOTH READS HAVE SETTLED. A read that found no hold
 * draws no hold mark, only the link (where the board draws its place button),
 * so a hold still being read must not sit under a badge as if it were "no
 * hold". While either read is out the section shows the heading and the name
 * and nothing else. A read that failed, or that is still unanswered after
 * READ_WAIT_MS, says the board's unread sentence for it; an answer that comes
 * after that is still shown.
 *
 * A CLEARANCE CAN RUN OUT WHILE THE PAGE IS OPEN. As on the board, a clearance
 * in force with an end date is read again when that date arrives, and the
 * section shows what the route answers; a re-read that fails keeps the end
 * date, so it goes on being asked. Two things differ from the board, both so
 * that a "cleared" past its end date cannot stay up on a slow or silent
 * network: an answer is shown when it is newer than the one on screen, not
 * only when it is the newest read sent (re-reads go out every 30 seconds, so
 * on a network slower than that the board would throw every answer away);
 * and a re-read still unanswered after READ_WAIT_MS is said as unread, as the
 * first read is.
 *
 * Mounted with `key={athleteId}`, so one athlete's reading is never on screen
 * under another's name.
 */
function TrainingHoldSection({ athleteId, name }: { readonly athleteId: string; readonly name: string }) {
  // undefined: not read yet. 'unavailable': nobody could look.
  const [hold, setHold] = useState<ActiveHold | null | 'unavailable' | undefined>(undefined);
  // undefined: not read yet. A clearance of 'unavailable': nobody could look.
  const [clearance, setClearance] = useState<ClearanceReading | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const overdue = setTimeout(() => {
      if (!live) return;
      setHold((now) => (now === undefined ? 'unavailable' : now));
      setClearance((now) => (now === undefined ? CLEARANCE_UNREAD : now));
    }, READ_WAIT_MS);
    let out = 2;
    const settled = () => {
      out -= 1;
      if (out === 0) clearTimeout(overdue);
    };
    readActiveHold(athleteId).then(
      (found) => { if (live) setHold(found); },
      () => { if (live) setHold('unavailable'); },
    ).finally(settled);
    // readClearance never throws: whatever goes wrong is 'unavailable'.
    void readClearance(athleteId).then((reading) => { if (live) setClearance(reading); }).finally(settled);
    return () => {
      live = false;
      clearTimeout(overdue);
    };
  }, [athleteId]);

  // The board's rule for which clearance is read again at its end date: one in
  // force, or one whose re-read failed and kept the date.
  const endsAt = clearance?.ends_at && (clearance.clearance === 'cleared' || clearance.clearance === 'unavailable')
    ? clearance.ends_at
    : null;
  // Re-reads are numbered as they are sent. `clearanceShownSeq` is the newest
  // one whose ANSWER is on screen: an older answer arriving late never paints
  // over it, and a newer one always may.
  const clearanceReadSeq = useRef(0);
  const clearanceShownSeq = useRef(0);
  useEffect(() => {
    if (!endsAt) return undefined;
    let live = true;
    const overdues = new Set<ReturnType<typeof setTimeout>>();
    const cancel = whenPassed(endsAt, () => {
      clearanceReadSeq.current += 1;
      const seq = clearanceReadSeq.current;
      // Unanswered after the wait, and nothing as new has answered: unread,
      // keeping the end date so it goes on being asked. Its answer, if it
      // comes later, is still shown.
      const overdue = setTimeout(() => {
        overdues.delete(overdue);
        if (live && clearanceShownSeq.current < seq) setClearance({ ...CLEARANCE_UNREAD, ends_at: endsAt });
      }, READ_WAIT_MS);
      overdues.add(overdue);
      void readClearance(athleteId).then((reading) => {
        clearTimeout(overdue);
        overdues.delete(overdue);
        if (!live || seq <= clearanceShownSeq.current) return;
        clearanceShownSeq.current = seq;
        setClearance(reading.clearance === 'unavailable' ? { ...reading, ends_at: endsAt } : reading);
      });
    });
    return () => {
      live = false;
      cancel();
      overdues.forEach((overdue) => clearTimeout(overdue));
    };
  }, [athleteId, endsAt]);

  const reading = hold === undefined ? undefined : clearance;
  const badge = reading ? clearanceBadge(reading) : null;

  return (
    <section id="training-hold" aria-busy={reading === undefined} className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
      <h2 className="t-command text-[length:var(--t-lg)]">Training Hold</h2>
      <p className="t-label mt-[var(--s1)]">{name}</p>
      {reading && badge && (
        <div data-clearance className="mt-[var(--s3)]">
          {/* The board's badge and dates for this athlete's clearance. Setting it is the board's. */}
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{badge.label}</span>
            {reading.effective_at ? (
              <span className="t-label">since {formatGymDateNumeric(reading.effective_at)}</span>
            ) : null}
            {reading.expired_at && formatGymDateNumeric(reading.expired_at) ? (
              <span className="t-label">expired {formatGymDateNumeric(reading.expired_at)}</span>
            ) : null}
          </div>
          {reading.clearance === null && (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">No clearance record on file.</p>
          )}
          {reading.clearance === 'cleared_expired' && (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              This clearance passed its end date, so it no longer counts.
            </p>
          )}
          {reading.clearance === 'unavailable' && (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              Clearance could not be read just now. Unknown is not cleared — check again before making a call that
              depends on it.
            </p>
          )}
        </div>
      )}
      {reading && hold === 'unavailable' && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
          Training hold could not be read just now. Unknown is not “no hold” — check again before making a call
          that depends on it.
        </p>
      )}
      {reading && hold && hold !== 'unavailable' && (
        <div data-refusal-stamp="training_hold" className="mt-[var(--s3)]">
          {/* The board's mark and words for a hold. No lift here: that is the board's. */}
          <span className="stamp stamp--brass stamp--flat stamp--kiosk">
            <i aria-hidden="true">{TRAINING_HOLD_GLYPH}</i>
            <span>{TRAINING_HOLD_LABEL}</span>
          </span>
          <div className="mat-paper mt-[var(--s2)] rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-700)] p-[var(--s3)]">
            <p className="t-eyebrow">Active Training Hold — {hold.scope.replaceAll('_', ' ')}</p>
            <p className="t-body mt-[var(--s2)]">{hold.athlete_explanation}</p>
            <p className="t-label mt-[var(--s2)]">
              Lifts when:{' '}
              {hold.lift_condition_text
                || 'Not written down — all this athlete is told is to ask whoever placed the hold. Tell them what ends it.'}
            </p>
          </div>
        </div>
      )}
      {reading && (
        <div className="mt-[var(--s3)]">
          <Link href={CLEARANCE_BOARD_PAGE} className="btn btn--ghost"
            onClick={(event) => { if (isPlainClick(event)) handOffArrivalAthlete(athleteId, CLEARANCE_BOARD_PAGE); }}>
            Clearance Board
          </Link>
        </div>
      )}
    </section>
  );
}

export default function AthleteSafetyPage() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  // The roster could not be read: the page says so and offers no pick (as the
  // Medical Restrictions page did), rather than "Loading roster..." for ever.
  const [rosterFailed, setRosterFailed] = useState(false);
  const [athleteId, setAthleteId] = useState('');
  // "Find an athlete" narrows the pick, as on the Clearance Board (AS-5 Q8 = A).
  const [findText, setFindText] = useState('');
  // An athlete handed over by a link, taken once (a second effect run must not take it again).
  const arrivalRef = useRef<string | null | undefined>(undefined);
  // The section an old address asked for, opened once the athlete's injuries are read.
  const scrollToRef = useRef<string | null | undefined>(undefined);
  const [injuries, setInjuries] = useState<Injury[] | null>(null);
  const [candidates, setCandidates] = useState<Candidates>(NO_CANDIDATES);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean; title?: string } | null>(null);
  // True while the injuries of the athlete on screen are being read again with the list kept up.
  const [rereading, setRereading] = useState(false);
  // True while a Return plan block has a write in flight. With `busy` and
  // `rereading` it locks the athlete picker and every save on the page, so a
  // block's answer always comes back to the athlete and the list it was sent from.
  const [blockBusy, setBlockBusy] = useState(false);
  // True while the Medical Restrictions panel has a write out: the pick is
  // locked then too, so its answer is never lost by moving to another athlete.
  const [panelBusy, setPanelBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  // The athlete on screen now. A reply that arrives for an athlete no longer
  // selected is dropped, so one child's injuries never show under another's name.
  const current = useRef('');
  const fail = (text: string) => setMessage({ text, error: true });

  // `keep`: a re-read of the athlete already on screen leaves the list mounted,
  // so what a coach has half-typed in a Return plan block survives saving
  // something else. A list that could not be read again is taken down, never
  // left on screen as if it were current.
  // `said`: what a Return plan block answered just before this re-read. It is
  // repeated on the page whenever the re-read takes that block off the screen
  // (the list could not be read, the injury left it, or a refused start's
  // injury now carries another plan), so an answer is never replaced by silence.
  const load = useCallback(async (id: string, keep = false, said: ({ injuryId: string } & Outcome) | null = null) => {
    const clear = () => { setInjuries(null); setCandidates(NO_CANDIDATES); };
    if (!keep) clear();
    if (!id) return;
    setRereading(keep);
    const lost = (text: string) => {
      if (current.current !== id) return;
      clear();
      setMessage(said
        ? { text: `${said.text} After that, the injuries could not be read again: ${text}`, error: true, title: SAID_TITLE[said.kind] }
        : { text, error: true });
    };
    try {
      const res = await fetch(`${apiBase()}/api/pilot/coach/injuries?athlete_id=${encodeURIComponent(id)}`, {
        method: 'GET', credentials: 'include',
      });
      if (!res.ok) {
        lost(await errorOf(res, 'Injuries could not be loaded.'));
        return;
      }
      const payload = (await res.json()) as { injuries?: unknown; candidates?: Candidates };
      if (current.current !== id) return;
      if (!Array.isArray(payload.injuries)) throw new Error('shape');
      const list = payload.injuries as Injury[];
      const offered = payload.candidates ?? NO_CANDIDATES;
      setInjuries(list);
      setCandidates(offered);
      if (said && said.kind !== 'saved') {
        const wanted = said.injuryId;
        const now = list.find((i) => i.injury_id === wanted);
        if (!now || (said.kind === 'refused' && now.linked_rtt_plan_id)) {
          // The route links after it creates, so even a refused start can have left a plan: name any that is loose.
          const loose = loosePlansOf(list, offered);
          setMessage({
            text: loose.length ? `${said.text} Return plans for this athlete not linked to an injury listed here: ${loose.join('; ')}.` : said.text,
            error: true, title: SAID_TITLE[said.kind],
          });
        }
      }
    } catch {
      lost('Injuries could not be loaded.');
    } finally {
      setRereading(false);
    }
  }, []);

  const choose = useCallback((id: string) => {
    current.current = id;
    setAthleteId(id);
    setForm(EMPTY_FORM);
    setEditing(null);
    setMessage(null);
    void load(id);
  }, [load]);

  useEffect(() => {
    if (arrivalRef.current === undefined) arrivalRef.current = takeArrivalAthlete(ATHLETE_SAFETY_PAGE);
    if (scrollToRef.current === undefined) {
      const wanted = window.location.hash.slice(1);
      scrollToRef.current = SECTIONS.includes(wanted) ? wanted : null;
    }
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        // The roster is the whole gym; offer only the athletes the injury route
        // will open for this person (for a coach, every live athlete of their
        // own gym since issue #1480).
        const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/injuries`, {
          method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.map((a) => a.athlete_id) }),
        });
        const allowed = allowedRes.ok ? ((await allowedRes.json()) as { athlete_ids?: unknown } | null) : null;
        if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
        const ids = new Set(allowed.athlete_ids as string[]);
        const offered = all.filter((a) => ids.has(a.athlete_id));
        setRoster(offered);
        // The handed-over athlete is chosen only if this list, the server's
        // answer to whom this person may open, holds them.
        const arriving = arrivalRef.current;
        arrivalRef.current = null;
        if (arriving && offered.some((a) => a.athlete_id === arriving)) choose(arriving);
      } catch {
        setRosterFailed(true);
        setMessage({ text: 'Your roster could not be loaded. Reload to try again.', error: true, title: 'Not loaded' });
      }
    })();
  }, [choose]);

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
      await load(current.current, true);
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

  // Once, after the athlete's injuries are read, so the sections above are in place.
  useEffect(() => {
    const wanted = scrollToRef.current;
    if (!athleteId || injuries === null || !wanted) return;
    scrollToRef.current = null;
    document.getElementById(wanted)?.scrollIntoView?.({ block: 'start' });
  }, [athleteId, injuries]);

  const findQuery = findText.trim().toLowerCase();
  // The athlete already chosen stays offered, so the pick never reads blank.
  const offered = (roster ?? []).filter(
    (a) => !findQuery || a.athlete_id === athleteId || (a.full_name ?? '').toLowerCase().includes(findQuery),
  );
  const matching = (roster ?? []).filter((a) => (a.full_name ?? '').toLowerCase().includes(findQuery)).length;

  const planLinked = form.linked_rtt_plan_id !== '';
  // Shown where a new plan would be started, so a second one is not started blind.
  const loosePlans = loosePlansOf(injuries ?? [], candidates);
  const locked = busy || rereading || blockBusy || panelBusy;
  // Said under each section's heading, so the athlete is named wherever the page opens.
  const chosen = (roster ?? []).find((a) => a.athlete_id === athleteId);
  const chosenName = chosen ? chosen.full_name || chosen.athlete_id : '';

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/athlete-safety" allowedRoles={['coach', 'admin']} room="clinic" showShellHeader={false}>
      <div className="mx-auto max-w-4xl">
        <div className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow text-[color:var(--brass-200)]">Sports Medicine</p>
          <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
            Athlete Safety
          </h1>
          <ClusterNav cluster="clinic" />
        </div>

        {message?.error && (
          <div className="alert alert--warning mb-[var(--s4)]" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              {/* Inline size: .alert-title/.alert-msg are unlayered fixed sizes the kiosk type floor (layout.tsx) does not reach. */}
              <p className="alert-title" style={{ fontSize: 'var(--t-md)', lineHeight: 1.25 }}>{message.title ?? 'Not done'}</p>
              <p className="alert-msg" style={{ fontSize: 'var(--t-md)' }}>{message.text}</p>
            </div>
          </div>
        )}
        {message && !message.error && <p className="t-body mb-[var(--s4)]" role="status">{message.text}</p>}

        {!rosterFailed && (
        <div className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
        {roster && roster.length > 0 && (
          <div className="field mb-[var(--s4)]">
            {/* The Clearance Board's Find box and count, in the same words. */}
            <label className="t-label" htmlFor="athlete-safety-find">Find an athlete</label>
            <input id="athlete-safety-find" type="search" className="input input--kiosk" value={findText}
              onChange={(e) => setFindText(e.target.value)} autoComplete="off" />
            <p aria-live="polite" className="t-label text-[color:var(--bone-400)]">
              {findQuery
                ? `${matching} of ${roster.length} ${roster.length === 1 ? 'athlete matches' : 'athletes match'}.`
                : `${roster.length} ${roster.length === 1 ? 'athlete' : 'athletes'}.`}
            </p>
          </div>
        )}
        <div className="field">
          <label className="t-label" htmlFor="injury-athlete">Athlete</label>
          <select id="injury-athlete" className="select input--kiosk" value={athleteId} onChange={(e) => choose(e.target.value)} disabled={!roster || locked}>
            <option value="">{!roster ? 'Loading roster...' : roster.length ? 'Choose an athlete' : 'No athletes in your gym'}</option>
            {offered.map((a) => (
              <option key={a.athlete_id} value={a.athlete_id}>{a.full_name || a.athlete_id}</option>
            ))}
          </select>
        </div>
        </div>
        )}

        {athleteId && <TrainingHoldSection key={athleteId} athleteId={athleteId} name={chosenName} />}

        {athleteId && (
        <section id="injury-record" className="mb-[var(--s5)]">
        <div className="mat-leather mb-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s4)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Injury Record</h2>
          <p className="t-label mt-[var(--s1)]">{chosenName}</p>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record what the athlete, a parent, a coach or a clinician reported, and say which. This is a record, not a
            diagnosis, and it does not stop training: place a Training Hold for that, then link it here.
          </p>
        </div>
        {injuries === null && !message && <p className="working">Loading injuries...</p>}

        {injuries && (
          <section aria-label="Injuries" aria-busy={rereading} className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            {rereading && <p className="t-body mb-[var(--s3)]" role="status">Reading the injuries again…</p>}
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
                      <ReturnPlanBlock key={i.linked_rtt_plan_id ?? 'none'} athleteId={athleteId} planId={i.linked_rtt_plan_id}
                        injuryId={i.injury_id} injuryDate={i.injury_date} expectedBack={i.expected_return_date}
                        editing={editing === i.injury_id} pageBusy={locked} loosePlans={loosePlans} onSending={setBlockBusy}
                        onChanged={(tried) => void load(current.current, true, { injuryId: i.injury_id, ...tried })} />
                      <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                        <button type="button" className="btn btn--ghost" disabled={locked}
                          onClick={() => { setEditing(i.injury_id); setForm(formFrom(i)); setMessage(null); }}>
                          Edit
                        </button>
                        <button type="button" className="btn btn--ghost" disabled={locked}
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
            <h3 className="t-label mb-[var(--s3)]">{editing ? 'Edit injury' : 'Record an injury'}</h3>
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
                  {candidates.painReports.map((n) => <option key={n.near_miss_id} value={n.near_miss_id}>{painScoreLabel(n.pain_score)} {stamp(n.created_at)}</option>)}
                </select></div>
            </div>
            <div className="mt-[var(--s4)] flex gap-[var(--s2)]">
              <button type="submit" className="btn" disabled={locked}>{editing ? 'Save changes' : 'Record injury'}</button>
              {editing && (
                <button type="button" className="btn btn--ghost" disabled={locked} onClick={() => { setEditing(null); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
        </section>
        )}

        {athleteId && (
          <section id="medical-restrictions" className="mb-[var(--s5)]">
            <div className="mat-leather mb-[var(--s3)] rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-command text-[length:var(--t-lg)]">Medical Restrictions</h2>
              <p className="t-label mt-[var(--s1)]">{chosenName}</p>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                USA Boxing medical restrictions: from a ringside Restriction Affidavit, a training knockout or
                concussion, or another source. The app stores the dates, not the documents.
              </p>
            </div>
            <MedicalRestrictionsPanel key={athleteId} athleteId={athleteId} onBusy={setPanelBusy} />
          </section>
        )}

        {athleteId && (
          <section id={POST_TO_FAMILY_SECTION} className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-lg)]">Post to the Family&apos;s Page</h2>
            <p className="t-label mt-[var(--s1)] mb-[var(--s3)]">{chosenName}</p>
            <FamilyNotesPosted athleteId={athleteId} refreshKey={0} />
            {/* The post itself is written on the Decision Loop (AS-5 Q7b = A). */}
            <Link href={`${DECISION_LOOP_PAGE}#${POST_TO_FAMILY_SECTION}`} className="btn btn--ghost mt-[var(--s3)]"
              onClick={(event) => { if (isPlainClick(event)) handOffArrivalAthlete(athleteId, DECISION_LOOP_PAGE); }}>
              Post to the Family&apos;s Page
            </Link>
          </section>
        )}

        {/* Holds and clearance are placed, lifted and set on the board (AS-5 Q2 = A). With an athlete
            chosen, the link is in the Training Hold section and opens the board on them. */}
        {!athleteId && (
          <div className="mt-[var(--s5)]">
            <Link href={CLEARANCE_BOARD_PAGE} className="btn btn--ghost">Clearance Board</Link>
          </div>
        )}
        <WorkAxis />
      </div>
    </RoleStandaloneView>
  );
}
