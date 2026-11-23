'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/src/lib/apiBase';
import { humanizeContactLevel } from '@/src/lib/drillPresentation';
import { formatGymDay, gymDayIso } from '@/src/lib/gymTime';
import BackHome from '@/components/BackHome';
import ClusterNav from '@/components/ClusterNav';
import ContactCapPanel from '@/components/ContactCapPanel';
import MinorLimitsPanel from '@/components/MinorLimitsPanel';
import { RestrictedMark } from '@/components/MedicalRestrictionNotice';

/*
 * Coach floor entry for sparring exposure: what the coach SAW during one
 * sparring segment, for one athlete, and that athlete's recent entries.
 *
 * COUNTS ONLY. No damage score, no risk index, no recommended limit, no
 * clearance -- the sparring migration's own refusal and Jason's. The summary
 * below the form is the route's raw counts (segments, a plain sum of time,
 * segments by type) and nothing computed from them. The coach reads it and
 * decides.
 *
 * A FAILED READ IS NEVER "NO SPARRING". If the entries cannot be loaded the
 * page says so in words; an empty list only ever means the read succeeded and
 * found nothing in the window.
 *
 * The athlete picker is GET /api/pilot/coach/athletes, the same access set
 * the sparring route enforces, so the picker never offers a child the route
 * would refuse.
 *
 * THE COACH-SET CAP (map item 15). Each segment may carry its contact-ladder
 * stage (optional; left out = not recorded). The athlete's cap -- a number
 * a COACH set in the Sparring Caps section below, never the app's -- is shown in its own
 * section, beside the raw count of gym days with hard or open sparring in
 * the last 7 (sessions = gym days). After a save, the route's warnings are
 * shown under "Saved.": the entry is already saved, nothing is blocked, and
 * the coach decides (OD-2026-10-04-004). A cap that could not be read is
 * said as such -- never as "no cap". The "Recent sparring" section stays
 * counts only.
 *
 * SPARRING AND LIMITS (lane AS-5, S2-3 "A: One job page"; #2010 Q4-Q6, Q13;
 * #2131 QR1-QR4). This page is also where the Sparring Caps and Athlete Limits
 * pages went: their old addresses open those sections. With no athlete picked
 * each section lists every athlete it may show, as those pages did, narrowed
 * by "Find an athlete"; a pick narrows both to that athlete and opens their
 * panels. Each section keeps its own roster, the one its own route admits
 * (athletes/list cut to that route's accessible_athletes), so it never offers
 * an athlete its route would refuse.
 */

interface RosterAthlete { athlete_id: string; full_name?: string }
type SectionRoster = RosterAthlete[] | 'loading' | 'failed';

/** Every athlete in the gym, cut to those the given limits route will open for this person. */
async function accessibleRoster(all: RosterAthlete[], route: string): Promise<RosterAthlete[]> {
  const response = await fetch(`${apiBase()}/api/pilot/coach/${route}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.map((a) => a.athlete_id) }),
  });
  const allowed = response.ok ? ((await response.json()) as { athlete_ids?: unknown } | null) : null;
  if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
  const ids = new Set(allowed.athlete_ids as string[]);
  return all.filter((a) => ids.has(a.athlete_id));
}

/**
 * One limits section: Sparring Caps or Athlete Limits, in the words its own
 * page had. A roster that could not be read is never "no athletes".
 */
function LimitsSection({ id, title, intro, roster, settled, pickedId, findQuery, empty, notPicked, takeArrival, panel }: {
  id: string; title: string; intro: string; roster: SectionRoster; pickedId: string; findQuery: string; empty: string;
  /** Both sections' rosters are read, so the page above this one no longer grows. */
  settled: boolean;
  /** Said when the picked athlete is not one this section's route admits (copy PROPOSED, lane AS5-REST). */
  notPicked: string;
  /** True once, if the page was opened at this section's old address. */
  takeArrival: (id: string) => boolean;
  panel: (athlete: RosterAthlete, name: string) => ReactNode;
}) {
  const shown = Array.isArray(roster)
    ? roster.filter((a) => (pickedId ? a.athlete_id === pickedId : (a.full_name ?? '').toLowerCase().includes(findQuery)))
    : [];
  const sectionRef = useRef<HTMLElement>(null);
  // An old address opens its section once the section is on screen and both
  // rosters are read: here, not in the page, so the jump also waits for the
  // shell's sign-in check, and the caps list cannot grow above it afterwards.
  useEffect(() => {
    if (settled && takeArrival(id)) sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [settled, id, takeArrival]);
  // Every line about the list sits on the section's mat, never on the wall photo.
  return (
    <section id={id} ref={sectionRef} className="space-y-[var(--s3)]">
      <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
        <h2 className="t-command text-[length:var(--t-lg)]">{title}</h2>
        <p className="t-body text-[color:var(--bone-300)]">{intro}</p>
        {roster === 'failed' ? (
          <div className="alert alert--warning" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title" style={KIOSK_TITLE}>Not loaded</p>
              <p className="alert-msg" style={KIOSK_TEXT}>Your roster could not be loaded. Reload to try again.</p>
            </div>
          </div>
        ) : roster === 'loading' ? (
          <p className="t-body" role="status">Loading your roster…</p>
        ) : roster.length === 0 ? (
          <p className="t-body">{empty}</p>
        ) : pickedId && shown.length === 0 ? (
          <p className="t-body">{notPicked}</p>
        ) : shown.length === 0 ? (
          <p className="t-body">No athlete matches &ldquo;{findQuery}&rdquo;. Clear the box to see them all.</p>
        ) : findQuery && !pickedId ? (
          // What the Find box left in THIS list, in the board's words.
          <p className="t-label" aria-live="polite">
            {`${shown.length} of ${roster.length} ${roster.length === 1 ? 'athlete matches' : 'athletes match'}.`}
          </p>
        ) : null}
      </div>
      {Array.isArray(roster) && shown.length > 0 && (
        <ul className="space-y-[var(--s3)]">
          {shown.map((athlete) => (
            <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <span className="t-body font-semibold text-[color:var(--bone-100)]">{athlete.full_name || athlete.athlete_id}</span>
              {panel(athlete, athlete.full_name || athlete.athlete_id)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 19.1 px for text the kiosk type floor does not reach (bare text, unlayered .alert-* sizes). */
const KIOSK_TEXT = { fontSize: 'var(--t-md)' } as const;
/** .alert-title's `font` shorthand also sets line-height 1, which crowds a wrapped 19.1 px title. */
const KIOSK_TITLE = { fontSize: 'var(--t-md)', lineHeight: 1.25 } as const;

const SPARRING_TYPES = [
  ['technical', 'Technical'],
  ['play', 'Play'],
  ['conditioned', 'Conditioned'],
  ['game', 'Game'],
  ['hard', 'Hard'],
] as const;
const INTENSITIES = [['light', 'Light'], ['moderate', 'Moderate'], ['firm', 'Firm'], ['unclear', 'Unclear']] as const;
const HEAD_CONTACT = [
  ['none', 'None'], ['incidental', 'Incidental'], ['regular', 'Regular'], ['frequent', 'Frequent'], ['unclear', 'Unclear'],
] as const;
const PRESENTATIONS = [
  ['normal', 'Normal'], ['slowed', 'Slowed'], ['unsteady', 'Unsteady'], ['withdrawn', 'Withdrawn'], ['other_concern', 'Other concern'],
] as const;
const WINDOWS = [7, 28, 90] as const;
/** The contact ladder, lowest first; page.test.tsx pins it to the server's list. */
export const CONTACT_STAGES = ['none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring'] as const;
const STAGE_PAIRS = CONTACT_STAGES.map((stage) => [stage, humanizeContactLevel(stage)] as const);

const label = (pairs: ReadonlyArray<readonly [string, string]>, value: string | null) =>
  pairs.find(([key]) => key === value)?.[1] ?? value ?? '—';

interface AuthorizedAthlete { athlete_id: string; full_name: string }
interface StopRule { universal_rule_id: string; ordinal: number; condition_text: string }
interface Entry {
  exposure_id: string;
  sparring_day: string;
  segment_number: number;
  sparring_type: string;
  contact_stage?: string | null;
  time_under_impact_sec: number;
  round_equivalent: string | null;
  headgear_worn: boolean | null;
  glove_oz: number | null;
  coach_observed_intensity: string;
  coach_observed_head_contact: string;
  athlete_presentation: string | null;
  coach_note: string;
  stopped_early: boolean;
  stop_reason: string | null;
}
interface Counts {
  total_segments: number;
  total_time_under_impact_sec: number;
  segments_by_type: Record<string, number>;
}
interface Cap {
  highest_allowed_stage: string | null;
  max_hard_open_sessions_per_7_days: number | null;
  set_by_name?: string;
}
interface CapWarning { kind: string; message: string }
interface CapCheck {
  cap_state: 'set' | 'none' | 'unknown';
  cap: Cap | null;
  hard_open_days_in_7: number | null;
  through_day: string;
  warnings?: CapWarning[];
}
interface Recent {
  entries: Entry[];
  entries_truncated: boolean;
  counts: Counts;
  stop_rules: StopRule[];
  cap_check?: CapCheck;
}

function isCapCheck(value: unknown): value is CapCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as Record<string, unknown>;
  if (!['set', 'none', 'unknown'].includes(check.cap_state as string)) return false;
  if (check.cap_state === 'set' && (!check.cap || typeof check.cap !== 'object')) return false;
  if (typeof check.through_day !== 'string') return false;
  return check.hard_open_days_in_7 === null || typeof check.hard_open_days_in_7 === 'number';
}

/** A save's check must carry its warnings as a list of messages; anything else is "not checked". */
function isSaveCheck(value: unknown): value is CapCheck & { warnings: CapWarning[] } {
  if (!isCapCheck(value) || !Array.isArray(value.warnings)) return false;
  return value.warnings.every((w) => w && typeof w.kind === 'string' && typeof w.message === 'string');
}

/** Only these two mean the segment went OVER the cap; the rest mean it could not be fully checked. */
const OVER_KINDS: ReadonlySet<string> = new Set(['stage_above_cap', 'hard_open_days_over_cap']);

const minSec = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const EMPTY_FORM = {
  sessionDate: '',
  sparringType: '',
  contactStage: '',
  minutes: '',
  seconds: '',
  rounds: '',
  intensity: '',
  headContact: '',
  presentation: '',
  headgear: '',
  gloveOz: '',
  stoppedEarly: false,
  stopRuleId: '',
  stopReason: '',
  note: '',
};

export default function CoachSparringExposurePage() {
  const [athletes, setAthletes] = useState<AuthorizedAthlete[]>([]);
  const [rosterState, setRosterState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [athleteId, setAthleteId] = useState('');
  const [windowDays, setWindowDays] = useState<number>(28);
  /** Bumped after a save to re-read the entries through the abortable effect. */
  const [reloadTick, setReloadTick] = useState(0);
  const [recent, setRecent] = useState<Recent | null>(null);
  const [recentState, setRecentState] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle');
  const [form, setForm] = useState({ ...EMPTY_FORM, sessionDate: gymDayIso() ?? '' });
  const [saving, setSaving] = useState(false);
  // `restricted`: the save was refused by the USA Boxing medical restriction
  // gate (403, code MEDICAL_RESTRICTION), shown with the Restricted mark.
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; restricted?: boolean } | null>(null);
  /** The cap check the route returned with the last save: warnings, or why none could be given. */
  const [savedCheck, setSavedCheck] = useState<CapCheck | 'unreadable' | null>(null);
  /** USA Boxing medical restriction note the route returned with the last save (P22b, Q8). */
  const [restrictionNote, setRestrictionNote] = useState<string | null>(null);
  // "Find an athlete" narrows the pick and both limits sections (#2010 Q8 = A; app scrub CS-05).
  const [findText, setFindText] = useState('');
  const [capsRoster, setCapsRoster] = useState<SectionRoster>('loading');
  const [limitsRoster, setLimitsRoster] = useState<SectionRoster>('loading');
  // Saves made in the Sparring Caps section, per athlete, so the two other
  // places on this page that show that athlete's cap read it again.
  const [capSaves, setCapSaves] = useState<Record<string, number>>({});
  // The section an old address asked for (#sparring-caps, #athlete-limits), opened once, by that section.
  const arrivalRef = useRef<string | null | undefined>(undefined);
  const takeArrival = useCallback((id: string) => {
    if (arrivalRef.current === undefined) arrivalRef.current = window.location.hash.slice(1) || null;
    if (arrivalRef.current !== id) return false;
    arrivalRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      let all: RosterAthlete[];
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        all = payload.items as RosterAthlete[];
      } catch {
        if (live) { setCapsRoster('failed'); setLimitsRoster('failed'); }
        return;
      }
      await Promise.all([
        accessibleRoster(all, 'athlete-contact-caps').catch(() => 'failed' as const)
          .then((r) => { if (live) setCapsRoster(r); }),
        accessibleRoster(all, 'athlete-minor-limits').catch(() => 'failed' as const)
          .then((r) => { if (live) setLimitsRoster(r); }),
      ]);
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET', credentials: 'include', signal: controller.signal,
        });
        if (!response.ok) throw new Error('roster');
        const payload = (await response.json()) as { items?: AuthorizedAthlete[] };
        setAthletes(payload.items ?? []);
        setRosterState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setAthletes([]);
        setRosterState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  const fetchRecent = useCallback(async (id: string, days: number, signal?: AbortSignal): Promise<Recent> => {
    const response = await fetch(
      `${apiBase()}/api/pilot/coach/sparring-exposure?athlete_id=${encodeURIComponent(id)}&days=${days}`,
      { method: 'GET', credentials: 'include', signal },
    );
    if (!response.ok) throw new Error('recent');
    return (await response.json()) as Recent;
  }, []);

  // 'loading' is set by whoever changed the athlete or window; this only
  // lands the answer. The abort keeps a slow read for the previous athlete
  // from arriving under the next one.
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await fetchRecent(athleteId, windowDays, controller.signal);
        setRecent(data);
        setRecentState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setRecent(null);
        setRecentState('unavailable');
      }
    })();
    return () => controller.abort();
  }, [athleteId, windowDays, reloadTick, fetchRecent]);

  const set = (patch: Partial<typeof EMPTY_FORM>) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !ready) return;
    setMessage(null);
    const body: Record<string, unknown> = {
      athlete_id: athleteId,
      session_date: form.sessionDate,
      sparring_type: form.sparringType,
      time_under_impact_sec: seconds,
      coach_observed_intensity: form.intensity,
      coach_observed_head_contact: form.headContact,
      athlete_presentation: form.presentation,
    };
    if (form.contactStage) body.contact_stage = form.contactStage;
    if (form.rounds) body.round_equivalent = Number(form.rounds);
    if (form.headgear) body.headgear_worn = form.headgear === 'yes';
    if (form.gloveOz) body.glove_oz = Number(form.gloveOz);
    if (form.note.trim()) body.coach_note = form.note;
    if (form.stoppedEarly) {
      body.stopped_early = true;
      body.stop_reason = form.stopReason;
      if (form.stopRuleId) body.stop_rule_id = form.stopRuleId;
    }

    setSaving(true);
    setSavedCheck(null);
    setRestrictionNote(null);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/sparring-exposure`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
        setMessage({
          kind: 'error',
          text: payload.error ?? 'Not saved. Try again.',
          restricted: response.status === 403 && payload.code === 'MEDICAL_RESTRICTION',
        });
        return;
      }
      setMessage({ kind: 'ok', text: 'Saved.' });
      const saved = (await response.json().catch(() => null)) as
        { cap_check?: unknown; medical_restriction_note?: { message?: unknown } } | null;
      setSavedCheck(isSaveCheck(saved?.cap_check) ? saved.cap_check : 'unreadable');
      const noteText = saved?.medical_restriction_note?.message;
      setRestrictionNote(typeof noteText === 'string' ? noteText : null);
      // Keep the day, the stage and the gear for the next round; clear what was observed.
      setForm((current) => ({
        ...EMPTY_FORM,
        sessionDate: current.sessionDate,
        contactStage: current.contactStage,
        headgear: current.headgear,
        gloveOz: current.gloveOz,
      }));
      // Re-read through the effect, not here: its cleanup aborts any read
      // still in flight, so an older response cannot replace the fresh one.
      setRecentState('loading');
      setReloadTick((tick) => tick + 1);
    } catch {
      setMessage({ kind: 'error', text: 'Not saved: the server could not be reached. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  // Whole minutes and seconds, 0:01 to 30:00 -- the route's 1-1800 s.
  const minutes = Number(form.minutes || 0);
  const secondsPart = Number(form.seconds || 0);
  const seconds = minutes * 60 + secondsPart;
  const timeValid = Number.isInteger(minutes) && Number.isInteger(secondsPart) && minutes >= 0
    && secondsPart >= 0 && secondsPart <= 59 && seconds >= 1 && seconds <= 1800;
  const ready = Boolean(athleteId && form.sessionDate && form.sparringType && form.intensity && form.headContact
    && form.presentation && timeValid && (!form.stoppedEarly || form.stopReason.trim()));

  const choice = (id: string, text: string, value: string, pairs: ReadonlyArray<readonly [string, string]>,
    onChange: (value: string) => void) => (
    <div className="field">
      <label htmlFor={id} className="t-label">{text}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="select">
        <option value="">Choose</option>
        {pairs.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
    </div>
  );

  // The Find box keeps the picked athlete offered, so a pick never vanishes from its own list.
  const findQuery = findText.trim().toLowerCase();
  const offered = athletes.filter(
    (a) => !findQuery || a.athlete_id === athleteId || a.full_name.toLowerCase().includes(findQuery),
  );
  const matching = athletes.filter((a) => a.full_name.toLowerCase().includes(findQuery)).length;
  const pickedName = athletes.find((a) => a.athlete_id === athleteId)?.full_name ?? '';
  // Everything above the sections is drawn, so a jump to one is not pushed down afterwards.
  const settled = capsRoster !== 'loading' && limitsRoster !== 'loading' && rosterState !== 'loading';
  // A cap saved below: Athlete Limits shows it read-only, and the Coach-set
  // cap block above shows it for the picked athlete; both read it again.
  const capSaved = (savedFor: string) => {
    setCapSaves((prev) => ({ ...prev, [savedFor]: (prev[savedFor] ?? 0) + 1 }));
    // Re-read with the block left up until the answer lands, so the page
    // does not jump above the panel the coach is using.
    if (savedFor === athleteId && !saving) setReloadTick((tick) => tick + 1);
  };

  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/sparring-exposure"
      allowedRoles={['coach', 'admin']}
      room="clinic"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Sparring</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Sparring and Limits</h1>
          <ClusterNav cluster="clinic" />
          <div className="mt-[var(--s3)]"><BackHome /></div>
          {/* The page is long with no athlete picked: one press to each section. */}
          <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
            <a href="#sparring-caps" className="btn btn--ghost">Sparring Caps</a>
            <a href="#athlete-limits" className="btn btn--ghost">Athlete Limits</a>
          </div>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record what you saw in one sparring segment. The app counts and shows it. It does not score it, set a
            limit, or clear anyone. You decide.
          </p>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          {rosterState === 'loaded' && athletes.length > 0 && (
            <div className="field">
              {/* The Clearance Board's Find box and count, in the same words. */}
              <label className="t-label" htmlFor="sparFind">Find an athlete</label>
              <input id="sparFind" type="search" className="input input--kiosk" value={findText}
                onChange={(event) => setFindText(event.target.value)} autoComplete="off" />
              <p aria-live="polite" className="t-label text-[color:var(--bone-400)]">
                {findQuery
                  ? `${matching} of ${athletes.length} ${athletes.length === 1 ? 'athlete matches' : 'athletes match'}.`
                  : `${athletes.length} ${athletes.length === 1 ? 'athlete' : 'athletes'}.`}
              </p>
            </div>
          )}
          <div className="field">
            <label htmlFor="sparAthlete" className="t-label">Which athlete</label>
            <select
              id="sparAthlete"
              value={athleteId}
              onChange={(event) => {
                // Clear the previous athlete's entries before the new read
                // lands, so one child's record is never shown under another.
                setRecent(null);
                setRecentState(event.target.value ? 'loading' : 'idle');
                setAthleteId(event.target.value);
                setMessage(null);
                setSavedCheck(null);
                // What was observed belongs to the athlete it was observed on;
                // keep only the day and the gear.
                setForm((current) => ({
                  ...EMPTY_FORM, sessionDate: current.sessionDate, headgear: current.headgear, gloveOz: current.gloveOz,
                }));
              }}
              // Locked while a save is in flight, so its result (and the
              // re-read after it) cannot land under a different athlete.
              disabled={saving || rosterState !== 'loaded' || athletes.length === 0}
              className="select input--kiosk"
            >
              <option value="">{rosterState === 'loading' ? 'Loading your athletes...' : 'Choose an athlete'}</option>
              {offered.map((item) => <option key={item.athlete_id} value={item.athlete_id}>{item.full_name}</option>)}
            </select>
          </div>
          {rosterState === 'unavailable' && (
            <p role="alert" className="text-[var(--restricted-ink)]">Your athlete list could not be loaded. Reload to try again.</p>
          )}
          {rosterState === 'loaded' && athletes.length === 0 && <p>No athletes are available to you.</p>}
        </section>

        {athleteId && (
          <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-lg)]">Sparring Record</h2>
            <p className="t-label mt-[var(--s1)]">{pickedName}</p>
          </div>
        )}

        {athleteId && recentState === 'loaded' && recent && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s2)]" data-testid="spar-cap">
            <h2 className="t-eyebrow">Coach-set cap</h2>
            {!isCapCheck(recent.cap_check) || recent.cap_check.cap_state === 'unknown' ? (
              <p>This athlete&apos;s cap could not be read just now. Unknown is not &ldquo;no cap&rdquo;.</p>
            ) : recent.cap_check.cap_state === 'none' || !recent.cap_check.cap ? (
              <p>No cap set for this athlete.</p>
            ) : (
              <>
                {recent.cap_check.cap.highest_allowed_stage !== null && (
                  <p>Highest stage: {humanizeContactLevel(recent.cap_check.cap.highest_allowed_stage)}</p>
                )}
                {recent.cap_check.cap.max_hard_open_sessions_per_7_days !== null && (
                  <p>
                    At most {recent.cap_check.cap.max_hard_open_sessions_per_7_days} hard or open sparring sessions in
                    any 7 days (sessions = gym days).
                  </p>
                )}
              </>
            )}
            {isCapCheck(recent.cap_check) && (
              <p data-testid="spar-hard-open-days">
                {recent.cap_check.hard_open_days_in_7 === null
                  ? 'Gym days with hard or open sparring in the last 7 could not be counted just now.'
                  : `Gym days with hard or open sparring in the 7 ending ${
                    formatGymDay(recent.cap_check.through_day) ?? recent.cap_check.through_day}: ${
                    recent.cap_check.hard_open_days_in_7}.`}
              </p>
            )}
            <p className="text-[color:var(--bone-300)]">
              A cap never blocks a segment; you decide. <a href="#sparring-caps" className="underline">Sparring Caps</a>
            </p>
          </section>
        )}

        {athleteId && (
          <form onSubmit={submit} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
            {/* Disabled while saving: the reset after a save would otherwise
                discard anything typed for the next segment in the meantime. */}
            <fieldset disabled={saving} className="space-y-[var(--s4)] border-0 p-0 m-0">
            <h2 className="t-eyebrow">One segment</h2>
            <div className="field">
              <label htmlFor="sparDay" className="t-label">Day</label>
              <input id="sparDay" type="date" value={form.sessionDate} max={gymDayIso() ?? undefined} required
                onChange={(event) => set({ sessionDate: event.target.value })} className="input" />
            </div>
            {choice('sparType', 'Type of sparring', form.sparringType, SPARRING_TYPES, (v) => set({ sparringType: v }))}
            <div className="field">
              <label htmlFor="sparStage" className="t-label">Contact stage (optional)</label>
              <select id="sparStage" value={form.contactStage} onChange={(event) => set({ contactStage: event.target.value })}
                className="select">
                <option value="">Not recorded</option>
                {STAGE_PAIRS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </div>
            <fieldset className="field">
              <legend className="t-label">Time in live exchanges (head contact possible) — not round length</legend>
              <div className="flex gap-[var(--s3)]">
                <input aria-label="Minutes" type="number" min={0} max={30} inputMode="numeric" value={form.minutes}
                  onChange={(event) => set({ minutes: event.target.value })} className="input" placeholder="min" />
                <input aria-label="Seconds" type="number" min={0} max={59} inputMode="numeric" value={form.seconds}
                  onChange={(event) => set({ seconds: event.target.value })} className="input" placeholder="sec" />
              </div>
              {(form.minutes || form.seconds) && !timeValid && (
                <p className="text-[var(--restricted-ink)]">Whole minutes and seconds, from 0:01 up to 30:00.</p>
              )}
            </fieldset>
            <div className="field">
              <label htmlFor="sparRounds" className="t-label">Rounds (optional)</label>
              <input id="sparRounds" type="number" min={0.25} max={99} step={0.25} inputMode="decimal" value={form.rounds}
                onChange={(event) => set({ rounds: event.target.value })} className="input" />
            </div>
            {choice('sparIntensity', 'Intensity you saw', form.intensity, INTENSITIES, (v) => set({ intensity: v }))}
            {choice('sparHead', 'Head contact you saw', form.headContact, HEAD_CONTACT, (v) => set({ headContact: v }))}
            {choice('sparAfter', 'After sparring, the athlete looked', form.presentation, PRESENTATIONS,
              (v) => set({ presentation: v }))}
            {choice('sparHeadgear', 'Headgear (optional)', form.headgear, [['yes', 'Yes'], ['no', 'No']],
              (v) => set({ headgear: v }))}
            <div className="field">
              <label htmlFor="sparGloves" className="t-label">Glove oz (optional)</label>
              <input id="sparGloves" type="number" min={8} max={20} inputMode="numeric" value={form.gloveOz}
                onChange={(event) => set({ gloveOz: event.target.value })} className="input" />
            </div>
            <label className="flex items-center gap-[var(--s3)]">
              <input type="checkbox" checked={form.stoppedEarly}
                onChange={(event) => set({ stoppedEarly: event.target.checked, stopRuleId: '', stopReason: '' })} />
              <span className="t-label">Stopped early</span>
            </label>
            {form.stoppedEarly && (
              <>
                {recent && recent.stop_rules.length > 0 && choice('sparStopRule', 'Stop rule (optional)', form.stopRuleId,
                  recent.stop_rules.map((rule) => [rule.universal_rule_id, rule.condition_text] as const),
                  (v) => set({ stopRuleId: v }))}
                {recentState === 'unavailable' && (
                  <p>The gym&apos;s stop rules could not be loaded. Describe what ended it below.</p>
                )}
                <div className="field">
                  <label htmlFor="sparStopReason" className="t-label">What ended it</label>
                  <textarea id="sparStopReason" value={form.stopReason} maxLength={500}
                    onChange={(event) => set({ stopReason: event.target.value })} className="input" />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="sparNote" className="t-label">Note (optional)</label>
              <textarea id="sparNote" value={form.note} maxLength={2000}
                onChange={(event) => set({ note: event.target.value })} className="input" />
            </div>
            <button type="submit" disabled={!ready || saving} className="btn disabled:cursor-not-allowed disabled:opacity-60">
              {saving ? 'Saving…' : 'Save segment'}
            </button>
            {/* Gym-floor size (OD-2026-11-17-009 ruling 4): the save message and
                the restriction note are bare text or unlayered .alert-* sizes
                the kiosk type floor does not reach, so they are sized inline.
                A refusal by the medical restriction gate carries the
                Restricted mark, never the medical-stop mark (ruling 5). */}
            {message && (message.restricted ? (
              <div role="alert" data-testid="spar-medical-refusal" className="flex flex-col items-start gap-[var(--s2)]">
                <RestrictedMark />
                <p className="text-[var(--restricted-ink)]" style={KIOSK_TEXT}>{message.text}</p>
              </div>
            ) : (
              <p role={message.kind === 'error' ? 'alert' : 'status'}
                className={message.kind === 'error' ? 'text-[var(--restricted-ink)]' : undefined}
                style={KIOSK_TEXT}>
                {message.text}
              </p>
            ))}
            {/* P22b (Q8): a segment below sparring for a restricted member
                saved; say why sparring is held back. A refused one arrives as
                the error message above, with the same words. */}
            {message?.kind === 'ok' && restrictionNote && (
              <div className="alert alert--warning" role="status" data-testid="spar-medical-restriction">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title" style={KIOSK_TITLE}>Restricted: medical restriction on file</p>
                  <p className="alert-msg" style={KIOSK_TEXT}>{restrictionNote}</p>
                </div>
              </div>
            )}
            {message?.kind === 'ok' && savedCheck === 'unreadable' && (
              <p>The cap check did not come back, so this segment was not checked against a cap.</p>
            )}
            {/* Titled by what the warnings ARE: "over" only for an actual
                overage; a stage not recorded, a cap that could not be read or a
                count that failed is "not checked", never "over". */}
            {message?.kind === 'ok' && savedCheck !== null && savedCheck !== 'unreadable'
              && (savedCheck.warnings ?? []).some((w) => OVER_KINDS.has(w.kind)) && (
              <div className="alert alert--warning" role="alert" data-testid="spar-cap-warnings">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title" style={KIOSK_TITLE}>Over the coach-set cap</p>
                  {(savedCheck.warnings ?? []).filter((w) => OVER_KINDS.has(w.kind)).map((warning) => (
                    <p key={warning.kind} className="alert-msg" style={KIOSK_TEXT}>{warning.message}</p>
                  ))}
                </div>
              </div>
            )}
            {message?.kind === 'ok' && savedCheck !== null && savedCheck !== 'unreadable'
              && (savedCheck.warnings ?? []).some((w) => !OVER_KINDS.has(w.kind)) && (
              <div className="alert alert--warning" data-testid="spar-cap-unchecked">
                <span className="alert-icon" aria-hidden="true">▲</span>
                <div className="alert-body">
                  <p className="alert-title" style={KIOSK_TITLE}>Not fully checked against the cap</p>
                  {(savedCheck.warnings ?? []).filter((w) => !OVER_KINDS.has(w.kind)).map((warning) => (
                    <p key={warning.kind} className="alert-msg" style={KIOSK_TEXT}>{warning.message}</p>
                  ))}
                </div>
              </div>
            )}
            </fieldset>
          </form>
        )}

        {athleteId && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
            <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
              <h2 className="t-eyebrow">Recent sparring</h2>
              <select aria-label="Window" value={windowDays} disabled={saving}
                onChange={(event) => { setRecentState('loading'); setWindowDays(Number(event.target.value)); }}
                className="select">
                {WINDOWS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
              </select>
            </div>
            {recentState === 'loading' && <p>Loading...</p>}
            {recentState === 'unavailable' && (
              <p role="alert" className="text-[var(--restricted-ink)]">
                Recent sparring could not be loaded. This does not mean there was none.
              </p>
            )}
            {recentState === 'loaded' && recent && (
              <>
                <p data-testid="spar-counts">
                  {recent.counts.total_segments} segments, {minSec(recent.counts.total_time_under_impact_sec)} in live
                  exchanges.{' '}
                  {SPARRING_TYPES.filter(([key]) => recent.counts.segments_by_type[key])
                    .map(([key, name]) => `${name}: ${recent.counts.segments_by_type[key]}`).join(', ')}
                </p>
                {recent.entries.length === 0 && <p>No sparring recorded in this window.</p>}
                {recent.entries_truncated && <p>Showing the latest {recent.entries.length} entries.</p>}
                <ul className="space-y-[var(--s3)]">
                  {recent.entries.map((entry) => (
                    <li key={entry.exposure_id} className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s3)]">
                      <p className="font-semibold">
                        {formatGymDay(entry.sparring_day) ?? entry.sparring_day} · segment {entry.segment_number} ·{' '}
                        {label(SPARRING_TYPES, entry.sparring_type)}
                        {entry.contact_stage ? ` · ${humanizeContactLevel(entry.contact_stage)}` : ''}
                        {' · '}{minSec(entry.time_under_impact_sec)}
                        {entry.round_equivalent ? ` · ${Number(entry.round_equivalent)} rounds` : ''}
                      </p>
                      <p>
                        Intensity {label(INTENSITIES, entry.coach_observed_intensity)} · head contact{' '}
                        {label(HEAD_CONTACT, entry.coach_observed_head_contact)} · after:{' '}
                        {label(PRESENTATIONS, entry.athlete_presentation)}
                        {entry.headgear_worn !== null ? ` · headgear ${entry.headgear_worn ? 'yes' : 'no'}` : ''}
                        {entry.glove_oz ? ` · ${entry.glove_oz} oz` : ''}
                      </p>
                      {entry.stopped_early && <p>Stopped early: {entry.stop_reason}</p>}
                      {entry.coach_note && <p className="text-[color:var(--bone-300)]">{entry.coach_note}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {/* The two pages this one absorbed, in their own words (#2010 Q6 = A). A
            pick opens that athlete's panel at once (#2131 QR3 = A); a re-pick
            remounts it, so one athlete's limits never show under another. */}
        <LimitsSection id="sparring-caps" title="Sparring Caps" roster={capsRoster} settled={settled} pickedId={athleteId} findQuery={findQuery}
          intro="The limits you set for each athlete's sparring: the highest contact stage, and the most hard or open sparring sessions in any 7 days. The app never picks a limit, and a cap never blocks sparring — the coach decides."
          empty="No athletes you can set caps for."
          notPicked={`${pickedName} is not one of the athletes you can set caps for.`} takeArrival={takeArrival}
          panel={(athlete, name) => (
            <ContactCapPanel key={`${athlete.athlete_id}:${athleteId}`} athleteId={athlete.athlete_id} athleteName={name}
              openAtStart={athleteId === athlete.athlete_id} onSaved={() => capSaved(athlete.athlete_id)} />
          )} />
        <LimitsSection id="athlete-limits" title="Athlete Limits" roster={limitsRoster} settled={settled} pickedId={athleteId} findQuery={findQuery}
          intro="The limits you set for each athlete: heat exposure in minutes per session, the most weight cut as a percent of body weight, and the supervision you require. The app never picks a limit, and nothing here blocks training — the coach decides."
          empty="No athletes you can set limits for."
          notPicked={`${pickedName} is not one of the athletes you can set limits for.`} takeArrival={takeArrival}
          panel={(athlete, name) => (
            <MinorLimitsPanel key={`${athlete.athlete_id}:${athleteId}`} athleteId={athlete.athlete_id} athleteName={name}
              openAtStart={athleteId === athlete.athlete_id} capVersion={capSaves[athlete.athlete_id] ?? 0} />
          )} />
      </div>
    </RoleStandaloneView>
  );
}
