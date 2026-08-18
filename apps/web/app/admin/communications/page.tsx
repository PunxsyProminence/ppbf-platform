import SampleDataNotice from '@/components/SampleDataNotice';
import MediaAndCommsHub from '@/src/components/communications/MediaAndCommsHub';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AdminCommunicationsPage() {
  // 'organization_admin' is the canonical organization administrator;
  // 'admin' is the legacy row name kept for compatibility (see roleEquals in
  // src/server/pilot/access.ts). This gate listed only the legacy name, so
  // every real organization admin was refused and bounced.
  await requirePageRole(['organization_admin', 'admin', 'staff']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <SampleDataNotice
        what="The messages, campaigns, and delivery figures on this page are illustrative and were sent to nobody. Never treat an entry here as consent to publish a minor's image."
      />
      <MediaAndCommsHub />
    </main>
  );
}
