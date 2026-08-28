'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import DevelopmentBlockPlanView, { type PlanBlock } from '@/components/DevelopmentBlockPlanView';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

/*
 * An athlete reading the plan their coach wrote for them.
 *
 * Owner decision 2026-08-28: everything, verbatim -- the block, the coach's
 * stated emphasis, and every objective including the nutrition and body
 * composition domain, exactly as written. No softened second version of what
 * a coach said about a child exists, because a second version would be a
 * second truth.
 *
 * READ-ONLY, and the route behind it has no write verb to call. Nothing on
 * this page marks anything complete: an athlete deciding their own block was
 * completed is the coaching judgment this whole table refuses to compute.
 */
export default function AthleteDevelopmentBlocksPage() {
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  /* Four states, not two. A failed read rendered as an empty list would tell
     an athlete their coach has not planned anything for them, which this read
     did not establish. */
  const [state, setState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        // No athlete_id: the route takes the subject from the session, and
        // ignores the parameter entirely for an athlete caller.
        const response = await fetch(`${apiBase()}/api/pilot/athlete/development-blocks`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('blocks');
        const payload = (await response.json()) as { blocks?: PlanBlock[] };
        setBlocks(payload.blocks ?? []);
        setState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setBlocks([]);
        setState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <RoleStandaloneView
      roleLabel="My Development Plan"
      routeLabel="/athlete/development-blocks"
      allowedRoles={['athlete']}
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Athlete Development</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Your Plan</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            What your coach is working on with you over the next several weeks, in their words.
            Your guardian can see this too. If something here does not match what you understood,
            that is worth saying to your coach — this is the plan, not a score, and nothing on this
            page grades you.
          </p>
          <Link href="/athlete/dashboard" className="btn btn--ghost mt-[var(--s4)]">
            Back to your workspace
          </Link>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <h2 className="t-eyebrow">Blocks</h2>
          <DevelopmentBlockPlanView
            blocks={blocks}
            state={state}
            subjectLabel="your plan"
            emptyMessage="Your coach has not written a development block for you yet. That is normal — blocks are written when a coach is planning a stretch of weeks, not for every session."
          />
        </section>
      </div>
    </RoleStandaloneView>
  );
}
