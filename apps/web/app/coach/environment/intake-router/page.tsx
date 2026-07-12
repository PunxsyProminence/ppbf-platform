'use client';

import CoachWorkspace from '@/components/CoachWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function CoachIntakeRouterPage() {
  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/environment/intake-router">
      <CoachWorkspace />
    </RoleStandaloneView>
  );
}