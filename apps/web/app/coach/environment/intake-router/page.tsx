'use client';

import CoachWorkspace from '@/components/CoachWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function CoachIntakeRouterPage() {
  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/environment/intake-router"
      allowedRoles={['coach']}
      room="floor"
      /* The board names itself. The shell masthead repeated the role and the
         route above it, so a coach read "Coach Workspace" twice and the route
         twice before any child-welfare information -- measured, that furniture
         put the first welfare line 725px down a 915px phone. Twenty-five other
         routes already suppress this band; this is the twenty-sixth. */
      showShellHeader={false}
      mainClassName="ge-coach-floor-room"
    >
      {/* ge-floorboard: Golden Era Visual 002 scope, and inside it the board
          itself (Visual 009, design-system/current/ppbf-floor-board.css).

          THE FLOOR BOARD is a chalkboard in a dark timber carcass rather than
          the house leather-and-brass panel, and that is a deliberate
          exception: the owner rejected five versions of this screen as
          rectangular and lacking gym identity, then sent photographs showing
          that the gym's own information surfaces are already chalkboards and
          whiteboards in rough timber frames. The board is the object the room
          actually contains. */}
      <div className="ge-floorboard">
        <CoachWorkspace />
      </div>
    </RoleStandaloneView>
  );
}
