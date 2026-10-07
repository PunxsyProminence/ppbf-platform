'use client';

import { MOMENT_SLOTS } from '@/src/server/pilot/calibration/ontology';
import { formatMediaOffset } from '@/src/lib/clipTime';

/**
 * WHERE ONE ANNOTATOR'S BODY-POINT MARKING STANDS, event by event.
 *
 * This is a reading of the server's answer and nothing more. The counts, the
 * expected point list and the "still to mark" list all come from
 * GET /api/pilot/calibration/body-points, which reads them from the same
 * tables the submission trigger checks (bodyPoints.ts listMissingBodyData).
 * Nothing here recomputes completeness from the moments it is handed: a page
 * that did its own sum would agree with the database right up until the day
 * it did not, and that day the coach would press Submit and be refused.
 *
 * Marking itself (placing a point, choosing a lead side) lives in the
 * canvas and the moment controls, not here. This component only says what is
 * done and what is not.
 */

export interface ProgressEvent {
  event_id: string;
  event_class: string;
  actor_track: string;
  start_ms: number;
  end_ms: number;
  contact_ms: number | null;
}

export interface ProgressMoment {
  body_moment_id: string;
  event_id: string;
  moment_slot: string;
  moment_kind: string;
  observation_ms: number;
  lead_side: string | null;
  guard_type: string | null;
  points: readonly { point_code: string; state: string }[];
}

export interface ProgressStanceLabel {
  event_id: string;
  stance_type: string;
}

export interface BodyPointProgressProps {
  events: readonly ProgressEvent[];
  /** The set's own point list, in marking order; null means the set's
   * version holds no body points and nothing should be shown. */
  expectedPoints: readonly string[] | null;
  moments: readonly ProgressMoment[];
  stanceLabels: readonly ProgressStanceLabel[];
  /** The server's own list of what submission would refuse on, verbatim. */
  missing: readonly string[];
}

/** Vocabulary tokens are stored lower_snake; this is display only. */
function label(token: string): string {
  return token.replace(/_/g, ' ');
}

/** "punch at 0:12.400", the way the rest of the page names an event. */
export function describeEventForProgress(event: ProgressEvent): string {
  return `${label(event.event_class)} at ${formatMediaOffset(event.start_ms)}`;
}

/**
 * The server names an event by its id ("<event_id>: middle moment"). An id
 * means nothing to a coach, so the leading id is swapped for the event's
 * position in the clip when that event is on the page. The server's own words
 * after the colon are kept exactly: they are what Submit will say.
 */
export function readableMissingItem(item: string, events: readonly ProgressEvent[]): string {
  const colon = item.indexOf(': ');
  if (colon < 0) return item;
  const eventId = item.slice(0, colon);
  const event = events.find((row) => row.event_id === eventId);
  if (!event) return item;
  return `${describeEventForProgress(event)}: ${item.slice(colon + 2)}`;
}

export default function BodyPointProgress({
  events,
  expectedPoints,
  moments,
  stanceLabels,
  missing,
}: BodyPointProgressProps) {
  if (expectedPoints === null) return null;

  const expected = expectedPoints.length;
  const momentsByEvent = new Map<string, ProgressMoment[]>();
  for (const moment of moments) {
    const list = momentsByEvent.get(moment.event_id) ?? [];
    list.push(moment);
    momentsByEvent.set(moment.event_id, list);
  }
  const stanceByEvent = new Map(stanceLabels.map((row) => [row.event_id, row.stance_type]));

  const momentsNeeded = events.length * MOMENT_SLOTS.length;
  const pointsNeeded = momentsNeeded * expected;
  const pointsMarked = moments.reduce((sum, moment) => sum + moment.points.length, 0);

  return (
    <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]" data-testid="body-point-progress">
      <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
        <h2 className="t-eyebrow">Body points</h2>
        <span className={missing.length === 0 ? 'badge badge--cleared' : 'badge badge--monitor'}>
          {missing.length === 0 ? 'Complete' : `${missing.length} still to mark`}
        </span>
      </div>

      <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
        Every punch and defence is marked at three moments (start, middle, end). At each moment
        all {expected} points are placed or marked not visible, with the lead side and the
        guard; each event takes one stance type.
      </p>

      <p className="t-data mt-[var(--s3)]" data-testid="body-point-totals">
        Points {pointsMarked} of {pointsNeeded} · moments opened {moments.length} of {momentsNeeded}
        {' '}· stance types {stanceLabels.length} of {events.length}
      </p>

      {events.length === 0 ? (
        <p className="t-muted mt-[var(--s3)]">
          No events recorded yet. Body points are marked on each punch or defence after it is
          recorded.
        </p>
      ) : (
        <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
          {events.map((event) => {
            const eventMoments = momentsByEvent.get(event.event_id) ?? [];
            const stance = stanceByEvent.get(event.event_id);
            return (
              <li
                key={event.event_id}
                data-testid="body-point-event"
                className="rounded-[var(--r-sm)] border border-[color:rgba(255,255,255,.12)] p-[var(--s3)]"
              >
                <p className="t-data">
                  {describeEventForProgress(event)} to {formatMediaOffset(event.end_ms)} · {event.actor_track}
                </p>
                <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                  {MOMENT_SLOTS.map((slot) => {
                    const moment = eventMoments.find((row) => row.moment_slot === slot);
                    if (!moment) {
                      return (
                        <li key={slot} className="t-body">
                          {label(slot)} · not opened
                        </li>
                      );
                    }
                    return (
                      <li key={slot} className="t-body">
                        {label(slot)} ({label(moment.moment_kind)} at {formatMediaOffset(moment.observation_ms)}) ·{' '}
                        {moment.points.length} of {expected} points ·{' '}
                        lead side {moment.lead_side ? label(moment.lead_side) : 'not set'} ·{' '}
                        guard {moment.guard_type ? label(moment.guard_type) : 'not set'}
                      </li>
                    );
                  })}
                  <li className="t-body">
                    stance type · {stance ? label(stance) : 'not set'}
                  </li>
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {missing.length > 0 ? (
        <div className="mt-[var(--s3)]">
          <p className="t-label">Still to mark before this set can be submitted</p>
          <ul className="mt-[var(--s2)] space-y-[var(--s1)]" data-testid="body-point-missing">
            {missing.map((item) => (
              <li key={item} className="t-body">{readableMissingItem(item, events)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
