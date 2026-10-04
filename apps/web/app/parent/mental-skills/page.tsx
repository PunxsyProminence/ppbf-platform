'use client';

import Link from 'next/link';

import MentalSkillsSubjectPanel, { entriesFrom, getJson, type SubjectLoaders } from '@/components/MentalSkillsSubjectPanel';
import type { MentalSkillsData } from '@/components/MentalSkillsView';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { VISIBILITY_LINES } from '@/src/lib/mentalSkills/content';

/*
 * A guardian reading one linked child's mental skills (owner decision
 * 2026-10-04: minors may use the track, and a linked guardian reads the log).
 * Read only. The child list is the guardian's own links; every read names the
 * child and the route's per-athlete gate refuses any child not linked.
 */

interface FamilyBlock {
  status?: string;
  objectives?: Array<{ objective_id: string; domain: string; objective: string; status: string }>;
}

const q = (athleteId: string) => `athlete_id=${encodeURIComponent(athleteId)}`;

const LOADERS: SubjectLoaders = {
  rosterPath: '/api/pilot/athletes/list',
  entries: async (athleteId) =>
    entriesFrom(await getJson<Partial<MentalSkillsData>>(`/api/pilot/athlete/mental-skills?${q(athleteId)}`)),
  goals: async (athleteId) => {
    const payload = await getJson<{ blocks?: FamilyBlock[] }>(`/api/pilot/athlete/development-blocks?${q(athleteId)}`);
    if (!Array.isArray(payload.blocks)) throw new Error('shape');
    // Current goals only, as on the athlete's own page.
    return payload.blocks
      .filter((block) => block.status === 'active')
      .flatMap((block) => (block.objectives ?? [])
        .filter((o) => o.domain === 'mental' && o.status === 'active')
        .map((o) => ({ objective_id: o.objective_id, objective: o.objective })));
  },
};

export default function ParentMentalSkillsPage() {
  return (
    <RoleStandaloneView
      roleLabel="Mental Skills"
      routeLabel="/parent/mental-skills"
      allowedRoles={['parent']}
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Parent Hub</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Mental Skills</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{VISIBILITY_LINES.guardian}</p>
          <Link href="/parent/dashboard" className="btn btn--ghost mt-[var(--s4)]">
            Back to the Parent Hub
          </Link>
        </header>
        <MentalSkillsSubjectPanel
          loaders={LOADERS}
          pickerLabel="Which child"
          noneText="No child is linked to this account yet. The gym's administrator sets that link up."
          rosterErrorText="Your linked children could not be loaded. This is not a statement that you have none. Reload and try again."
        />
      </div>
    </RoleStandaloneView>
  );
}
