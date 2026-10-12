'use client';

import Link from 'next/link';
import React, { useEffect, useId, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { readIssuedWorkouts, sectionAssignedWork } from '@/src/lib/issuedWorkouts';

/* WHERE THINGS STAND (WO-PH-09). A compact count of the selected child's
   recorded progression -- the focus areas the coach has recorded, the drills
   and workouts set, the work logged against them, and the family's own
   support tasks -- read from the same guardian-checked routes the full record
   at /parent/progression-visibility reads, and linking to it (Q1 = A).

   EVERY LINE IS A COUNT OF ROWS, SAID AS WHAT THE ROWS HOLD. No percentage,
   no score, no "on track". Focus areas are counted "on record", not "open":
   nothing in the app closes a gap today, so an "open" count would only ever
   grow. A workout counts once, as the full record draws it, not once per
   step. Logged work counts every entry the full record lists, withdrawn work
   included. Earned milestones are not repeated here; AthleteAchievements,
   right above this on the Progress tab, shows them.

   Each line stands on its own read. One that did not answer says Unavailable
   and never 0, and does not take the others down with it. */

type Count<T> = { state: 'loaded'; value: T } | { state: 'failed' };

interface WorkTally {
  open: number;
  completed: number;
  closed: number;
}

interface Standing {
  athleteId: string;
  gaps: Count<number>;
  work: Count<WorkTally>;
  logged: Count<{ verified: number; pending: number; disputed: number }>;
}

/** The family's support tasks for this child, from the hub's messages read. */
export type SupportTasks =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; done: number; total: number };

/* The full record reads completions one assignment at a time. A child's
   history only grows, so this reads them a few at a time rather than all at
   once: the pool behind these routes is small, and a burst of forty is the
   way to make one of them fail. */
const COMPLETION_READS_AT_ONCE = 4;

async function readJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, { method: 'GET', credentials: 'include', signal });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

function rowsOf(payload: Record<string, unknown> | null): Array<Record<string, unknown>> | null {
  if (!payload || !Array.isArray(payload.items)) return null;
  const rows = payload.items as unknown[];
  return rows.every((row) => row !== null && typeof row === 'object') ? rows as Array<Record<string, unknown>> : null;
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...await Promise.all(items.slice(start, start + size).map(work)));
  }
  return results;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function ParentProgressSummary({
  athleteId,
  supportTasks,
}: {
  readonly athleteId: string;
  readonly supportTasks: SupportTasks;
}) {
  const headingId = useId();
  const [standing, setStanding] = useState<Standing | null>(null);

  /* Keyed by athlete, and every read for the child left behind is aborted, so
     a sibling's late answer neither shows nor overwrites; the keyed match at
     render keeps the previous child's counts off the screen while the new
     reads are open. */
  useEffect(() => {
    if (!athleteId) return;
    const controller = new AbortController();
    const { signal } = controller;
    const base = apiBase();
    const id = encodeURIComponent(athleteId);
    void (async () => {
      const guard = async <T,>(work: () => Promise<Count<T>>): Promise<Count<T>> => {
        try {
          return await work();
        } catch {
          return { state: 'failed' };
        }
      };

      const gapsRead = guard<number>(async () => {
        const rows = rowsOf(await readJson(`${base}/api/pilot/progression/gaps?athlete_id=${id}`, signal));
        return rows ? { state: 'loaded', value: rows.length } : { state: 'failed' };
      });

      // The assignment ids travel with the tally: the logged-work line asks
      // about exactly the assignments the full record asks about.
      const assignmentsRead = guard<WorkTally & { ids: string[] }>(async () => {
        const payload = await readJson(`${base}/api/pilot/progression/assignments?athlete_id=${id}`, signal);
        const rows = rowsOf(payload);
        if (!rows || !rows.every((row) => typeof row.assignment_id === 'string' && typeof row.status === 'string')) {
          return { state: 'failed' };
        }
        const typed = rows as Array<{ assignment_id: string; status: string }>;
        // A workout is one unit: open while any of its steps is open. Work
        // the coach withdrew is not counted as work.
        const sections = sectionAssignedWork(
          typed.filter((row) => row.status !== 'cancelled'),
          readIssuedWorkouts(payload?.workouts),
        );
        const statusesOf = (section: (typeof sections)[number]) => (section.kind === 'assignment'
          ? [section.assignment.status]
          : section.parts.flatMap((part) => (part.kind === 'step' ? [part.assignment.status] : [])));
        const tally: WorkTally = { open: 0, completed: 0, closed: 0 };
        for (const section of sections) {
          const statuses = statusesOf(section);
          if (statuses.some((status) => status === 'assigned' || status === 'in_progress')) tally.open += 1;
          else if (statuses.every((status) => status === 'completed')) tally.completed += 1;
          else tally.closed += 1;
        }
        return { state: 'loaded', value: { ...tally, ids: typed.map((row) => row.assignment_id) } };
      });

      const [gaps, assignments] = await Promise.all([gapsRead, assignmentsRead]);
      const work: Standing['work'] = assignments.state === 'loaded'
        ? { state: 'loaded', value: { open: assignments.value.open, completed: assignments.value.completed, closed: assignments.value.closed } }
        : { state: 'failed' };

      // Any one completions read failing makes the whole line Unavailable: a
      // partial tally would undercount and look complete.
      const logged = await guard<{ verified: number; pending: number; disputed: number }>(async () => {
        if (assignments.state !== 'loaded') return { state: 'failed' };
        const answers = await inBatches(assignments.value.ids, COMPLETION_READS_AT_ONCE, (assignmentId) =>
          readJson(`${base}/api/pilot/progression/completions?assignment_id=${encodeURIComponent(assignmentId)}`, signal));
        const tally = { verified: 0, pending: 0, disputed: 0 };
        for (const answer of answers) {
          const rows = rowsOf(answer);
          if (!rows) return { state: 'failed' };
          for (const row of rows) {
            const status = row.verification_status;
            if (status === 'verified' || status === 'pending' || status === 'disputed') tally[status] += 1;
            else return { state: 'failed' };
          }
        }
        return { state: 'loaded', value: tally };
      });

      if (signal.aborted) return;
      setStanding({ athleteId, gaps, work, logged });
    })();
    return () => controller.abort();
  }, [athleteId]);

  const shown = standing?.athleteId === athleteId ? standing : null;
  const line = <T,>(count: Count<T> | undefined, render: (value: T) => string): string => {
    if (!shown || !count) return 'Reading...';
    return count.state === 'loaded' ? render(count.value) : 'Unavailable';
  };

  return (
    <section aria-labelledby={headingId} className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
      <h3 id={headingId} className="t-label">Where things stand</h3>
      <dl className="space-y-[var(--s3)]">
        <div>
          <dt className="t-label">Focus areas the coach has recorded</dt>
          <dd className="t-body" data-testid="summary-gaps">
            {line(shown?.gaps, (count) => `${count} on record`)}
          </dd>
        </div>
        <div>
          <dt className="t-label">Drills and workouts (a workout counts once)</dt>
          <dd className="t-body" data-testid="summary-assignments">
            {line(shown?.work, ({ open, completed, closed }) =>
              `${open} open · ${completed} completed${closed > 0 ? ` · ${closed} closed, not completed` : ''}`)}
          </dd>
        </div>
        <div>
          <dt className="t-label">Logged work</dt>
          <dd className="t-body" data-testid="summary-logged">
            {line(shown?.logged, ({ verified, pending, disputed }) =>
              `${plural(verified + pending + disputed, 'entry', 'entries')}: ${verified} verified by a coach · ${pending} waiting for a coach · ${disputed} disputed`)}
          </dd>
        </div>
        <div>
          <dt className="t-label">Parent-support tasks, all set so far</dt>
          <dd className="t-body" data-testid="summary-support">
            {supportTasks.state === 'loading'
              ? 'Reading...'
              : supportTasks.state === 'failed'
                ? 'Unavailable'
                : supportTasks.total === 0
                  ? 'None set yet'
                  : `${supportTasks.done} of ${supportTasks.total} done`}
          </dd>
        </div>
      </dl>
      <Link href="/parent/progression-visibility" className="btn btn--ghost">
        Open the full progression record
      </Link>
    </section>
  );
}
