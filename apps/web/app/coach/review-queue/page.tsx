'use client';

import CoachWorkspace from '@/components/CoachWorkspace';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function CoachReviewQueuePage() {
  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/review-queue" allowedRoles={['coach']} showShellHeader={false}>
      <CoachWorkspace />
    </RoleStandaloneView>
  );
}
