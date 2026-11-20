'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import WorkAxis from '@/components/WorkAxis';
import { apiBase } from '@/lib/apiBase';
import { orNotWritten } from '@/src/lib/drillPresentation';
import MakeSessionScript from './MakeSessionScript';
import TemplateEditForm, { type TemplateEditOutcome } from './TemplateEditForm';
import type {
  WorkoutTemplateItemWithDrillHead,
  WorkoutTemplateRow,
} from '@/src/server/pilot/workoutTemplates';
import ClusterNav from '@/components/ClusterNav';

// Browse over pilot.workout_templates, the first UI consumer of
// GET /api/pilot/workout-templates. The TEMPLATES are read-only by design --
// they are seeded reference data, not something a coach authors from the
// floor -- so this page offers no create, no edit, and no delete, and that
// absence is deliberate rather than unfinished.
//
// Two writes start from an open template, and neither writes a template.
// ISSUING it to an athlete (lane P7, #1401; POST
// /api/pilot/workout-templates/issue) writes assignments, and only after the
// coach confirms. See IssueToAthlete below. MAKING A SESSION SCRIPT from it
// (lane L1; POST /api/pilot/session-scripts) writes a script, which is then
// edited and delivered under Session Scripts. See MakeSessionScript.tsx.
//
// Layout, gating and honesty rules mirror /coach/session-scripts: a failed
// read is distinguished from an empty catalog, and durations render as
// minutes (a template is the same template at 4:00 and at 6:30).

// Type-only imports from the server module, so nothing server-side is pulled
// into this client bundle and the shapes cannot drift from the route's own.
type Template = WorkoutTemplateRow;
type TemplateItem = WorkoutTemplateItemWithDrillHead;

interface TemplateDetail {
  template: Template;
  items: TemplateItem[];
  /** Names of the drills no coach of this gym has floor-tested (the detail read's untested_drills). */
  untestedDrills: string[];
  /**
   * The steps an issue would refuse, from the issue's own plan (the detail
   * read's refused_drills; lane U1, U1-ISSUE). undefined: not sent to this
   * reader. null: the check could not run.
   */
  refusedDrills?: RefusedDrill[] | null;
}

// ---------------------------------------------------------------------------
// ISSUE TO ATHLETE.
//
// One action: pick an athlete this coach can reach, confirm, and every step
// of the open template becomes an assignment (the server does it in one
// transaction, or not at all). What comes back is shown as it is:
//   - issued: how many Coach Cards, and any drill the gym adopted on the way;
//   - refused: the server's sentence and every drill it named, with the reason;
//   - a training hold: said beside the result. The issue was NOT blocked
//     (OD-2026-10-06-024 ruling 1, warn only), and no other warning is added.
//
// THE SCREEN NEVER SAYS "NOTHING WAS ISSUED" UNLESS THE SERVER SAID SO. The
// route answers 201 only after its transaction has committed, and nothing
// stops the same template being issued twice, so a coach told "nothing was
// issued" issues again and the athlete gets every card twice. Four answers,
// kept apart:
//   - 201: issued, always -- even when the body cannot be read;
//   - 200 saying `already_issued`: this press repeated one that had gone
//     through (see the request key below); issued once, and said so;
//   - 400 / 401 / 403 / 404 / 409: the server refused before or inside the
//     write, so nothing was issued, and the screen says so;
//   - anything else (no answer, a 5xx, a status this screen does not know):
//     UNKNOWN, said as unknown, with where to look before trying again.
//
// THE ATHLETE GETS THE WORKOUT'S SHAPE (#1419): each step is still its own
// assignment, and the issue keeps each step's block, order, scale level,
// contact level and note, which the athlete's screen draws as one workout. The
// result says so. It says nothing about the Coach Cards screen: that screen
// lists a coach's own issues the same way, but an admin can issue here too,
// and an admin's issue is on nobody's Coach Cards screen.
//
// ONE PRESS, ONE ISSUE. Each issue is sent with a request key: a random id
// kept for that template and athlete until the server says what became of
// THAT request (issued, already issued, or the key refused as used for another
// workout). When a press gets no answer and the coach presses again, the same
// key goes out, and the server answers with the first issue instead of issuing
// twice. Every other answer keeps the key, a refusal included: a 400, 401,
// 403, 404 or any other 409 refuses THIS press and says nothing about an
// earlier one that may have landed. Keeping a key that names nothing costs
// nothing; the next press simply issues under it. One consequence, kept on
// purpose: after a press with no answer, the next press for that athlete is
// treated as the retry even if the coach meant a second issue, and says so;
// the press after that is a new issue.
//
// THE KEYS LIVE IN THE PAGE, NOT IN THE ISSUE CONTROL. The control is taken
// down whenever another template is opened, and a coach whose press got no
// answer may well open another template and come back. So the page holds the
// keys, by template AND athlete, and hands them to whichever control is up:
// coming back sends the same key. They last as long as the page does. A full
// reload still starts again, so the "check before trying again" sentences
// below stay as they are.
//
// data-surface="kiosk" (Law 5): a coach does this on a tablet between rounds,
// so the controls sit on the 55px tap floor and the 19.1px type floor. The
// picker also wears input--kiosk, because the unlayered `.select` min-height
// outranks the layered kiosk rule.
// ---------------------------------------------------------------------------

interface ReachableAthlete {
  athlete_id: string;
  full_name: string;
}

function isReachableAthlete(value: unknown): value is ReachableAthlete {
  if (value === null || typeof value !== 'object') return false;
  const athlete = value as Record<string, unknown>;
  return typeof athlete.athlete_id === 'string' && typeof athlete.full_name === 'string';
}

// The scope labels the progression screen prints for the same warning.
const HOLD_SCOPE_LABEL: Record<string, string> = {
  all_training: 'ALL TRAINING',
  contact_only: 'CONTACT WORK',
  conditioning_only: 'CONDITIONING',
};

type HoldNote = { scopeLabel: string } | 'unreadable' | null;

/** The `hold_warning` an issue answer carries, checked before it is drawn. */
function holdNoteFrom(value: unknown): HoldNote {
  // Absent is "not held". Anything PRESENT this screen cannot read as a hold
  // is not drawn as one, and is not "not held" either: it is unknown.
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return 'unreadable';
  const scope = (value as Record<string, unknown>).scope;
  if (typeof scope !== 'string' || !Object.prototype.hasOwnProperty.call(HOLD_SCOPE_LABEL, scope)) return 'unreadable';
  return { scopeLabel: HOLD_SCOPE_LABEL[scope] };
}

/** One refused drill as this screen draws it, whatever shape the answer had. */
interface RefusedDrill {
  name: string;
  steps: number[];
  reason: string;
}

// Checked rather than cast: a refusal is the answer the coach most needs to
// read, and one malformed entry must not take the whole page down with it.
function refusedDrillsFrom(value: unknown): RefusedDrill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const drill = entry as Record<string, unknown>;
    return [{
      name: typeof drill.name === 'string' && drill.name.trim() !== '' ? drill.name : 'A step with no name',
      steps: Array.isArray(drill.steps) ? drill.steps.filter((step): step is number => typeof step === 'number') : [],
      reason: typeof drill.reason === 'string' ? drill.reason : '',
    }];
  });
}

/** The refused drills, drawn the same before Issue and after Confirm. */
function RefusedDrillList({ drills }: { readonly drills: readonly RefusedDrill[] }) {
  return (
    <ul className="flex flex-col gap-[var(--s2)]">
      {drills.map((drill, index) => (
        // Index key: the list is drawn once per answer and never reordered.
        <li key={index} className="t-body">
          <span className="font-semibold">{drill.name}</span>
          {drill.steps.length > 0 && ` (${drill.steps.length === 1 ? 'step' : 'steps'} ${drill.steps.join(', ')})`}
          {drill.reason !== '' && `: ${drill.reason}`}
        </li>
      ))}
    </ul>
  );
}

function namedDrills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((drill) => {
    const name = (drill as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() !== '' ? [name] : [];
  });
}

/**
 * The plain statement of which drills no coach of this gym has floor-tested
 * (Jason, 2026-10-11: "B", issue #1473). Body text, not a warning: it stops
 * nothing and asks for nothing. Wording PROPOSED for Jason's look.
 */
function untestedSentence(names: readonly string[]): string {
  return names.length === 1
    ? `This drill has not been floor-tested by a coach of this gym: ${names[0]}.`
    : `These drills have not been floor-tested by a coach of this gym: ${names.join(', ')}.`;
}

/** How many cards the answer says it made, or null when it does not say. */
function cardCountFrom(payload: Record<string, unknown>): number | null {
  if (Array.isArray(payload.steps)) return payload.steps.length;
  const created = payload.created;
  const assignments = created !== null && typeof created === 'object' ? (created as Record<string, unknown>).assignments : undefined;
  return typeof assignments === 'number' ? assignments : null;
}

/**
 * The request keys of the issues that have no settled answer yet, held by the
 * page (see ONE PRESS, ONE ISSUE above). Null marks an issue whose key could
 * not be made.
 */
type RequestKeys = Map<string, string | null>;

/** One template issued to one athlete: what a request key belongs to. */
function requestKeyFor(templateId: string, athleteId: string): string {
  return JSON.stringify([templateId, athleteId]);
}

/** A new request key, or null where the browser cannot make a random id (then none is sent). */
function newRequestKey(): string | null {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : null;
}

type IssueOutcome =
  | { kind: 'issued'; athleteName: string; cards: number | null; adopted: string[]; updated?: string[]; untested?: string[]; hold: HoldNote; already?: boolean }
  // A 201 whose body could not be read: the cards exist, the details do not.
  | { kind: 'issued_unread'; athleteName: string }
  | { kind: 'refused'; message: string; drills: RefusedDrill[] }
  | { kind: 'failed'; message: string };

const NOTHING_ISSUED = 'Nothing was issued.';
const ISSUE_FAILED = `The template could not be issued. ${NOTHING_ISSUED}`;
const ISSUE_NOT_FOUND =
  `That athlete or template could not be found, or you can no longer reach that athlete. ${NOTHING_ISSUED}`;
const ISSUE_SIGNED_OUT = `You are signed out, so nothing was issued. Sign in again.`;
const ISSUE_NOT_ALLOWED = `This account may not issue templates. ${NOTHING_ISSUED}`;
// No answer came back, so this screen does not know which way it went.
const ISSUE_NO_ANSWER =
  'No answer came back, so this template may or may not have been issued. '
  + "Check the athlete's Coach Cards before trying again.";
// An answer came back that does not say which way it went.
const ISSUE_UNKNOWN =
  'This screen could not tell whether the template was issued. '
  + "Check the athlete's Coach Cards before trying again.";
const ATHLETES_FAILED = 'The athletes could not be loaded. This is a failure to load, not an empty list of athletes.';

/** The server's own sentence for a refusal it made before or inside the write. */
function refusedBeforeWriting(payload: Record<string, unknown> | null): string {
  const said = typeof payload?.error === 'string' ? payload.error.trim() : '';
  if (said === '') return ISSUE_FAILED;
  if (/nothing was issued/i.test(said)) return said;
  return `${/[.!?]$/.test(said) ? said : `${said}.`} ${NOTHING_ISSUED}`;
}

// An ordinary refusal or failure, boxed so it never reads as the success beside
// it. Brass and bone, NOT the medical-stop colour: --locked means a medical
// stop and nothing else (AGENT_KERNEL.md, OD-2026-09-29-001). The words carry
// the meaning.
const ALERT_TEXT = 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

function IssueToAthlete({
  template,
  untestedDrills,
  refusedDrills,
  onRecheck,
  recheckBlocked,
  onBusyChange,
  requestKeys,
}: {
  readonly template: Template;
  /** Named in the confirm step before issuing; the result names the server's own list after. */
  readonly untestedDrills: readonly string[];
  /** Steps the issue would refuse, read with the template; see TemplateDetail. */
  readonly refusedDrills?: readonly RefusedDrill[] | null;
  /** Reads the template again, so a step fixed elsewhere is seen (the open button is off while it is open). */
  readonly onRecheck: () => void;
  /** True while a session plan is being made below: a re-read would unmount it and lose the answer. */
  readonly recheckBlocked: boolean;
  /** Told while an issue is running, so the page can keep this control mounted until it answers. */
  readonly onBusyChange: (busy: boolean) => void;
  /** The page's keys of unsettled issues: they outlive this control. */
  readonly requestKeys: { readonly current: RequestKeys };
}) {
  // null until the read answers, so "still loading" is never drawn as "nobody".
  const [athletes, setAthletes] = useState<ReachableAthlete[] | null>(null);
  const [athletesFailed, setAthletesFailed] = useState(false);
  const [athleteId, setAthleteId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<IssueOutcome | null>(null);

  // Where focus goes after each step. Each step replaces what was on screen,
  // so without this a keyboard or screen-reader user is dropped at the top of
  // the page with nothing read out.
  const [focusOn, setFocusOn] = useState<'confirm' | 'result' | 'issue' | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const issueButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusOn === 'confirm') confirmRef.current?.focus();
    if (focusOn === 'result') resultRef.current?.focus();
    if (focusOn === 'issue') issueButtonRef.current?.focus();
  }, [focusOn]);

  // No state is set before the first await (see `load` in the page below).
  const loadAthletes = useCallback(async () => {
    try {
      // The athletes this coach may act ON, not everyone in the gym: the
      // picker never offers an athlete the issue would then refuse.
      const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('athletes read failed');
      const payload = (await response.json()) as { items?: unknown } | null;
      // A wrong-shaped answer is a failed read, not a gym with no athletes --
      // and so is a list with an entry this screen cannot read: dropping it
      // would quietly take an athlete out of the picker.
      if (!Array.isArray(payload?.items)) throw new Error('athletes read had no list');
      const readable = payload.items.filter(isReachableAthlete);
      if (readable.length !== payload.items.length) throw new Error('athletes read had an unreadable entry');
      setAthletes(readable.sort((a, b) => a.full_name.localeCompare(b.full_name)));
      setAthletesFailed(false);
    } catch {
      setAthletes([]);
      setAthletesFailed(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadAthletes();
    })();
  }, [loadAthletes]);

  const chosen = (athletes ?? []).find((athlete) => athlete.athlete_id === athleteId) ?? null;

  const issue = async () => {
    // No second send while one runs: every control below is disabled on
    // `busy`, and React re-renders between two taps, so the button is already
    // dead when a second tap arrives.
    if (!chosen) return;
    // The earlier result goes only now, when a new issue is actually sent. A
    // stray tap on Issue followed by Cancel must not erase "Issued to ...".
    setOutcome(null);
    setBusy(true);
    onBusyChange(true);
    // The key of this template's issue to this athlete, or a new one. It is
    // kept through every answer that does not say what became of this request.
    const keys = requestKeys.current;
    const issueOf = requestKeyFor(template.template_id, chosen.athlete_id);
    if (!keys.has(issueOf)) keys.set(issueOf, newRequestKey());
    const requestKey = keys.get(issueOf) ?? null;
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/workout-templates/issue`, {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            template_id: template.template_id,
            athlete_id: chosen.athlete_id,
            ...(requestKey ? { request_key: requestKey } : {}),
          }),
        });
      } catch {
        setOutcome({ kind: 'failed', message: ISSUE_NO_ANSWER });
        return;
      }
      const parsed: unknown = await response.json().catch(() => null);
      const payload = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;

      // Only an answer about THIS request ends it, so that the next press for
      // this athlete is a new issue with a new key: it was issued, it had
      // already been issued, or its key was refused as another workout's.
      const settled = response.status === 201
        || (response.status === 200 && payload?.already_issued === true)
        || (response.status === 409 && payload?.code === 'WORKOUT_ISSUE_REQUEST_KEY_REUSED');
      if (settled) keys.delete(issueOf);

      if (response.status === 200 && payload?.already_issued === true) {
        // An earlier press of this same issue went through; this one wrote
        // nothing. Issued once.
        setOutcome({
          kind: 'issued',
          athleteName: chosen.full_name,
          cards: typeof payload.step_count === 'number' ? payload.step_count : null,
          adopted: [],
          hold: holdNoteFrom(payload.hold_warning),
          already: true,
        });
      } else if (response.status === 201) {
        // Committed, whatever else is true. An unreadable body loses the
        // details, never the fact.
        setOutcome(payload
          ? {
            kind: 'issued',
            athleteName: chosen.full_name,
            cards: cardCountFrom(payload),
            adopted: namedDrills(payload.adopted_drills),
            updated: namedDrills(payload.updated_drills),
            untested: namedDrills(payload.untested_drills),
            hold: holdNoteFrom(payload.hold_warning),
          }
          : { kind: 'issued_unread', athleteName: chosen.full_name });
      } else if (response.status === 409 && payload?.code === 'WORKOUT_TEMPLATE_ISSUE_REFUSED') {
        setOutcome({
          kind: 'refused',
          message: typeof payload.error === 'string' ? payload.error : NOTHING_ISSUED,
          drills: refusedDrillsFrom(payload.drills),
        });
      } else if (response.status === 404) {
        setOutcome({ kind: 'failed', message: ISSUE_NOT_FOUND });
      } else if (response.status === 401) {
        setOutcome({ kind: 'failed', message: ISSUE_SIGNED_OUT });
      } else if (response.status === 403) {
        setOutcome({ kind: 'failed', message: ISSUE_NOT_ALLOWED });
      } else if (response.status === 400 || response.status === 409) {
        // The server's own sentence: a template no longer in use, a drill
        // retired in the meantime, a library that changed mid-issue.
        setOutcome({ kind: 'failed', message: refusedBeforeWriting(payload) });
      } else {
        // A 5xx or a status this screen does not know. A server error's text
        // is not repeated, and it is not read as "nothing happened".
        setOutcome({ kind: 'failed', message: ISSUE_UNKNOWN });
      }
    } catch {
      // Anything thrown after the request left: the write may have landed.
      setOutcome({ kind: 'failed', message: ISSUE_UNKNOWN });
    } finally {
      setBusy(false);
      onBusyChange(false);
      setConfirming(false);
      setFocusOn('result');
    }
  };

  const cardsLine = outcome?.kind === 'issued'
    ? (outcome.cards === null
      ? `Issued to ${outcome.athleteName}. The number of Coach Cards could not be read.`
      : `Issued to ${outcome.athleteName}: ${outcome.cards} Coach ${outcome.cards === 1 ? 'Card' : 'Cards'}.`)
    : '';
  // Said only when this press repeated one that had already gone through. It
  // speaks of this press, not of a total: the coach may have issued this
  // template to this athlete before, on purpose.
  const alreadyLine = 'Your earlier try had gone through. This press did not issue it again.';

  return (
    <div
      data-surface="kiosk"
      className="mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      <h3 className="t-command text-[length:var(--t-md)]">Issue to athlete</h3>

      {athletes === null && <p className="t-body mt-[var(--s3)]">Loading athletes...</p>}

      {athletes !== null && athletesFailed && (
        <div role="alert" className="mt-[var(--s3)] flex flex-col gap-[var(--s3)]">
          <p className={ALERT_TEXT}>{ATHLETES_FAILED}</p>
          <button
            type="button"
            className="btn btn--ghost btn--kiosk"
            onClick={() => {
              setAthletes(null);
              void loadAthletes();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {athletes !== null && !athletesFailed && athletes.length === 0 && (
        <p className="t-body mt-[var(--s3)]">You have no athletes you can issue this to.</p>
      )}

      {athletes !== null && athletes.length > 0 && (
        <div className="mt-[var(--s3)] flex flex-col gap-[var(--s3)]">
          <label className="t-label" htmlFor="issue-athlete">Athlete</label>
          <select
            id="issue-athlete"
            className="select input--kiosk"
            value={athleteId}
            disabled={busy}
            onChange={(event) => {
              // A new choice is a new question: the confirm step and any
              // earlier result belong to the athlete picked before.
              setAthleteId(event.target.value);
              setConfirming(false);
              setOutcome(null);
              // So the next Issue tap moves focus again even if the last
              // thing focused was also the confirm sentence.
              setFocusOn(null);
            }}
          >
            <option value="">Choose an athlete</option>
            {athletes.map((athlete) => (
              <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
            ))}
          </select>

          {/* BEFORE ISSUE, what the issue would refuse (lane U1, U1-ISSUE;
              Overwatch Q-ISSUE A). Every refusal stops the whole issue, so
              while any step would be refused the button is off and says why;
              the reasons are the issue's own. Drill-level only: a refusal
              that depends on the athlete chosen still comes after Confirm. */}
          {refusedDrills && refusedDrills.length > 0 && (
            <div className="flex flex-col gap-[var(--s2)]">
              <p className={ALERT_TEXT}>These steps would be refused if you issue now:</p>
              <RefusedDrillList drills={refusedDrills} />
              <p className="t-body">Fix the steps above first; nothing would be issued.</p>
              {/* A drill fixed in another tab is not seen until the template is
                  read again, and this template's own open button is off while
                  it is open (review A). */}
              <button type="button" className="btn btn--ghost w-fit" disabled={recheckBlocked || busy} onClick={onRecheck}>
                Check again
              </button>
            </div>
          )}
          {refusedDrills === null && (
            <p className="t-body">
              Whether every step can be issued could not be checked. Issuing will check again.
            </p>
          )}

          {/* Stays in its place, disabled, while the confirm step is open: a
              second tap on the same spot then lands on a dead button, never
              on Confirm. */}
          <button
            ref={issueButtonRef}
            type="button"
            className="btn btn--kiosk"
            disabled={!chosen || busy || confirming || (refusedDrills?.length ?? 0) > 0}
            onClick={() => {
              setConfirming(true);
              setFocusOn('confirm');
            }}
          >
            Issue to athlete
          </button>

          {confirming && chosen && (
            <div className="flex flex-col gap-[var(--s3)]">
              <p ref={confirmRef} tabIndex={-1} className="t-body font-semibold">
                Issue {template.name} to {chosen.full_name} as one workout?
              </p>
              {untestedDrills.length > 0 && <p className="t-body">{untestedSentence(untestedDrills)}</p>}
              <button
                type="button"
                className="btn btn--kiosk"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void issue()}
              >
                {busy ? 'Issuing...' : 'Confirm issue'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--kiosk"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setFocusOn('issue');
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* The result. Focus is sent here when an answer lands. The status
          region is always mounted, so what is put into it is announced. */}
      <div ref={resultRef} tabIndex={-1} className="mt-[var(--s4)]">
        <div role="status" className="flex flex-col gap-[var(--s2)]">
          {outcome?.kind === 'issued' && (
            <>
              <p className="t-body font-semibold">{cardsLine}</p>
              {outcome.already && <p className="t-body">{alreadyLine}</p>}
              <p className="t-body">
                The athlete sees this as one workout: each step in your order, with its block, scale level,
                contact level and note.
              </p>
              {outcome.adopted.length > 0 && (
                <p className="t-body">Adopted for this gym: {outcome.adopted.join(', ')}.</p>
              )}
              {/* A drill the gym already ran, moved to the newer version a step
                  names (OD-2026-10-08-008 D1). Wording PROPOSED for Jason's look. */}
              {outcome.updated && outcome.updated.length > 0 && (
                <p className="t-body">Moved to the newer version: {outcome.updated.join(', ')}.</p>
              )}
              {outcome.untested && outcome.untested.length > 0 && (
                <p className="t-body">{untestedSentence(outcome.untested)}</p>
              )}
              {/* OD-2026-10-06-024 ruling 1: told beside the action, after the
                  fact, and nothing was blocked. The progression screen's wording. */}
              {outcome.hold !== null && outcome.hold !== 'unreadable' && (
                <p className="t-body font-semibold">
                  This athlete has an active training hold ({outcome.hold.scopeLabel}). Issuing was NOT blocked;
                  confirm the hold&apos;s scope covers these drills.
                </p>
              )}
              {outcome.hold === 'unreadable' && (
                <p className="t-body font-semibold">
                  Whether this athlete is under a training hold could not be read; check the training holds record.
                </p>
              )}
            </>
          )}
          {outcome?.kind === 'issued_unread' && (
            <p className="t-body font-semibold">
              Issued to {outcome.athleteName}, but the details could not be read here. Check the athlete&apos;s
              Coach Cards rather than issuing it again.
            </p>
          )}
        </div>

        {outcome?.kind === 'refused' && (
          <div role="alert" className="flex flex-col gap-[var(--s2)]">
            <p className={ALERT_TEXT}>{outcome.message}</p>
            <RefusedDrillList drills={outcome.drills} />
          </div>
        )}

        {outcome?.kind === 'failed' && (
          <p role="alert" className={ALERT_TEXT}>{outcome.message}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Minutes the source sheet gives a contact item, kept in the item's details because the duration
 * column holds none above light technical (OD-2026-11-17-002). Information only: nothing times,
 * issues or presets them.
 */
function sheetMinutes(item: TemplateItem): number | null {
  const minutes = item.details?.duration_minutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null;
}

/**
 * The item's name: its drill's name when it links one; else its typed text; else the title its
 * source sheet gives it (details.block_title, then details.phase, lane YR). A drill named WITH
 * text shows the text under the name (itemText), so neither hides the other.
 */
function itemName(item: TemplateItem): string {
  const sheet = item.details ?? {};
  const title = typeof sheet.block_title === 'string' ? sheet.block_title : typeof sheet.phase === 'string' ? sheet.phase : null;
  if (item.drill_id !== null) return item.head_drill_name ?? item.drill_id;
  return item.free_text_drill ?? title ?? 'Unnamed drill';
}

/** Text an item gives beside its linked drill (a dosage, a set), shown under the drill's name. */
function itemText(item: TemplateItem): string | null {
  return item.drill_id !== null && (item.free_text_drill ?? '').trim() !== '' ? item.free_text_drill : null;
}

/** The item's other source-sheet fields (details), as written, for the "From the sheet" list. */
const SHEET_SHOWN_ELSEWHERE = new Set(['duration_minutes']);
function sheetFields(item: TemplateItem): [string, unknown][] {
  return Object.entries(item.details ?? {}).filter(([key, value]) => !SHEET_SHOWN_ELSEWHERE.has(key) && value !== null && value !== '');
}

function sheetText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sheetText).join('\n');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}:\n${sheetText(entry)}`).join('\n');
  }
  return String(value);
}

/** What one item prescribes, from the nullable columns it actually has. */
function itemPrescription(item: TemplateItem): string {
  const parts: string[] = [];
  if (item.duration_minutes !== null) parts.push(`${item.duration_minutes} min`);
  if (item.rep_count !== null) parts.push(`${item.rep_count} reps`);
  return parts.join(', ');
}

/**
 * A template row's facts line from what it has; it never reads "null min". Defensive only: the
 * database keeps session_type, difficulty, duration_minutes and intent NOT NULL (OD-2026-11-17-001),
 * so a blank session type is the one empty value a stored template can show.
 */
function templateFacts(template: Template): string {
  return [
    template.session_type.replace(/_/g, ' '),
    template.age_band.replace(/_/g, ' ').toLowerCase(),
    template.duration_minutes === null ? '' : `${template.duration_minutes} min`,
  ].filter((part) => part.trim() !== '').join(' -- ');
}

/**
 * Does a template match what the coach typed in "Find a template"? Every word
 * typed must appear somewhere in the template's name, intent, session type,
 * age group or difficulty, in any order and any case. An empty box matches all.
 * (Staging dry run, 2026-11-19: about 130 templates in one list, no way to look one up.)
 */
function templateMatches(template: Template, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const hay = [template.name, template.intent, template.session_type, template.age_band, template.difficulty ?? '']
    .join(' ')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

function CoachWorkoutTemplates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // What the coach typed in "Find a template". It only narrows the list on
  // screen; the open template always stays (see `shown` below).
  const [query, setQuery] = useState('');
  // Bumped on every open, so focus moves to the opened template each time,
  // including a second open of the same one after an error.
  const [focusDetail, setFocusDetail] = useState(0);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  const [openTemplateId, setOpenTemplateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // True while an issue is running. Opening a template unmounts the issue
  // control, and an issue whose control is gone answers to nobody: the cards
  // would exist with nothing on screen to say so.
  const [issuing, setIssuing] = useState(false);
  // The same, while a session script is being made from the open template.
  const [making, setMaking] = useState(false);
  // Edit (OD-2026-11-19-005, OW25-51; lane ED-UI PR2): the template whose form
  // is open, whether its save and the reads after it are running, and what the
  // last save did. The page's gate admits coach and organization admin, the
  // roles PATCH /api/pilot/workout-templates admits; the route decides.
  const [editingId, setEditingId] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editNotice, setEditNotice] = useState('');
  // A save refused as stale, or with no known outcome: Cancel opens the
  // template again from the server, so what shows is current.
  const rereadOnCancel = useRef(false);
  // The request key of every issue that has no settled answer yet, by template
  // and athlete. Held here, above the issue control, which comes and goes.
  const requestKeys = useRef<RequestKeys>(new Map());
  // Counts detail reads, so only the LATEST one may change what is open. Two
  // reads can overlap (tap one template, then another, on slow wifi), and a
  // late answer to the first would otherwise swap the template under an open
  // issue control: the confirm sentence would name one template and send
  // another, or a result would sit under a template it was not issued from.
  const detailRead = useRef(0);

  // No state is set before the first await, matching the session-scripts
  // page: a synchronous setState inside an effect cascades a render before
  // the request has even left.
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/workout-templates`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The workout templates could not be loaded.');
      const payload = (await response.json()) as { templates?: Template[] };
      setTemplates(payload.templates ?? []);
      setLoadError('');
    } catch (error) {
      setTemplates([]);
      setLoadError(error instanceof Error ? error.message : 'The workout templates could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const openTemplate = useCallback(async (templateId: string) => {
    detailRead.current += 1;
    const thisRead = detailRead.current;
    const latest = () => detailRead.current === thisRead;
    // Clearing the previous template's detail and error together, so one
    // template's items -- or its failure -- never render under another
    // template's name while the new read is in flight.
    setOpenTemplateId(templateId);
    setEditNotice('');
    setEditingId('');
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setFocusDetail((count) => count + 1);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/workout-templates?template_id=${encodeURIComponent(templateId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('That workout template could not be opened.');
      const payload = (await response.json()) as Partial<Omit<TemplateDetail, 'untestedDrills' | 'refusedDrills'>> & {
        untested_drills?: unknown;
        refused_drills?: unknown;
      };
      if (!payload.template) throw new Error('That workout template could not be opened.');
      if (latest()) {
        setDetail({
          template: payload.template,
          items: payload.items ?? [],
          untestedDrills: namedDrills(payload.untested_drills),
          // Not sent: undefined. Sent but not a list (null, or a shape this
          // screen cannot read): "could not be checked", never "none refused".
          refusedDrills: payload.refused_drills === undefined
            ? undefined
            : Array.isArray(payload.refused_drills) ? refusedDrillsFrom(payload.refused_drills) : null,
        });
      }
    } catch (error) {
      if (latest()) {
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : 'That workout template could not be opened.');
      }
    } finally {
      if (latest()) setDetailLoading(false);
    }
  }, []);

  // After a save: the list is read again and the new version opens, read from
  // the server, not from the form; nothing else starts until both reads end.
  async function afterEditSaved(outcome: TemplateEditOutcome) {
    rereadOnCancel.current = false;
    setEditingId('');
    if (!outcome.changed) {
      setEditBusy(false);
      setEditNotice('Nothing changed. No new version was written.');
      setFocusDetail((count) => count + 1);
      return;
    }
    try {
      await load();
      await openTemplate(outcome.templateId);
      setEditNotice(`Saved as version ${outcome.version}.`);
    } finally {
      setEditBusy(false);
    }
  }

  // After a 409 or an unknown outcome the page may be out of date: the list is
  // read again now, and Cancel reopens the template; the form keeps what was
  // typed. A plain refusal changed nothing and reads nothing.
  async function afterEditFailed(status: number | null) {
    try {
      if (status === null || status >= 500 || status === 409) {
        rereadOnCancel.current = true;
        await load();
      }
    } finally {
      setEditBusy(false);
    }
  }

  // A day on Class plans opens its template here: /coach/workout-templates?template=<id>.
  // Read once on arrival, from the address (client only); without the
  // parameter nothing changes. A template that cannot be opened says so in the
  // same place a failed open does.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('template');
    if (!requested) return;
    void (async () => {
      await openTemplate(requested);
    })();
  }, [openTemplate]);

  // The opened template is drawn right under its own card (below), and focus
  // goes to its heading, so the coach is taken to it rather than left at a
  // button that only changed its words while the template sat at the foot of
  // a long list (staging dry run, 2026-11-19). No smooth scroll: an instant
  // move needs no reduced-motion exception.
  useEffect(() => {
    if (focusDetail === 0) return;
    const heading = detailHeadingRef.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView?.({ block: 'start' });
  }, [focusDetail]);

  const openIsListed = openTemplateId !== null && templates.some((template) => template.template_id === openTemplateId);

  // Opened from the address (a Class plans day) before the list arrived, the
  // template was drawn first; when the list lands it moves under its own card,
  // which can be far down. If the coach is still on its heading (has not moved
  // on to anything else), bring it back into view. Focus is never taken from
  // a control the coach has moved to (review, 2026-11-19).
  useEffect(() => {
    if (!openIsListed) return;
    const heading = detailHeadingRef.current;
    if (heading && document.activeElement === heading) heading.scrollIntoView?.({ block: 'start' });
  }, [openIsListed]);

  // What the list shows: the templates that match the box, and always the open
  // one. Filtering never takes the open template off the screen, because an
  // issue or a plan being made from it answers to that block, and a result
  // with nowhere to show would be lost.
  const shown = templates.filter(
    (template) => template.template_id === openTemplateId || templateMatches(template, query),
  );
  const filtering = query.trim() !== '';
  const matchCount = templates.filter((template) => templateMatches(template, query)).length;
  const openHeldByFilter = filtering && openIsListed
    && !templates.some((template) => template.template_id === openTemplateId && templateMatches(template, query));

  const detailSection = openTemplateId === null ? null : (
          <section
            key="open-template"
            aria-labelledby="open-template-heading"
            className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] md:col-span-2"
          >
            <h2
              id="open-template-heading"
              ref={detailHeadingRef}
              tabIndex={-1}
              className="t-command text-[length:var(--t-lg)]"
            >
              {detail ? detail.template.name : 'Workout template'}
            </h2>

            {detailLoading && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the template...</p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">
                {detailError}
              </p>
            )}

            {editNotice && <p role="status" className="t-body mt-[var(--s3)] text-[color:var(--bone-200)]">{editNotice}</p>}

            {!detailLoading && !detailError && detail && editingId === detail.template.template_id && (
              <div className="mt-[var(--s4)]">
                <TemplateEditForm
                  key={detail.template.template_id}
                  template={detail.template}
                  items={detail.items}
                  itemNames={detail.items.map((item, index) => `${index + 1}. ${itemName(item)}`)}
                  onCancel={() => {
                    setEditingId('');
                    if (rereadOnCancel.current) void openTemplate(detail.template.template_id);
                    else setFocusDetail((count) => count + 1);
                    rereadOnCancel.current = false;
                  }}
                  onSaved={(outcome) => void afterEditSaved(outcome)}
                  onSaving={() => setEditBusy(true)}
                  onFailed={(status) => void afterEditFailed(status)}
                  busy={editBusy}
                />
              </div>
            )}

            {!detailLoading && !detailError && detail && editingId !== detail.template.template_id && (
              <>
                {/* Only the current version: the route refuses any other (TEMPLATE_VERSION_STALE). */}
                {detail.template.superseded_at === null && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditNotice('');
                      setEditingId(detail.template.template_id);
                    }}
                    disabled={issuing || making || editBusy}
                    className="btn btn--ghost btn--kiosk mt-[var(--s3)]"
                    aria-label={`Edit: ${detail.template.name}`}
                  >
                    Edit
                  </button>
                )}
                {(detail.template.coach_notes ?? '').trim() !== '' && (
                  <div className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
                    <p className="t-label">Coach notes</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{detail.template.coach_notes}</p>
                  </div>
                )}

                <h3 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">The blocks</h3>

                {detail.items.length === 0 && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                    This template has no items yet.
                  </p>
                )}

                <ol className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
                  {detail.items.map((item) => (
                    <li
                      key={item.item_id}
                      className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                    >
                      <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="plaque">{item.block.replace(/_/g, ' ')}</span>
                        <h4 className="t-command text-[length:var(--t-sm)]">
                          {/* The lineage head's name; the raw drill_id only
                              when that row did not resolve. */}
                          {itemName(item)}
                        </h4>
                        {itemPrescription(item) !== '' && (
                          <span className="t-label">{itemPrescription(item)}</span>
                        )}
                        {item.scale_level && (
                          <span className="t-label">Scale {item.scale_level}</span>
                        )}
                        {sheetMinutes(item) !== null && (
                          <span className="t-label text-[color:var(--bone-400)]">
                            {`Sheet says ${sheetMinutes(item)} min (information; not timed or issued)`}
                          </span>
                        )}
                        <span className="t-label text-[color:var(--bone-400)]">
                          {item.contact_level.replace(/_/g, ' ')}
                        </span>
                      </div>
                      {/* The template still points at the drill version it
                          was written against; the library has a newer one.
                          Said, not fixed -- the server never repoints an item
                          (workoutTemplates.ts), so the coach decides. */}
                      {item.uses_older_drill_version && (
                        <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                          Uses an older drill version.
                        </p>
                      )}
                      {itemText(item) !== null && (
                        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{itemText(item)}</p>
                      )}
                      {(item.coach_note ?? '').trim() !== '' && (
                        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                          <span className="t-label">Note: </span>
                          {item.coach_note}
                        </p>
                      )}
                      {/* The source sheet's own fields for this item, as written (lane YR): information only. */}
                      {sheetFields(item).length > 0 && (
                        <details className="mt-[var(--s2)]">
                          <summary className="t-label cursor-pointer">From the sheet</summary>
                          <dl className="mt-[var(--s1)]">
                            {sheetFields(item).map(([key, value]) => (
                              <div key={key} className="t-body mt-[var(--s1)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                                <dt className="inline font-semibold">{`${key.replace(/_/g, ' ')}: `}</dt>
                                <dd className="inline whitespace-pre-line">{sheetText(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}

            {/* Hidden, not unmounted, while the form is open: an issue or a
                plan answered before Edit is still there after Cancel (review). */}
            {!detailLoading && !detailError && detail && (
              <div hidden={editingId === detail.template.template_id}>
                {/* Opening another template unmounts this whole block while
                    the new one loads (openTemplate clears `detail`), so the
                    control always starts clean: no athlete, no confirm step,
                    no result left over from the template open before. The
                    request keys are the one thing that must NOT start clean,
                    so they are this component's and are handed down. */}
                {detail.items.length > 0 && (
                  <IssueToAthlete
                    template={detail.template}
                    untestedDrills={detail.untestedDrills}
                    refusedDrills={detail.refusedDrills}
                    onRecheck={() => void openTemplate(detail.template.template_id)}
                    // Not while a session plan is being made: re-reading the
                    // template unmounts it and its answer (review B), the
                    // reason the Open template button waits too.
                    recheckBlocked={issuing || making}
                    onBusyChange={setIssuing}
                    requestKeys={requestKeys}
                  />
                )}

                {/* Keyed by the template, and unmounted with the block above
                    when another template is opened: a result never sits under
                    a template it was not made from. */}
                {detail.items.length > 0 && (
                  <MakeSessionScript
                    key={detail.template.template_id}
                    templateId={detail.template.template_id}
                    onBusyChange={setMaking}
                  />
                )}
              </div>
            )}
          </section>
  );

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Workout Templates</h1>
          <ClusterNav cluster="planning" />
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The reusable session shapes behind the plans: what a session of each type looks like,
            block by block. Open one to issue it to an athlete, or to make a session plan from
            it. Delivering a session live happens from Session Plans.
          </p>
          <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/session-scripts" className="btn btn--ghost">
              Go to Session Plans
            </Link>
            <Link href="/coach/drills" className="btn btn--ghost">
              Back to drill library
            </Link>
          </div>
        </header>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Templates</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty catalog of templates.
              </p>
            </div>
          )}

          {!loading && !loadError && templates.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              No workout templates are loaded in this environment yet.
            </p>
          )}

          {!loading && !loadError && templates.length > 0 && (
            <div className="mt-[var(--s4)] flex max-w-xl flex-col gap-[var(--s2)]">
              <label className="t-label" htmlFor="template-find">Find a template</label>
              <input
                id="template-find"
                type="search"
                className="input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, what it is for, session type, age group or level"
                autoComplete="off"
              />
              <p aria-live="polite" className="t-label text-[color:var(--bone-400)]">
                {filtering
                  ? `${matchCount} of ${templates.length} ${templates.length === 1 ? 'template matches' : 'templates match'}.${openHeldByFilter ? ' The open template stays in the list.' : ''}`
                  : `${templates.length} ${templates.length === 1 ? 'template' : 'templates'}.`}
              </p>
              {filtering && shown.length === 0 && (
                <p className="t-body text-[color:var(--bone-300)]">
                  {`No template matches "${query.trim()}". Clear the box to see them all.`}
                </p>
              )}
            </div>
          )}

          {/* One grid holds the cards AND the open template, so the template is
              drawn right under its own card instead of below the whole list,
              and moving it (another card opened, the box narrowed, the list
              arriving after an address opened it) never remounts it: an issue
              or a plan being made from it keeps its answer. That holds only
              because the block and the cards are ONE keyed array: React matches
              keys within an array, so a block that moved from its own slot
              into the array would be rebuilt and lose its answer (review,
              2026-11-19). A template the list does not hold (an address naming
              one this read did not return, or the list not loaded yet) is drawn
              first. */}
          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {[
              ...(openIsListed || detailSection === null ? [] : [detailSection]),
              ...shown.flatMap((template) => {
              const card = (
                <article key={template.template_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                  <div className="flex items-baseline justify-between gap-[var(--s3)]">
                    <h3 className="t-command text-[length:var(--t-md)]">{template.name}</h3>
                    {template.difficulty && <span className="plaque">{template.difficulty}</span>}
                  </div>
                  <p className="t-label mt-[var(--s2)]">{templateFacts(template)}</p>
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{orNotWritten(template.intent)}</p>
                  {template.requires_coach_authorization && (
                    <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                      Requires coach authorization before use.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void openTemplate(template.template_id)}
                    className="btn btn--ghost mt-[var(--s4)]"
                    // Not while an issue runs (its answer would be lost), and not
                    // for the template already showing with its issue control (a
                    // stray tap would wipe the result the coach is reading). A
                    // template with no steps has no control, and can be re-read.
                    disabled={issuing || making || editingId !== '' || editBusy || (openTemplateId === template.template_id && detail !== null && detail.items.length > 0)}
                  >
                    {openTemplateId === template.template_id ? 'Showing template' : 'Open template'}
                  </button>
                </article>
              );
              return template.template_id === openTemplateId && detailSection ? [card, detailSection] : [card];
            }),
            ]}
          </div>
        </section>

      {/* The four words, at the foot of the page — the same foot the
          approved boards put under every full screen. See WorkAxis. */}
      <WorkAxis />
      </div>
    </main>
  );
}

export default function CoachWorkoutTemplatesPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachWorkoutTemplates />
    </RoleSessionGate>
  );
}
