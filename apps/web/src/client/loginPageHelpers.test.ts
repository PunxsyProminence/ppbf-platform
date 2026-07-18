import {
  canPublishAnnouncement,
  getMicrosoftStartUrl,
  getTabButtonClass,
  validateAnnouncementPublishInput,
} from './loginPageHelpers';

describe('login page helpers', () => {
  test('builds the Microsoft start URL from the API base', () => {
    expect(getMicrosoftStartUrl('http://localhost:3000')).toBe('http://localhost:3000/api/pilot/auth/microsoft/start');
  });

  test('returns the active and inactive tab button classes', () => {
    expect(getTabButtonClass(true)).toContain('bg-[var(--red-primary)]');
    expect(getTabButtonClass(false)).toContain('bg-[var(--canvas-tan)]');
  });

  test('permits only the expected announcement roles', () => {
    expect(canPublishAnnouncement('coach')).toBe(true);
    expect(canPublishAnnouncement('admin')).toBe(true);
    expect(canPublishAnnouncement('board-chair')).toBe(true);
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
    ).toBe('Only Coach, Admin, or Board roles can publish announcements.');

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