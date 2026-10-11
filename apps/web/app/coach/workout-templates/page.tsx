'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import WorkAxis from '@/components/WorkAxis';
import { apiBase } from '@/lib/apiBase';
import type {
  TemplateIssueRefusedDrill,
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
// EACH STEP IS A SEPARATE COACH CARD FOR NOW, and the result says so plainly:
// an assignment has nowhere to keep a step's block, order, scale level,
// contact level or coach note, so the athlete does not receive the session's
// shape (follow-up #1419 adds it).
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
  if (typeof scope !== 'string' || !Object.hasOwn(HOLD_SCOPE_LABEL, scope)) return 'unreadable';
  return { scopeLabel: HOLD_SCOPE_LABEL[scope] };
}

type IssueOutcome =
  | { kind: 'issued'; athleteName: string; cards: number; adopted: string[]; hold: HoldNote }
  | { kind: 'refused'; message: string; drills: TemplateIssueRefusedDrill[] }
  | { kind: 'failed'; message: string };

const ISSUE_NOT_FOUND =
  'That athlete or template could not be found, or you can no longer reach that athlete. Nothing was issued.';
const ISSUE_FAILED = 'The template could not be issued. Nothing was issued.';
// No answer came back, so this screen does not know which way it went.
const ISSUE_NO_ANSWER =
  'No answer came back, so this template may or may not have been issued. '
  + "Check the athlete's Coach Cards before trying again.";

function namedDrills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((drill) => {
    const name = (drill as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() !== '' ? [name] : [];
  });
}

function IssueToAthlete({ template }: { readonly template: Template }) {
  // null until the read answers, so "still loading" is never drawn as "nobody".
  const [athletes, setAthletes] = useState<ReachableAthlete[] | null>(null);
  const [athletesError, setAthletesError] = useState('');
  const [athleteId, setAthleteId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<IssueOutcome | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        // The athletes this coach may act ON, not everyone in the gym: the
        // picker never offers an athlete the issue would then refuse.
        const response = await fetch(`${apiBase()}/api/pilot/coach/athletes`, {
          method: 'GET',
          credentials: 'include',
        });
        if (!response.ok) throw new Error('The athletes could not be loaded.');
        const payload = (await response.json()) as { items?: ReachableAthlete[] };
        if (!current) return;
        setAthletes(payload.items ?? []);
        setAthletesError('');
      } catch (error) {
        if (!current) return;
        setAthletes([]);
        setAthletesError(error instanceof Error ? error.message : 'The athletes could not be loaded.');
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  const chosen = (athletes ?? []).find((athlete) => athlete.athlete_id === athleteId) ?? null;

  const issue = async () => {
    // No second send while one runs: every control below is disabled on
    // `busy`, and React re-renders between two taps, so the button is already
    // dead when a second tap arrives.
    if (!chosen) return;
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/workout-templates/issue`, {
          credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: template.template_id, athlete_id: chosen.athlete_id }),
        });
      } catch {
        setOutcome({ kind: 'failed', message: ISSUE_NO_ANSWER });
        return;
      }
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (response.status === 201 && payload) {
        const steps = Array.isArray(payload.steps) ? payload.steps.length : 0;
        setOutcome({
          kind: 'issued',
          athleteName: chosen.full_name,
          cards: steps,
          adopted: namedDrills(payload.adopted_drills),
          hold: holdNoteFrom(payload.hold_warning),
        });
        return;
      }
      if (response.status === 409 && payload?.code === 'WORKOUT_TEMPLATE_ISSUE_REFUSED') {
        setOutcome({
          kind: 'refused',
          message: typeof payload.error === 'string' ? payload.error : 'Nothing was issued.',
          drills: Array.isArray(payload.drills) ? (payload.drills as TemplateIssueRefusedDrill[]) : [],
        });
        return;
      }
      if (response.status === 404) {
        setOutcome({ kind: 'failed', message: ISSUE_NOT_FOUND });
        return;
      }
      // Any other conflict carries the server's own sentence (a template no
      // longer in use, a library that changed mid-issue: "try again").
      const said = response.status === 409 && typeof payload?.error === 'string' ? payload.error : '';
      setOutcome({ kind: 'failed', message: said || ISSUE_FAILED });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div
      data-surface="kiosk"
      className="mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
    >
      <h3 className="t-command text-[length:var(--t-md)]">Issue to athlete</h3>

      {athletes === null && <p className="t-body mt-[var(--s3)]">Loading athletes...</p>}

      {athletes !== null && athletesError && (
        <p role="alert" className="t-body mt-[var(--s3)] font-semibold text-[var(--locked-ink)]">
          {athletesError} This is a failure to load, not an empty list of athletes.
        </p>
      )}

      {athletes !== null && !athletesError && athletes.length === 0 && (
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
            }}
          >
            <option value="">Choose an athlete</option>
            {athletes.map((athlete) => (
              <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
            ))}
          </select>

          {!confirming && (
            <button
              type="button"
              className="btn btn--kiosk"
              disabled={!chosen || busy}
              onClick={() => {
                setOutcome(null);
                setConfirming(true);
              }}
            >
              Issue to athlete
            </button>
          )}

          {confirming && chosen && (
            <div className="flex flex-col gap-[var(--s3)]">
              <p className="t-body font-semibold">
                Issue {template.name} to {chosen.full_name}? Each step becomes a separate Coach Card.
              </p>
              <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void issue()}>
                {busy ? 'Issuing...' : 'Confirm issue'}
              </button>
              <button type="button" className="btn btn--ghost btn--kiosk" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {outcome?.kind === 'issued' && (
        <div role="status" className="mt-[var(--s4)] flex flex-col gap-[var(--s2)]">
          <p className="t-body font-semibold">
            Issued to {outcome.athleteName}: {outcome.cards} Coach {outcome.cards === 1 ? 'Card' : 'Cards'}.
          </p>
          <p className="t-body">
            Each step is a separate Coach Card for now. The block, order, scale level, contact level and
            coach note are not carried.
          </p>
          {outcome.adopted.length > 0 && (
            <p className="t-body">Adopted for this gym: {outcome.adopted.join(', ')}.</p>
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
        </div>
      )}

      {outcome?.kind === 'refused' && (
        <div role="alert" className="mt-[var(--s4)] flex flex-col gap-[var(--s2)]">
          <p className="t-body font-semibold text-[var(--locked-ink)]">{outcome.message}</p>
          <ul className="flex flex-col gap-[var(--s2)]">
            {outcome.drills.map((drill) => (
              <li key={`${drill.drill_id ?? 'typed'}-${drill.steps.join('-')}`} className="t-body">
                <span className="font-semibold">{drill.name}</span>
                {` (step ${drill.steps.join(', ')}): ${drill.reason}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome?.kind === 'failed' && (
        <p role="alert" className="t-body mt-[var(--s4)] font-semibold text-[var(--locked-ink)]">
          {outcome.message}
        </p>
      )}
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
      setDetail({ template: payload.template, items: payload.items ?? [] });
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : 'That workout template could not be opened.');
    } finally {
      setDetailLoading(false);
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
                    no result left over from the template open before. */}
                {detail.items.length > 0 && <IssueToAthlete template={detail.template} />}
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
