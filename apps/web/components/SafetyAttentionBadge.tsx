'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { CONTROL_QUIET } from './sessionBarControls';

/**
 * An unacknowledged high or critical safety escalation, on every screen.
 *
 * WHAT WAS WRONG. The escalation model itself is sound and is not changed
 * here: pilot.safety_escalations is the record, /api/pilot/escalations scopes
 * a coach to their assigned and actively covered athletes, excludes
 * athlete_voice from coach reads, lets a coach acknowledge and only an admin
 * resolve, and already returns rows critical-first. What it is NOT is a
 * notification. The route's own header says so in as many words -- "this
 * platform sends no email, ever, so a coach or admin has to come check this
 * page/route". A red flag about a child therefore waited until somebody chose
 * to open the right surface.
 *
 * This is the smallest thing that fixes that without inventing a transport.
 * It reads the SAME route, on the one component mounted on every route
 * (GlobalRoleHeader, from app/layout.tsx), and puts the count where a coach
 * cannot get through a session without passing it. No second queue, no second
 * source of truth, no new table, no new endpoint.
 *
 * A COUNT AND NOTHING ELSE. This bar renders on every surface, including
 * whatever screen happens to be facing the room. So the badge carries a
 * number and a severity word -- never an athlete's name, never the reason,
 * never the source. Those live on the record, behind the same gate they
 * always did, one click away. A safeguarding disclosure must not be readable
 * over a coach's shoulder because the chassis decided to be helpful.
 *
 * SILENCE MEANS NONE, AND ONLY WHEN THAT WAS ESTABLISHED. Nothing renders on
 * a confirmed-clear read, because a permanent "0 open" chip on every screen
 * is noise that trains people to stop seeing this row. But an unread state is
 * NOT clear, so a failed read renders its own marker rather than disappearing
 * into the same silence -- an absent badge would otherwise mean both "nobody
 * is flagged" and "nobody could find out", which is the false-reassurance
 * failure the rest of this codebase is built to refuse.
 */

/** Mirrors SafetyEscalationRow, trimmed to what a count needs. */
interface EscalationSummaryRow {
  escalation_id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
}

/**
 * Who /api/pilot/escalations serves. Restated from that route's own gate
 * rather than guessed: offering this control to a role the route refuses
 * would put a permanently broken badge on their bar.
 */
const ESCALATION_ROLES: ReadonlySet<string> = new Set([
  'coach',
  'organization_admin',
  'admin',
]);

/**
 * How often the count is re-read while a person sits on one surface.
 *
 * Two minutes is a deliberate middle: short enough that an escalation filed
 * while a coach is mid-session reaches them during that session, long enough
 * that this costs one small read per person per two minutes rather than
 * behaving like a polling loop. It is not a substitute for a real transport
 * (push, email, SMS), which is a separate decision with its own privacy and
 * content rules -- see the note in docs where that is recorded.
 */
const REFRESH_INTERVAL_MS = 120_000;

type ReadState = 'loading' | 'loaded' | 'unavailable';

export default function SafetyAttentionBadge({ role }: { readonly role: string | null }) {
  const [criticalCount, setCriticalCount] = useState(0);
  const [highCount, setHighCount] = useState(0);
  const [readState, setReadState] = useState<ReadState>('loading');

  const serves = role !== null && ESCALATION_ROLES.has(role);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/escalations?status=open`, {
        method: 'GET',
        credentials: 'include',
        signal,
      });
      if (!response.ok) {
        throw new Error('escalations');
      }
      const payload = (await response.json()) as { escalations?: EscalationSummaryRow[] };
      const rows = payload.escalations ?? [];
      /* Counted from `severity` on the rows the server returned, not from
         their number: ?status=open already excludes anything acknowledged or
         resolved, and the row's own severity is the one the ladder recorded.
         Nothing is re-derived here -- a second opinion about how serious a
         safeguarding record is would be a second answer to that question. */
      setCriticalCount(rows.filter((row) => row.severity === 'critical').length);
      setHighCount(rows.filter((row) => row.severity === 'high').length);
      setReadState('loaded');
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        return;
      }
      // Zero is a claim about the children this person is responsible for.
      // A failed request has not earned it.
      setCriticalCount(0);
      setHighCount(0);
      setReadState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (!serves) {
      return;
    }
    const controller = new AbortController();
    /* The first read has to happen on mount: this badge's entire job is to
       fetch state from a server on arrival. Same suppression, same reason, as
       the other feed loaders in this codebase (see CoachWorkspace's own). */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    const timer = setInterval(() => {
      void load(controller.signal);
    }, REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [serves, load]);

  // Every other role: this control does not exist. Not an empty box, not a
  // disabled one -- the route would refuse them and a badge that can only
  // ever fail is worse than no badge.
  if (!serves) {
    return null;
  }

  if (readState === 'loading') {
    return null;
  }

  if (readState === 'unavailable') {
    return (
      <Link
        href="/admin/escalations"
        className={CONTROL_QUIET}
        aria-label="Open safety escalations. The count of unacknowledged escalations could not be read."
        title="Safety escalations could not be read. This is not a statement that there are none."
      >
        Safety: unread
      </Link>
    );
  }

  const total = criticalCount + highCount;
  if (total === 0) {
    return null;
  }

  /* Critical anywhere in the set drives the rung, because the badge stands for
     the worst thing waiting -- a set containing one critical is a critical
     situation regardless of how many highs sit beside it. The vocabulary is
     the design system's own ladder and matches what /admin/escalations puts on
     the individual rows, so the summary and the record cannot describe the
     same escalation at two different severities. */
  const rung = criticalCount > 0 ? 'badge--locked' : 'badge--restricted';
  const glyph = criticalCount > 0 ? '✕' : '▲';
  const label = criticalCount > 0
    ? `${criticalCount} critical${highCount > 0 ? `, ${highCount} high` : ''}`
    : `${highCount} high`;

  return (
    <Link
      href="/admin/escalations"
      className="inline-flex min-h-[var(--tap)] items-center no-underline"
      aria-label={`Safety escalations needing acknowledgement: ${label}. Open the escalation records.`}
    >
      <span className={`badge ${rung}`}>
        <i>{glyph}</i>
        Safety {label}
      </span>
    </Link>
  );
}
