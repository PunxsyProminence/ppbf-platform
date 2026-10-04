'use client';

import MentalSkillsSubjectPanel, { entriesFrom, getJson, type SubjectLoaders } from '@/components/MentalSkillsSubjectPanel';
import type { MentalGoal, MentalSkillsData } from '@/components/MentalSkillsView';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { VISIBILITY_LINES } from '@/src/lib/mentalSkills/content';

/*
 * A coach (or org admin) reading one athlete's mental skills. Read only: staff
 * never write an athlete's self-talk or imagery log. The picker is
 * /api/pilot/coach/athletes, the same set the read route's gate admits (coach
 * of record or covering coach; the admin's own gym), so it offers nobody whose
 * read would be refused. The goals are the coach's own mental-domain
 * objectives in active blocks, read through the coach development-block routes.
 */

const q = (athleteId: string) => `athlete_id=${encodeURIComponent(athleteId)}`;

interface CoachBlock {
  block_id: string;
  status: string;
}

const LOADERS: SubjectLoaders = {
  rosterPath: '/api/pilot/coach/athletes',
  entries: async (athleteId) =>
    entriesFrom(await getJson<Partial<MentalSkillsData>>(`/api/pilot/coach/mental-skills?${q(athleteId)}`)),
  goals: async (athleteId) => {
    const payload = await getJson<{ blocks?: CoachBlock[] }>(`/api/pilot/coach/development-blocks?${q(athleteId)}`);
    if (!Array.isArray(payload.blocks)) throw new Error('shape');
    const goals: MentalGoal[] = [];
    for (const block of payload.blocks.filter((b) => b.status === 'active')) {
      const listed = await getJson<{ objectives?: Array<{ objective_id: string; domain: string; objective: string; status: string }> }>(
        `/api/pilot/coach/development-block-objectives?block_id=${encodeURIComponent(block.block_id)}`,
      );
      if (!Array.isArray(listed.objectives)) throw new Error('shape');
      for (const o of listed.objectives) {
        if (o.domain === 'mental' && o.status === 'active') goals.push({ objective_id: o.objective_id, objective: o.objective });
      }
    }
    return goals;
  },
};

export default function CoachMentalSkillsPage() {
  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/mental-skills"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Athlete Development</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Mental Skills</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{VISIBILITY_LINES.coach}</p>
        </header>
        <MentalSkillsSubjectPanel
          loaders={LOADERS}
          pickerLabel="Which athlete"
          noneText="No athletes to show right now."
          rosterErrorText="Your athletes could not be loaded. Reload and try again."
        />
      </div>
    </RoleStandaloneView>
  );
}
