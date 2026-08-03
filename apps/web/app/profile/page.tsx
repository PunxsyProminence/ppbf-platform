'use client';

import ProfileSettings from '@/components/ProfileSettings';
import RoleStandaloneView from '@/components/RoleStandaloneView';

/**
 * YOUR CORNER — the one surface in the platform that belongs to whoever is
 * standing in front of it.
 *
 * Every role is allowed, which is the point: a coach whose face is supposed to
 * appear on their athlete's card needs somewhere to put it, and a guardian is
 * as entitled to a corner as an athlete is. The route reads nothing but the
 * caller's own record, so the allowed list is genuinely the whole membership
 * rather than a gate that has been left open.
 *
 * Ink ground rather than canvas: this is one screen shared by every role, and
 * roleGround derives the ground from the audience -- a list containing 'parent'
 * AND 'coach' is not a family surface. The corner tokens are restated for both
 * grounds anyway, so the page is correct either way.
 */
export default function ProfilePage() {
  return (
    <RoleStandaloneView
      roleLabel="Your Corner"
      routeLabel="/profile"
      allowedRoles={['athlete', 'coach', 'parent', 'admin', 'staff', 'volunteer']}
      room="office"
      breadcrumbs={[{ label: 'Your Corner' }]}
    >
      <div className="mx-auto w-full max-w-[987px] px-[var(--s5)] py-[var(--s6)]">
        <ProfileSettings />
      </div>
    </RoleStandaloneView>
  );
}
