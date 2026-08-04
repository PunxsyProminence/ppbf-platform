import type { Metadata } from 'next';

import PrintRoom from '@/components/PrintRoom';
import RoleSessionGate from '@/components/RoleSessionGate';

/**
 * /print -- the paper the app makes.
 *
 * Gated to the roles who would actually hand a sheet to somebody: the athlete
 * themselves, their guardian, and staff. Board and volunteer are absent, not
 * because printing is dangerous but because neither has a member whose card it
 * is theirs to print, and a page that only ever produces "nothing here for you"
 * should not be on their menu.
 *
 * Every read behind it re-checks the caller anyway -- see PrintRoom.tsx.
 */
export const metadata: Metadata = {
  title: 'Print',
  description: 'A member card and a milestone certificate, on paper.',
  robots: { index: false, follow: false },
};

export default function PrintPage() {
  return (
    <RoleSessionGate allowedRoles={['athlete', 'parent', 'coach', 'admin', 'platform_owner', 'staff']}>
      <PrintRoom />
    </RoleSessionGate>
  );
}
