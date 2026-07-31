import type { ReactElement } from 'react';

import type { ClubRole } from '@/components/roleRoutes';
import { mapPilotRoleToClubRole } from '@/components/roleSession';

export function mapPilotLoginRoleToClubRole(role: string): ClubRole {
  const mappedRole = mapPilotRoleToClubRole(role);
  if (!mappedRole) {
    throw new Error('Unsupported authenticated role');
  }

  return mappedRole;
}

export function canPublishAnnouncement(role: ClubRole): boolean {
  // platform_owner is listed explicitly because it used to arrive here folded
  // into 'admin'. announcements/post resolveAuthorRole() admits it, so leaving
  // it out when the club roles split would have quietly withdrawn a capability
  // the server still grants -- speaking for the club is breadth, not the
  // athlete-scoped depth Omega is barred from.
  return role === 'coach' || role === 'admin' || role === 'platform_owner';
}

export function validateAnnouncementPublishInput(params: {
  selectedRole: ClubRole;
  announcementPin: string;
  draftAnnouncement: string;
  announcementAuthorName: string;
}): string | null {
  if (!canPublishAnnouncement(params.selectedRole)) {
    return 'Only Coach or Admin roles can publish announcements.';
  }

  if (!params.announcementPin.trim()) {
    return 'Access PIN is required.';
  }

  if (!params.draftAnnouncement.trim()) {
    return 'Announcement cannot be empty.';
  }

  if (!params.announcementAuthorName.trim()) {
    return 'Author name is required.';
  }

  return null;
}

export function getMicrosoftStartUrl(apiBaseUrl: string): string {
  const startPath = '/api/pilot/auth/microsoft/start';

  if (typeof window !== 'undefined' && apiBaseUrl.trim()) {
    try {
      const configuredBase = new URL(apiBaseUrl, window.location.origin);
      if (configuredBase.origin !== window.location.origin) {
        return startPath;
      }
      return `${configuredBase.origin}${startPath}`;
    } catch {
      return startPath;
    }
  }

  if (!apiBaseUrl.trim()) {
    return startPath;
  }

  return `${apiBaseUrl}${startPath}`;
}

export function signInWithMicrosoft(apiBaseUrl: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.assign(getMicrosoftStartUrl(apiBaseUrl));
}

export function createMicrosoftSignInHandler(apiBaseUrl: string): () => void {
  return () => signInWithMicrosoft(apiBaseUrl);
}

export function getTabButtonClass(isActive: boolean): string {
  if (isActive) {
    return 'border-2 border-[var(--black)] bg-[var(--red-primary)] text-[var(--white)]';
  }

  return 'border-2 border-[var(--black)] bg-[var(--canvas-tan)] text-[var(--gray-dark)] hover:bg-[var(--canvas-tan-dark)]';
}

export function renderAthleteIdField(props: Readonly<{
  selectedRole: ClubRole;
  athleteId: string;
  setAthleteId: (value: string) => void;
}>): ReactElement | null {
  if (props.selectedRole !== 'athlete') {
    return null;
  }

  return (
    <>
      <label className="block text-xs font-semibold uppercase tracking-[0.25em] text-[var(--gray-dark)]" htmlFor="athlete-id">
        Athlete ID
      </label>
      <input
        id="athlete-id"
        type="text"
        value={props.athleteId}
        onChange={(event) => props.setAthleteId(event.target.value)}
        placeholder="Enter Athlete ID"
        className="w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-4 py-3 text-[var(--black)] outline-none transition placeholder-[var(--gray-medium)] focus:border-[var(--red-primary)] focus:bg-[var(--canvas-tan-light)]"
      />
    </>
  );
}
