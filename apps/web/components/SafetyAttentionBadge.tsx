'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import ChromeLink from './ChromeLink';
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
      <ChromeLink
        href="/admin/escalations"
        className={CONTROL_QUIET}
        aria-label="Open safety escalations. The count of unacknowledged escalations could not be read."
        title="Safety escalations could not be read. This is not a statement that there are none."
      >
        Safety: unread
      </ChromeLink>
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
  const critical = criticalCount > 0;
  const rung = critical ? 'badge--locked' : 'badge--restricted';
  const glyph = critical ? '✕' : '▲';
  /* The worst severity as one word, taken off the SAME predicate that chose
     the rung and the glyph on the two lines above. Deriving it a second time
     is how a badge ends up wearing the critical rung while its own summary
     says HIGH, and the two would then be describing one set of escalations at
     two different severities -- the thing the paragraph above exists to
     prevent between this summary and /admin/escalations. */
  const worst = critical ? 'CRITICAL' : 'HIGH';
  const label = critical
    ? `${criticalCount} critical${highCount > 0 ? `, ${highCount} high` : ''}`
    : `${highCount} high`;

  /* NO FIXED WIDTH CAN BE CLAIMED FOR THIS BADGE, at either density or any
     breakpoint. Both summaries below are composed from counts fetched at
     runtime -- setCriticalCount / setHighCount above, off the rows
     /api/pilot/escalations returned -- so the string grows with the live
     escalation set: "1 critical" and "3 critical, 11 high" are the same code
     path, and the compact form's number is as wide as the total happens to
     be. The unavailable branch further up renders a different string again
     ("Safety: unread"), and a confirmed-clear read renders no element at all.
     So a layout argument that rests on one particular rendering of this label
     is describing one sample of the escalation data on one day, not a
     property of this component, and it will stop being true the next time a
     coach acknowledges something. */

  return (
    <ChromeLink
      href="/admin/escalations"
      className="inline-flex min-h-[var(--tap)] items-center no-underline"
      aria-label={`Safety escalations needing acknowledgement: ${label}. Open the escalation records.`}
    >
      <span className={`badge ${rung}`}>
        <i>{glyph}</i>
        {/* TWO DENSITIES OF THE SAME SUMMARY, and the narrow one is what lets
            this badge stay on the phone bar rather than step off it.

            Below 640px: the glyph, the word SAFETY, the REAL total and the
            worst REAL severity -- "✕ SAFETY 2 · CRITICAL". From 640px up: the
            breakdown this badge has always carried -- "Safety 1 critical,
            1 high". The only thing the narrow form drops is the SPLIT between
            the two rungs. It cannot understate either half of what is waiting:
            the number is criticalCount + highCount, and the word is the worst
            severity actually present, off the same predicate as the rung.

            WHAT IS NOT DONE HERE, because the order that opened this slice
            names each one: the badge is not hidden on the phone, not reduced
            to a bare number, and its target does not shrink -- the tap area is
            the Link's own min-h-[var(--tap)] and neither variant touches it.

            THE FULL BREAKDOWN SURVIVES AT EVERY WIDTH. aria-label on the ChromeLink
            above supplies that link's accessible name outright, and visible
            text does not contribute to a name that is given that way, so a
            screen reader hears "1 critical, 1 high" on the 412px phone this
            slice was measured on, while the eye reads "✕ SAFETY 2 · CRITICAL".
            That sentence does not move with the breakpoint, because it was
            never rendered from the visible text in the first place.

            `hidden` rather than a clip or an sr-only, which is the same call
            GlobalRoleHeader.tsx:231 writes down for the controls that step off
            that bar: display:none takes a node out of the accessibility tree
            as well as the picture, so exactly ONE of these two spans exists
            for assistive technology at any given width and nothing announces
            the count twice.

            The compact string is written in the case it renders in. `.badge`
            uppercases its whole content already (design-system/legacy/
            ppbf-leather-brass.css:807, reached from app/globals.css:42 via
            ppbf.css -> current/ppbf-theme.css -> ppbf-golden-era.css:60), so
            the two agree today, and the summary still reads as the design
            lane specified it if that transform ever moves. */}
        <span className="sm:hidden">{`SAFETY ${total} · ${worst}`}</span>
        <span className="hidden sm:inline">Safety {label}</span>
      </span>
    </ChromeLink>
  );
}
