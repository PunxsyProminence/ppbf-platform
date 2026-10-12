'use client';

import Link from 'next/link';
import React, { useEffect, useId, useState } from 'react';
import StepNotes from './IssuedWorkoutStepNotes';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import {
  readDatedIssuedWorkouts,
  sectionAssignedWork,
  type AssignedWorkSection,
  type DatedIssuedWorkout,
  type IssuedWorkoutStepView,
} from '@/src/lib/issuedWorkouts';

/* THE GUARDIAN'S ASSIGNMENTS TAB (WO-PH-03). What the coach has set the child
   to work on, from the same read and in the same shape as
   /parent/progression-visibility: GET /api/pilot/progression/assignments,
   which checks the guardian link to this child and answers with the family
   projection -- the coach's display name, never an account id.

   READ-ONLY, and that is the decision rather than an omission (Q1 = B). A
   completion is logged by the athlete and verified by a coach; the
   completions route refuses a guardian. A family supports the practice and
   reads the record. */

type AssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';

interface FamilyAssignment {
  assignment_id: string;
  drill_name: string;
  drill_description: string;
  drill_display_name?: string;
  drill_display_description?: string;
  rep_count?: number | null;
  duration_minutes?: number | null;
  frequency_per_week?: number | null;
  due_date?: string | null;
  status: AssignmentStatus;
  assigned_by_name?: string;
}

const STATUSES: readonly AssignmentStatus[] = ['assigned', 'in_progress', 'completed', 'incomplete', 'cancelled'];
const ACTIVE: readonly AssignmentStatus[] = ['assigned', 'in_progress'];

/* Status in words, with a glyph so it is never the colour alone. Not done is
   not a safety state: nothing here wears --locked, which means a medical stop
   (OD-2026-09-29-001). */
const STATUS_MARK: Record<Exclude<AssignmentStatus, 'cancelled'>, { label: string; className: string; glyph: string }> = {
  assigned: { label: 'Assigned', className: 'badge badge--monitor', glyph: '◉' },
  in_progress: { label: 'In progress', className: 'badge badge--monitor', glyph: '◉' },
  completed: { label: 'Completed', className: 'badge badge--cleared', glyph: '✓' },
  incomplete: { label: 'Closed, not completed', className: 'badge badge--filed', glyph: '–' },
};

type Loaded =
  | { athleteId: string; state: 'loaded'; items: FamilyAssignment[]; workouts: DatedIssuedWorkout[] }
  | { athleteId: string; state: 'failed' };

function isFamilyAssignment(value: unknown): value is FamilyAssignment {
  const row = value as Partial<FamilyAssignment> | null;
  return row !== null && typeof row === 'object'
    && typeof row.assignment_id === 'string'
    && typeof row.drill_name === 'string'
    // A status outside the five is not guessed at: the answer is unreadable.
    && STATUSES.includes(row.status as AssignmentStatus);
}

function AssignmentCard({ assignment, step }: { assignment: FamilyAssignment; step: IssuedWorkoutStepView | null }) {
  const mark = STATUS_MARK[assignment.status as Exclude<AssignmentStatus, 'cancelled'>];
  const Heading = step ? 'h6' : 'h4';
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
        <div>
          {step ? <p className="t-label">Step {step.ordinal}</p> : null}
          <Heading className="t-body font-semibold">
            {assignment.drill_display_name || assignment.drill_name}
          </Heading>
          <p className="t-body mt-[var(--s2)]">
            {assignment.drill_display_description || assignment.drill_description}
          </p>
        </div>
        {mark ? <span className={mark.className}><i aria-hidden="true">{mark.glyph}</i>{mark.label}</span> : null}
      </div>
      {step ? <StepNotes step={step} /> : null}
      <dl className="mt-[var(--s3)] flex flex-wrap gap-x-[var(--s5)] gap-y-[var(--s2)]">
        {assignment.rep_count != null ? (
          <div>
            <dt className="t-label">Reps</dt>
            <dd className="t-data">{assignment.rep_count}</dd>
          </div>
        ) : null}
        {assignment.duration_minutes != null ? (
          <div>
            <dt className="t-label">Duration</dt>
            <dd className="t-data">{assignment.duration_minutes} min</dd>
          </div>
        ) : null}
        {assignment.frequency_per_week ? (
          <div>
            <dt className="t-label">Per week</dt>
            <dd className="t-data">{assignment.frequency_per_week}x</dd>
          </div>
        ) : null}
        {assignment.due_date ? (
          <div>
            <dt className="t-label">Due</dt>
            <dd className="t-data">{formatCalendarDay(assignment.due_date)}</dd>
          </div>
        ) : null}
        {assignment.assigned_by_name ? (
          <div>
            <dt className="t-label">Assigned by</dt>
            <dd className="t-data">{assignment.assigned_by_name}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

type Section = AssignedWorkSection<FamilyAssignment, DatedIssuedWorkout>;

function AssignmentGroup({ heading, sections }: { heading: string; sections: Section[] }) {
  const headingId = useId();
  if (sections.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-[var(--s4)]">
      <h3 id={headingId} className="t-label">{heading}</h3>
      {sections.map((section) => {
        if (section.kind === 'assignment') {
          return (
            <article key={section.key} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]" data-testid="assignment">
              <AssignmentCard assignment={section.assignment} step={null} />
            </article>
          );
        }
        const { workout, stepCount } = section;
        // The steps drawn are the workout's steps still on the record; one the
        // coach withdrew is not drawn, and the count says so rather than
        // passing a shorter workout off as the whole of it.
        const total = workout.steps.length;
        const steps = stepCount === total
          ? (total === 1 ? '1 step' : `${total} steps`)
          : `${stepCount} of ${total} steps`;
        return (
          <article key={section.key} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]" data-testid="issued-workout">
            <p className="t-eyebrow">Workout</p>
            <h4 className="t-body mt-[var(--s2)] font-semibold">{workout.template_name}</h4>
            <p className="t-body mt-[var(--s2)]">
              {workout.issued_by_name ? `From: ${workout.issued_by_name} · ` : ''}
              {formatGymDateNumeric(workout.issued_at)} · {steps}, in this order
            </p>
            <div className="mt-[var(--s4)] space-y-[var(--s4)]">
              {section.parts.map((part) => (part.kind === 'block' ? (
                <h5 key={part.key} className="t-label">{part.block.replace(/_/g, ' ')}</h5>
              ) : (
                <div key={part.key} className="border-l-4 border-[color:var(--brass-700)] pl-[var(--s4)]" data-testid="issued-workout-step">
                  <AssignmentCard assignment={part.assignment} step={part.step} />
                </div>
              )))}
            </div>
          </article>
        );
      })}
    </section>
  );
}

export default function ParentAssignmentList({ athleteId }: { readonly athleteId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  /* One read per child, keyed by athlete. Switching child aborts the read for
     the child left behind, and the aborted checks below stop an answer that
     was already in the pipe from writing; the keyed match at render means the
     previous child's list is never drawn under the new child's name while the
     new read is open. */
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/progression/assignments?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const payload = response.ok
          ? (await response.json().catch(() => null)) as { items?: unknown; workouts?: unknown } | null
          : null;
        if (controller.signal.aborted) return;
        if (!payload || !Array.isArray(payload.items) || !payload.items.every(isFamilyAssignment)) {
          setLoaded({ athleteId, state: 'failed' });
          return;
        }
        // A workouts field that is present but unreadable is not "no
        // workouts": its steps would be drawn as loose drills. It throws, and
        // the list says it could not be read.
        const workouts = readDatedIssuedWorkouts(payload.workouts);
        setLoaded({ athleteId, state: 'loaded', items: payload.items, workouts });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setLoaded({ athleteId, state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  const shown = loaded?.athleteId === athleteId ? loaded : null;

  return (
    <div className="space-y-[var(--s5)]">
      {shown === null ? (
        <p className="working">Reading the assignments...</p>
      ) : shown.state === 'failed' ? (
        <p className="t-muted">Unavailable - the assignments could not be read. This is not an empty list.</p>
      ) : (() => {
        // Withdrawn by the coach: not work to support. It stays on the full
        // record. A workout is sectioned ONCE over everything else, so it is
        // drawn whole, in one place: under "Working on now" while any of its
        // steps is still open, under "Done or closed" when none is.
        const sections = sectionAssignedWork(
          shown.items.filter((item) => item.status !== 'cancelled'),
          shown.workouts,
        );
        if (sections.length === 0) {
          return <p className="t-body">No assignments from the coach right now.</p>;
        }
        const isOpen = (section: Section) => (section.kind === 'assignment'
          ? ACTIVE.includes(section.assignment.status)
          : section.parts.some((part) => part.kind === 'step' && ACTIVE.includes(part.assignment.status)));
        return (
          <>
            <AssignmentGroup heading="Working on now" sections={sections.filter(isOpen)} />
            <AssignmentGroup heading="Done or closed" sections={sections.filter((section) => !isOpen(section))} />
          </>
        );
      })()}
      {/* The full record page opens on the first linked child and has its own
          chooser, so the link does not promise this child. */}
      <Link href="/parent/progression-visibility" className="btn btn--ghost">
        Open the full progression record
      </Link>
    </div>
  );
}
