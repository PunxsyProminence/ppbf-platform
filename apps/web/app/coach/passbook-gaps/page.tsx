'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import RefusalStamp from '@/components/RefusalStamp';
import { apiBase } from '@/lib/apiBase';

// PASSBOOK GAPS -- the first page over `/api/pilot/passbook/gaps`.
//
// The gap queue has been built, role-gated and tested since the passbook
// work landed (`src/server/pilot/passbook.ts`, `getCoachPassbookGapQueue`),
// and until now no page anywhere called it: SIGN_OFF_GUIDE.md records the
// passbook APIs as "no route found", which is why they had never been
// signed off. This is that route.
//
// What the endpoint actually returns decides what this page can honestly
// claim, so the framing here is narrower than "who has stopped coming":
//
//   * A row is an OPEN PROGRESSION GAP (`status not in
//     ('completed','deferred')`) joined to the athlete it was opened on. An
//     athlete who has stopped coming and has no gap on record is NOT in this
//     queue -- the SQL starts from `pilot.progression_gaps`, not from
//     attendance.
//   * The retention reading is attached to each gap, not the other way
//     round: `last_attended_on` is the athlete's most recent PRESENT or LATE
//     day, and `recorded_absences_since_last_visit` counts DISTINCT
//     attendance dates marked absent after it.
//   * The server orders the queue -- absences desc, then longest-unseen,
//     then severity, then oldest-opened. This page renders that order as
//     given and never re-sorts, because the order IS the triage.
//
// The empty state says all of that out loud rather than reading as "nobody
// is slipping".
//
// Scope: a coach principal is scoped by the API to their own assigned
// athletes and an organization admin sees the whole organization. That
// decision lives in the route (`isOrganizationAdminRole`), not here. The
// gate below is the courtesy copy of it; the API is the authority.

interface GapQueueItem {
  gap_id: string;
  gap_type: string;
  gap_description: string;
  severity: string;
  detected_from: string;
  status: string;
  created_at: string;
  athlete_id: string;
  athlete_name: string;
  coach_id: string;
  /** Most recent PRESENT or LATE day. Null means no recorded visit at all. */
  last_attended_on: string | null;
  /** Distinct attendance dates marked absent since that visit. */
  recorded_absences_since_last_visit: number;
}

// Severity rung -> the design system's status badge, the same mapping
// /coach/intelligence and /admin/escalations already use, so one severity
// does not read as two different colours on two staff surfaces (Law 2:
// saturated colour is safety/status only, which is what a severity rung is).
// Every rung carries a glyph as well, because Law 3 does not allow colour to
// be the only channel -- and the badge itself sets the label uppercase, so
// the mark reads glyph + colour + word.
//
// Both severity vocabularies in the tree are listed ('moderate' on
// escalations, 'medium' on compliance/progression rows) and neither is
// renamed on the way to the screen. Anything unrecognized falls to
// 'monitor' rather than losing its badge: an unbadged row is still a row the
// coach has to see.
const SEVERITY_BADGE: Record<string, { className: string; glyph: string }> = {
  critical: { className: 'badge--locked', glyph: '✕' },
  high: { className: 'badge--restricted', glyph: '▲' },
  moderate: { className: 'badge--monitor', glyph: '◉' },
  medium: { className: 'badge--monitor', glyph: '◉' },
  low: { className: 'badge--monitor', glyph: '○' },
};

function severityBadge(severity: string): { className: string; glyph: string } {
  return SEVERITY_BADGE[severity] ?? { className: 'badge--monitor', glyph: '◉' };
}

/** Stored enum values read as database columns; spaced, never renamed. */
function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Dates arrive as `date` or `timestamptz`; the day is the part a coach reads. */
function day(value: string): string {
  return value.slice(0, 10);
}

export default function CoachPassbookGapsPage() {
  const [items, setItems] = useState<GapQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refused, setRefused] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/passbook/gaps`, {
          credentials: 'include',
          signal: controller.signal,
        });
        // Law 7: a refusal is a stamp, not an error toast. The API refusing
        // this role is a governed answer -- it gets the mark, not the red
        // "something broke" banner a genuine failure gets.
        if (response.status === 401 || response.status === 403) {
          if (controller.signal.aborted) return;
          setRefused(true);
          setLoading(false);
          return;
        }
        if (!response.ok) throw new Error('Unable to read the gap queue.');
        const payload = (await response.json()) as { items?: GapQueueItem[] };
        if (controller.signal.aborted) return;
        setItems(payload.items ?? []);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to read the gap queue.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* Exactly one room, applied here and nowhere below: this page owns its
          <main>, so it supplies `room--floor` itself. Nothing inside adds a
          second `room--*` -- a nested room is two grounds fighting. */}
      <main className="room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Passbook Gaps</h1>
            <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-300)]">
              Every open gap in your athletes&rsquo; books, worst attendance first. Each row carries the
              day that athlete was last in the gym and how many recorded absent days have gone by since.
              The order is the triage &mdash; it is the server&rsquo;s, not this page&rsquo;s.
            </p>
            <p className="t-body mt-[var(--s3)] text-[length:var(--t-md)] text-[color:var(--bone-400)]">
              This is a queue of gaps, not of absences. An athlete with no gap opened on their book does
              not appear here however long they have been away.
            </p>
          </header>

          {refused ? (
            <RefusalStamp
              kind="wrong_door"
              detail="the gap queue is read by a coach or an organization admin"
              className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
            />
          ) : errorMessage ? (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage} Gaps may be open that are not shown here.</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Reading the books...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No open gaps in these books</div>
                <p className="empty-msg mx-auto">
                  Nothing is waiting in the queue. This reads gaps that were opened and left open &mdash;
                  it is not a check on who has stopped coming, and an empty queue is not proof that nobody has.
                </p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s4)]">
              {items.map((item) => {
                const badge = severityBadge(item.severity);
                return (
                  <li key={item.gap_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <span className="font-semibold text-[length:var(--t-lg)] text-[color:var(--bone-100)]">{item.athlete_name}</span>
                      <span className={`badge ${badge.className}`}>
                        <i aria-hidden="true">{badge.glyph}</i>
                        {item.severity}
                      </span>
                    </div>

                    {/* The retention reading leads, because it is what sorted
                        the row above the one under it. Both figures are
                        stated as what they are -- recorded days, not a claim
                        about the athlete's life. */}
                    <dl className="mt-[var(--s4)] flex flex-wrap gap-x-[var(--s6)] gap-y-[var(--s3)]">
                      <div>
                        <dt className="t-eyebrow">Last in the gym</dt>
                        <dd className="t-data t-data--lg mt-[var(--s1)]">
                          {item.last_attended_on ? day(item.last_attended_on) : 'No recorded visit'}
                        </dd>
                      </div>
                      <div>
                        <dt className="t-eyebrow">Recorded absent days since</dt>
                        <dd className="t-data t-data--lg mt-[var(--s1)]">{item.recorded_absences_since_last_visit}</dd>
                      </div>
                    </dl>

                    <p className="t-body mt-[var(--s4)] text-[length:var(--t-md)]">
                      <span className="font-semibold text-[color:var(--bone-100)]">{humanize(item.gap_type)}</span>
                      {' '}&mdash; {item.gap_description}
                    </p>

                    <p className="t-muted mt-[var(--s3)]">
                      Opened {day(item.created_at)} &middot; detected from {humanize(item.detected_from)}
                      {' '}&middot; status {humanize(item.status)}
                    </p>

                    {/* Acting on a gap happens on the surface that owns it --
                        the same rule /coach/intelligence follows. This page
                        reads books; it does not write in them. */}
                    <Link
                      href="/coach/progression-intelligence"
                      className="btn btn--ghost mt-[var(--s4)] min-h-[var(--tap)] text-[length:var(--t-md)]"
                    >
                      Assign a drill
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/operations" className="btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-md)]">
              Back to Operations
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
