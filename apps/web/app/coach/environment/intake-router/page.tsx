'use client';

import CoachWorkspace from '@/components/CoachWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function CoachIntakeRouterPage() {
  return (
    /* The coach's home (getPilotRoleDestination). It no longer prints its own
       web address under its title: showRouteLabel={false} (#1482 item 6). */
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/environment/intake-router"
      allowedRoles={['coach']}
      room="floor"
      showRouteLabel={false}
    >
      {/* ge-floorboard: Golden Era Visual 002 scope. The only change on this
          route is this wrapper class -- every material (slate board, aged wood
          frame, brass corner brackets and tab plaques, chalk voice) lives in
          scoped CSS under .ge-floorboard in
          design-system/current/ppbf-golden-era.css, so CoachWorkspace and every
          control inside it are untouched. */}
      <div className="ge-floorboard">
        <CoachWorkspace />
      </div>
    </RoleStandaloneView>
  );
}