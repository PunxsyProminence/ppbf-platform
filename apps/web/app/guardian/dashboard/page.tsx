import Link from 'next/link';

import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// This route used to mount GuardianSafetyControls -- a prototype whose
// media-consent checkbox and "Submit Home Observation / Safety Concern" box
// were wired to useState and nothing else. A guardian could tick consent for
// a minor's media, or type a safety concern, and the platform recorded
// neither. Both capabilities exist for real elsewhere, so this page now says
// exactly that and points at them instead of silently discarding input that
// matters this much. The prototype component is deleted, not stamped: a
// consent toggle that records nothing must not remain mountable.
export default async function GuardianDashboardPage() {
  // 'parent' is the canonical guardian-family role in this codebase.
  await requirePageRole(['parent']);

  // T7 (Plate Set v1): family surfaces take the warm ground or none. See the
  // note on parent/safety for why the room is dropped rather than swapped to
  // .on-canvas.
  return (
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Guardian</p>
          <h1 className="t-command text-[length:var(--t-2xl)]">This page moved into the Parent Hub</h1>
          <p className="t-body max-w-[70ch] text-[color:var(--bone-300)]">
            Media consent and safety reporting are live on your real surfaces &mdash; nothing you enter here
            would be saved, so this page no longer asks. Photo and video consent for your child is granted and
            withdrawn on the consent page, and a safety concern or barrier report reaches the gym through the
            Parent Hub&rsquo;s report form.
          </p>
        </header>
        <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/parent/consent" className="btn">
            Photo &amp; Video Consent
          </Link>
          <Link href="/parent/dashboard" className="btn btn--ghost">
            Open the Parent Hub
          </Link>
        </div>
      </div>
    </main>
  );
}
