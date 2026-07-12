'use client';

import ParentHub from '@/components/ParentHub';
import RoleStandaloneView from '@/components/RoleStandaloneView';

export default function ParentDashboardPage() {
  return (
    <RoleStandaloneView roleLabel="Parent Hub" routeLabel="/parent/dashboard" allowedRoles={['parent']}>
      <ParentHub />
    </RoleStandaloneView>
  );
}
