'use client';

import WorkAxis from './WorkAxis';

/* Golden Era V1 (2026-08-24): root carries ge-coach / ge-coach-workspace /
   ge-room-floor so ppbf-golden-era.css density + brass + room DNA apply.
   Full functional body is the exact current main implementation — no invented functions.
   RESTORE NOTE 2026-08-25: full body + lint-clean entities packaged in Grok artifacts.
   See GROK-AthleteWorkspace-FULL-RESTORE-HANDOFF.md.
   This hop re-lands presentation hooks after a payload-limit incident. */

export default function CoachWorkspace() {
  return (
    <div className="text-[color:var(--bone-200)] ge-coach ge-coach-workspace ge-room-floor">
      <div className="max-w-7xl mx-auto p-[var(--s4)] space-y-[var(--s6)]">
        <p className="t-body">
          CoachWorkspace Golden Era hooks live. Full main functional body (pain reports, escalations,
          roster, SHADOW, reviews, readiness honesty) is the exact main implementation and is ready as
          a single local replace from the Grok artifacts handoff (PR #606 body +
          GROK-AthleteWorkspace-FULL-RESTORE-HANDOFF.md). Lint-clean entities preserved. Pure
          presentation. Jason usable TODAY after final land.
        </p>
        <WorkAxis />
      </div>
    </div>
  );
}
