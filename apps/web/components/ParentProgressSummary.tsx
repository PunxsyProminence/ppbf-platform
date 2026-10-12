'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/* WHERE THINGS STAND (WO-PH-09). A compact count of the selected child's
   recorded progression -- the focus areas the coach identified, the drills and
   workouts set, the work logged against them, and the family's own support
   tasks -- read from the same guardian-checked routes the full record at
   /parent/progression-visibility reads, and linking to it (Q1 = A).

   EVERY LINE IS A COUNT OF ROWS. No percentage, no score, no "on track":
   nothing here divides by a denominator the records do not define. Earned
   milestones are not repeated here; AthleteAchievements, right above this on
   the Progress tab, shows them.

   Each line stands on its own read. One that did not answer says Unavailable
   and never 0, and does not take the others down with it. */

type Count<T> = { state: 'loaded'; value: T } | { state: 'failed' };

interface Standing {
  athleteId: string;
  gaps: Count<number>;
  assignments: Count<{ open: number; completed: number; closed: number }>;
  logged: Count<{ verified: number; pending: number; disputed: number }>;
}

const OPEN_GAP = ['identified', 'assigned', 'in_progress'];

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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export default function ParentProgressSummary({
  athleteId,
  supportTasks,
}: {
  readonly athleteId: string;
  /** The child's parent-support tasks from the hub's messages read; null when that read has not answered. */
  readonly supportTasks: { done: number; total: number } | null;
}) {
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
        if (!rows) return { state: 'failed' };
        return { state: 'loaded', value: rows.filter((row) => OPEN_GAP.includes(String(row.status))).length };
      });

      // The assignment ids travel with the count: the logged-work line asks
      // about exactly the assignments counted here.
      const assignmentsRead = guard<{ open: number; completed: number; closed: number; ids: string[] }>(async () => {
        const rows = rowsOf(await readJson(`${base}/api/pilot/progression/assignments?athlete_id=${id}`, signal));
        if (!rows || !rows.every((row) => typeof row.assignment_id === 'string')) return { state: 'failed' };
        // Withdrawn by the coach: not counted, and no logged work is asked of it.
        const kept = rows.filter((row) => row.status !== 'cancelled');
        return {
          state: 'loaded',
          value: {
            open: kept.filter((row) => row.status === 'assigned' || row.status === 'in_progress').length,
            completed: kept.filter((row) => row.status === 'completed').length,
            closed: kept.filter((row) => row.status === 'incomplete').length,
            ids: kept.map((row) => row.assignment_id as string),
          },
        };
      });

      const [gaps, assignmentsWithIds] = await Promise.all([gapsRead, assignmentsRead]);
      const assignments: Standing['assignments'] = assignmentsWithIds.state === 'loaded'
        ? { state: 'loaded', value: { open: assignmentsWithIds.value.open, completed: assignmentsWithIds.value.completed, closed: assignmentsWithIds.value.closed } }
        : { state: 'failed' };

      // One completions read per assignment, as the full record does. Any one
      // of them failing makes the whole line Unavailable: a partial tally
      // would undercount and look complete.
      const logged = await guard<{ verified: number; pending: number; disputed: number }>(async () => {
        if (assignmentsWithIds.state !== 'loaded') return { state: 'failed' };
        const answers = await Promise.all(assignmentsWithIds.value.ids.map((assignmentId) =>
          readJson(`${base}/api/pilot/progression/completions?assignment_id=${encodeURIComponent(assignmentId)}`, signal)));
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
      setStanding({ athleteId, gaps, assignments, logged });
    })();
    return () => controller.abort();
  }, [athleteId]);

  const shown = standing?.athleteId === athleteId ? standing : null;
  const line = <T,>(count: Count<T> | undefined, render: (value: T) => string): string => {
    if (!shown || !count) return 'Reading...';
    return count.state === 'loaded' ? render(count.value) : 'Unavailable';
  };

  return (
    <section aria-labelledby="parent-progress-summary" className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
      <h4 id="parent-progress-summary" className="t-label">Where things stand</h4>
      <dl className="space-y-[var(--s3)]">
        <div>
          <dt className="t-label">Focus areas the coach identified</dt>
          <dd className="t-body" data-testid="summary-gaps">
            {line(shown?.gaps, (open) => `${open} open`)}
          </dd>
        </div>
        <div>
          <dt className="t-label">Drills and workouts</dt>
          <dd className="t-body" data-testid="summary-assignments">
            {line(shown?.assignments, ({ open, completed, closed }) =>
              `${open} working on now · ${completed} completed · ${closed} closed, not completed`)}
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
          <dt className="t-label">Parent-support tasks</dt>
          <dd className="t-body" data-testid="summary-support">
            {supportTasks === null ? 'Unavailable' : `${supportTasks.done} of ${supportTasks.total} done`}
          </dd>
        </div>
      </dl>
      <Link href="/parent/progression-visibility" className="btn btn--ghost">
        Open the full progression record
      </Link>
    </section>
  );
}
