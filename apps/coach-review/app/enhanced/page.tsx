'use client';
import { DashboardLayout } from '@packages/portals/DashboardLayout';
import { MainNavigation } from '@packages/portals/MainNavigation';

export default function CoachReviewEnhanced() {
  return (
    <DashboardLayout title="Coach Review Queue">
      <MainNavigation />
      <p>Safety Gate Matrix is active. All decisions are governed.</p>
      {/* Existing coach review content can go here */}
    </DashboardLayout>
  );
}
