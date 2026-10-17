'use client';

import RoleSessionGate from '@/components/RoleSessionGate';
import ParentResourcesStaff from '@/components/ParentResourcesStaff';

// The gym's resources for families, staff side (PH-11b): coaches and
// organization admins add, edit, publish and archive them (PH-10 Q1 A, Q-E A).
// 'admin' is the client spelling of organization_admin (mapPilotRoleToClubRole
// in components/roleSession.ts folds the pair). Desk work, so the office.

export default function CoachParentResourcesPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)]">
          <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Coach</p>
            <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Parent Resources</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Guides, checklists, videos and policies for families: for every family or one program. Families see a resource once it is published.
            </p>
          </header>
          <ParentResourcesStaff />
        </div>
      </main>
    </RoleSessionGate>
  );
}
