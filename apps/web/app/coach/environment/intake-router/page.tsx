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

          THE FLOOR BOARD is a hand-built board in a rough timber carcass,
          hanging on a matte black chalkboard-painted wall, rather than the
          house leather-and-brass panel. That is a deliberate exception: the
          owner rejected five versions of this screen as rectangular and
          lacking gym identity, then sent photographs of the building.

          THIS COMMENT USED TO SAY THE BOARD "IS A CHALKBOARD", and that was
          the drift, stated as rationale. The correction is on the record --
          "I only wanted th backround wall black like a chalk board" -- and the
          approved brief is explicit that the interface does not become chalk.
          The WALL is the chalkboard. The board is an object on it. */}
      <div className="ge-floorboard">
        <CoachWorkspace />
      </div>
    </RoleStandaloneView>
  );
}
