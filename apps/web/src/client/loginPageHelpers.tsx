import type { ReactElement } from 'react';

import type { ClubRole } from '@/components/roleRoutes';

export function canPublishAnnouncement(role: ClubRole): boolean {
  return role === 'coach' || role === 'admin' || role.startsWith('board-');
}

export function validateAnnouncementPublishInput(params: {
  selectedRole: ClubRole;
  announcementPin: string;
  draftAnnouncement: string;
  announcementAuthorName: string;
}): string | null {
  if (!canPublishAnnouncement(params.selectedRole)) {
    return 'Only Coach, Admin, or Board roles can publish announcements.';
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
  return `${apiBaseUrl}/api/pilot/auth/microsoft/start`;
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