import {
  canPublishAnnouncement,
  getMicrosoftStartUrl,
  getTabButtonClass,
  mapPilotLoginRoleToClubRole,
  validateAnnouncementPublishInput,
} from './loginPageHelpers';

describe('login page helpers', () => {
  test('builds the Microsoft start URL from the API base when origin matches', () => {
    const assign = global.window;
    Object.defineProperty(global, 'window', {
      value: { location: { origin: 'http://localhost:3000' } },
      writable: true,
    });

    expect(getMicrosoftStartUrl('http://localhost:3000')).toBe('http://localhost:3000/api/pilot/auth/microsoft/start');

    Object.defineProperty(global, 'window', {
      value: assign,
      writable: true,
    });
  });

  test('falls back to same-origin Microsoft start URL when configured API base is cross-origin', () => {
    const assign = global.window;
    Object.defineProperty(global, 'window', {
      value: { location: { origin: 'https://www.punxsyprominence.org' } },
      writable: true,
    });

    expect(getMicrosoftStartUrl('https://app-ppbf-production.purpledesert-3a75d580.eastus.azurecontainerapps.io')).toBe(
      '/api/pilot/auth/microsoft/start',
    );

    Object.defineProperty(global, 'window', {
      value: assign,
      writable: true,
    });
  });

  test('returns the active and inactive tab button classes', () => {
    expect(getTabButtonClass(true)).toContain('bg-[var(--red-primary)]');
    expect(getTabButtonClass(false)).toContain('bg-[var(--canvas-tan)]');
  });

  test('maps backend login roles to supported frontend sessions', () => {
    // platform_owner no longer folds into 'admin': the server treats Omega as
    // broader in breadth and strictly narrower in depth, and one shared club
    // role made every page guard wrong in one direction or the other.
    expect(mapPilotLoginRoleToClubRole('platform_owner')).toBe('platform_owner');
    expect(mapPilotLoginRoleToClubRole('organization_admin')).toBe('admin');
    expect(mapPilotLoginRoleToClubRole('coach')).toBe('coach');
    expect(mapPilotLoginRoleToClubRole('athlete')).toBe('athlete');
    expect(mapPilotLoginRoleToClubRole('parent')).toBe('parent');
    expect(mapPilotLoginRoleToClubRole('board')).toBe('board');
  });

  test('never defaults an unknown authenticated role to admin', () => {
    expect(() => mapPilotLoginRoleToClubRole('future_super_admin'))
      .toThrow('Unsupported authenticated role');
  });

  test('permits only the expected announcement roles', () => {
    expect(canPublishAnnouncement('coach')).toBe(true);
    expect(canPublishAnnouncement('admin')).toBe(true);
    // Kept when the club roles split. announcements/post admits platform_owner,
    // so dropping it here would have withdrawn a capability the server grants.
    expect(canPublishAnnouncement('platform_owner')).toBe(true);
    expect(canPublishAnnouncement('board')).toBe(false);
    expect(canPublishAnnouncement('board-chair')).toBe(false);
    expect(canPublishAnnouncement('athlete')).toBe(false);
  });

  test('validates announcement publish inputs', () => {
    expect(
      validateAnnouncementPublishInput({
        selectedRole: 'athlete',
        announcementPin: '1234',
        draftAnnouncement: 'Hello',
        announcementAuthorName: 'Coach',
      }),
    ).toBe('Only Coach or Admin roles can publish announcements.');

    expect(
      validateAnnouncementPublishInput({
        selectedRole: 'coach',
        announcementPin: '',
        draftAnnouncement: 'Hello',
        announcementAuthorName: 'Coach',
      }),
    ).toBe('Access PIN is required.');
  });
});
