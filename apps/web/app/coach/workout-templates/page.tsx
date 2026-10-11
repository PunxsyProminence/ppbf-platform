'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import WorkAxis from '@/components/WorkAxis';
import { apiBase } from '@/lib/apiBase';
import type {
  WorkoutTemplateItemWithDrillHead,
  WorkoutTemplateRow,
} from '@/src/server/pilot/workoutTemplates';

// Browse over pilot.workout_templates, the first UI consumer of
// GET /api/pilot/workout-templates. The TEMPLATES are read-only by design --
// they are seeded reference data, not something a coach authors from the
// floor -- so this page offers no create, no edit, and no delete, and that
// absence is deliberate rather than unfinished.
//
// The one write is ISSUING an open template to an athlete (lane P7, #1401;
// POST /api/pilot/workout-templates/issue). It writes assignments, never a
// template, and only after the coach confirms. See IssueToAthlete below.
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

function namedDrills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((drill) => {
    const name = (drill as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() !== '' ? [name] : [];
  });
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
  | { kind: 'issued'; athleteName: string; cards: number | null; adopted: string[]; updated?: string[]; hold: HoldNote; already?: boolean }
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

const ALERT_TEXT = 'text-[length:var(--t-md)] font-semibold text-[var(--locked-ink)]';

function IssueToAthlete({
  template,
  onBusyChange,
  requestKeys,
}: {
  readonly template: Template;
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

          {/* Stays in its place, disabled, while the confirm step is open: a
              second tap on the same spot then lands on a dead button, never
              on Confirm. */}
          <button
            ref={issueButtonRef}
            type="button"
            className="btn btn--kiosk"
            disabled={!chosen || busy || confirming}
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
            <ul className="flex flex-col gap-[var(--s2)]">
              {outcome.drills.map((drill, index) => (
                // Index key: the list is drawn once per answer and never reordered.
                <li key={index} className="t-body">
                  <span className="font-semibold">{drill.name}</span>
                  {drill.steps.length > 0 && ` (${drill.steps.length === 1 ? 'step' : 'steps'} ${drill.steps.join(', ')})`}
                  {drill.reason !== '' && `: ${drill.reason}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        {outcome?.kind === 'failed' && (
          <p role="alert" className={ALERT_TEXT}>{outcome.message}</p>
        )}
      </div>
    </div>
  );
}

/** What one item prescribes, from the nullable columns it actually has. */
function itemPrescription(item: TemplateItem): string {
  const parts: string[] = [];
  if (item.duration_minutes !== null) parts.push(`${item.duration_minutes} min`);
  if (item.rep_count !== null) parts.push(`${item.rep_count} reps`);
  return parts.join(', ');
}

function CoachWorkoutTemplates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [openTemplateId, setOpenTemplateId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // True while an issue is running. Opening a template unmounts the issue
  // control, and an issue whose control is gone answers to nobody: the cards
  // would exist with nothing on screen to say so.
  const [issuing, setIssuing] = useState(false);
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
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/workout-templates?template_id=${encodeURIComponent(templateId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('That workout template could not be opened.');
      const payload = (await response.json()) as Partial<TemplateDetail>;
      if (!payload.template) throw new Error('That workout template could not be opened.');
      if (latest()) setDetail({ template: payload.template, items: payload.items ?? [] });
    } catch (error) {
      if (latest()) {
        setDetail(null);
        setDetailError(error instanceof Error ? error.message : 'That workout template could not be opened.');
      }
    } finally {
      if (latest()) setDetailLoading(false);
    }
  }, []);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Workout Templates</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The reusable session shapes behind the plans: what a session of each type looks like,
            block by block. Open one to issue it to an athlete. Delivering a session live happens
            from Session Scripts.
          </p>
          <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/session-scripts" className="btn btn--ghost">
              Go to session scripts
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
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
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

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {templates.map((template) => (
              <article key={template.template_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{template.name}</h3>
                  <span className="plaque">{template.difficulty}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">
                  {template.session_type.replace(/_/g, ' ')}
                  {` -- ${template.age_band}`}
                  {` -- ${template.duration_minutes} min`}
                </p>
                {template.intent.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{template.intent}</p>
                )}
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
                  disabled={issuing || (openTemplateId === template.template_id && detail !== null && detail.items.length > 0)}
                >
                  {openTemplateId === template.template_id ? 'Showing template' : 'Open template'}
                </button>
              </article>
            ))}
          </div>
        </section>

        {openTemplateId !== null && (
          <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command text-[length:var(--t-lg)]">
              {detail ? detail.template.name : 'Workout template'}
            </h2>

            {detailLoading && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the template...</p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
                {detailError}
              </p>
            )}

            {!detailLoading && !detailError && detail && (
              <>
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
                          {item.free_text_drill ?? item.head_drill_name ?? item.drill_id ?? 'Unnamed drill'}
                        </h4>
                        {itemPrescription(item) !== '' && (
                          <span className="t-label">{itemPrescription(item)}</span>
                        )}
                        {item.scale_level && (
                          <span className="t-label">Scale {item.scale_level}</span>
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
                      {(item.coach_note ?? '').trim() !== '' && (
                        <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                          <span className="t-label">Note: </span>
                          {item.coach_note}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>

                {/* Opening another template unmounts this whole block while
                    the new one loads (openTemplate clears `detail`), so the
                    control always starts clean: no athlete, no confirm step,
                    no result left over from the template open before. The
                    request keys are the one thing that must NOT start clean,
                    so they are this component's and are handed down. */}
                {detail.items.length > 0 && (
                  <IssueToAthlete template={detail.template} onBusyChange={setIssuing} requestKeys={requestKeys} />
                )}
              </>
            )}
          </section>
        )}

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
