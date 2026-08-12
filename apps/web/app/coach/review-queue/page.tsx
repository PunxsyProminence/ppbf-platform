import CoachReviewQueue from '@/src/components/coach/CoachReviewQueue';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function CoachReviewQueuePage() {
  await requirePageRole(['coach']);

  return (
    <main className="min-h-screen bg-[#09090b]">
      <CoachReviewQueue />
    </main>
  );
}
