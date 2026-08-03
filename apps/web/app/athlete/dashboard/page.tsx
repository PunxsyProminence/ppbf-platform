'use client';

import AthleteWorkspace from '@/components/AthleteWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function AthleteDashboardPage() {
  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/dashboard" allowedRoles={['athlete']} showShellHeader={false} room="floor">
      <AthleteWorkspace />
    </RoleStandaloneView>
  );
}