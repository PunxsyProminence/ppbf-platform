import { permanentRedirect } from 'next/navigation';

/* Was a "moved into the Parent Hub" notice (its prototype consent and safety
   controls recorded nothing and were deleted). It forwards to the hub now, as
   /guardian does (UX audit A-10); consent is reached from the hub. */
export default function GuardianDashboardPage(): never {
  permanentRedirect('/parent/dashboard');
}
