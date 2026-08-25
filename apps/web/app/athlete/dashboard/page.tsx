import AthleteWorkspace from '@/components/AthleteWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// The real athlete workspace, restored. Commit d7899044 ("production
// lockdown") replaced this mount with AthleteDailyCheckIn -- a component
// with zero fetch calls, so check-ins, session notes, goals, the training
// hold banner, and the athlete's ONLY pain-reporting path all silently
// stopped existing while the workspace (and its live backends) kept
// receiving feature work in a component nothing mounted. The stub and its
// hardcoded drill taxonomy are deleted; the server-side role guard the stub
// era added is kept on top of the workspace's own gate.
export default async function AthleteDashboardPage() {
  await requirePageRole(['athlete']);

  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/dashboard" allowedRoles={['athlete']} showShellHeader={false}>
      {/* ge-locker: Golden Era Visual 003 scope. The only change on this route
          is this wrapper class -- the locker carcass, parchment clipboard and
          brass nameplate voice live in scoped CSS under .ge-locker in
          design-system/current/ppbf-golden-era.css, so AthleteWorkspace and
          every control inside it are untouched. */}
      <div className="ge-locker">
        <AthleteWorkspace />
      </div>
    </RoleStandaloneView>
  );
}
