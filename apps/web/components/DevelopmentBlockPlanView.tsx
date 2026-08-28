'use client';

import { formatGymDay } from '@/src/lib/gymTime';

import {
  STATUS_BADGE,
  domainLabel,
  type DevelopmentBlockStatusValue,
} from './developmentBlockDomains';

/*
 * THE PLAN, AS THE FAMILY READS IT.
 *
 * One component, rendered by both /athlete/development-blocks and
 * /parent/development-blocks, because the owner decision of 2026-08-28 makes
 * them the same view: an athlete sees their coach's plan verbatim, and a
 * guardian reads exactly what their child reads and no more. Two components
 * would be two chances for those to drift apart, and the drift would be
 * invisible -- a parent and child comparing screens in the same room is
 * precisely who would find it.
 *
 * WHAT THIS DELIBERATELY DOES NOT RENDER, and each omission is the point:
 *
 *   - no count of completed objectives, no proportion, no progress bar. Shown
 *     to a child, "3 of 5 complete" is a score about that child produced by
 *     arithmetic rather than by a coach. Whether a block went well is a human
 *     judgment and the count is not it.
 *   - no periodization label, no workload figure, no readiness, no taper. The
 *     platform does not compute those about a minor anywhere, and a family
 *     surface is the last place to start.
 *   - no control of any kind. Reading is not writing: an athlete marking
 *     their own block 'completed' is the coach judgment this table refuses to
 *     compute, and a guardian editing a coach's plan is not in the gym's
 *     authority model. The route this reads has no write verb at all.
 *   - no account id. `created_by_account_id` is an identifier, not a name, and
 *     printing a raw staff identifier to a family is a leak dressed as
 *     attribution. The route does not send it at all, so this component
 *     cannot render it even by accident.
 *
 * WHAT IT DOES NAME, since the owner decision of 2026-08-28: the coach, by
 * name. Both screens tell a family that a plan reading wrong "is a
 * conversation with the coach", and naming no coach made that sentence a
 * dead end. `created_by_name` arrives already resolved and already floored at
 * "Your coach" -- there is no id fallback on this path, unlike the coach's own
 * surface where an ugly true string beats a blank byline.
 */

export interface PlanObjective {
  objective_id: string;
  domain: string;
  objective: string;
  status: DevelopmentBlockStatusValue;
}

export interface PlanBlock {
  block_id: string;
  title: string;
  training_emphasis: string;
  starts_on: string;
  ends_on: string;
  status: DevelopmentBlockStatusValue;
  /** Already a name, never an id. See the header. */
  created_by_name?: string;
  objectives: PlanObjective[];
}

export interface DevelopmentBlockPlanViewProps {
  readonly blocks: readonly PlanBlock[];
  readonly state: 'idle' | 'loading' | 'loaded' | 'unavailable';
  /** Whose plan this is, in the second person or the child's name. */
  readonly subjectLabel: string;
  /** Shown when the read succeeded and there is genuinely nothing. */
  readonly emptyMessage: string;
}

export default function DevelopmentBlockPlanView({
  blocks,
  state,
  subjectLabel,
  emptyMessage,
}: DevelopmentBlockPlanViewProps) {
  if (state === 'idle') return null;

  if (state === 'loading') {
    return <p className="t-muted m-0">Loading {subjectLabel}...</p>;
  }

  /* A FAILED READ IS NEVER RENDERED AS "THERE IS NO PLAN". The two are
     different facts, and the wrong one told to a family is worse here than on
     a staff screen: a parent who reads "no plan" when the read merely failed
     concludes the gym is not planning for their child. */
  if (state === 'unavailable') {
    return (
      <div className="rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
        <p className="m-0 text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">
          This could not be loaded just now. That is not the same as there being no plan —
          please reload before concluding anything from an empty screen.
        </p>
      </div>
    );
  }

  if (blocks.length === 0) {
    return <p className="t-body text-[color:var(--bone-300)]">{emptyMessage}</p>;
  }

  return (
    <ul className="space-y-[var(--s4)] list-none p-0 m-0">
      {blocks.map((block) => (
        <li
          key={block.block_id}
          className="mat-paper rounded-[var(--r-md)] border-l-4 border-[color:var(--brass-500)] p-[var(--s4)] space-y-[var(--s3)]"
        >
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <h3 className="t-command m-0 text-[length:var(--t-md)]">{block.title}</h3>
            <span className={`badge ${STATUS_BADGE[block.status].className}`}>
              {STATUS_BADGE[block.status].label}
            </span>
          </div>

          <p className="t-muted m-0">
            {formatGymDay(block.starts_on) ?? block.starts_on}
            {' to '}
            {formatGymDay(block.ends_on) ?? block.ends_on}
          </p>

          {/* Who to go and talk to. Rendered only when the route actually sent
              a name -- an absent one prints nothing rather than a placeholder
              byline, because "Written by" over an empty space reads as a
              missing person rather than an unresolved lookup. */}
          {block.created_by_name && (
            <p className="t-muted m-0">Written by {block.created_by_name}</p>
          )}

          {/* The coach's own words, verbatim. Not trimmed, not reflowed, not
              summarised, and not softened for the reader -- owner decision
              2026-08-28. whitespace-pre-wrap is doing real work: a coach who
              wrote line breaks meant them. */}
          <p className="t-body m-0 whitespace-pre-wrap">{block.training_emphasis}</p>

          {block.objectives.length > 0 && (
            <ul className="space-y-[var(--s3)] list-none p-0 m-0 border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s3)]">
              {block.objectives.map((objective) => (
                <li key={objective.objective_id} className="space-y-[var(--s2)]">
                  <div className="flex flex-wrap items-center gap-[var(--s3)]">
                    <span className="t-label">{domainLabel(objective.domain)}</span>
                    <span className={`badge ${STATUS_BADGE[objective.status].className}`}>
                      {STATUS_BADGE[objective.status].label}
                    </span>
                  </div>
                  <p className="t-body m-0 whitespace-pre-wrap">{objective.objective}</p>
                </li>
              ))}
            </ul>
          )}

          {/* A block with no objectives is an ordinary state, not a fault, and
              it says so rather than rendering an empty rule. */}
          {block.objectives.length === 0 && (
            <p className="t-muted m-0">
              No per-area objectives written for this block.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
