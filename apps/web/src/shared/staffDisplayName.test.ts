import {
  STAFF_DISPLAY_NAME_MAX,
  canCarryStaffDisplayName,
  normalizeStaffDisplayName,
} from './staffDisplayName';

describe('normalizeStaffDisplayName', () => {
  test('keeps a plain name as typed', () => {
    expect(normalizeStaffDisplayName("Mike O'Neill")).toEqual({ ok: true, name: "Mike O'Neill" });
    expect(normalizeStaffDisplayName('Anne-Marie Smith')).toEqual({ ok: true, name: 'Anne-Marie Smith' });
  });

  test('blank, spaces only, null and undefined all clear the name', () => {
    for (const raw of ['', '   ', '\t\n', null, undefined]) {
      expect(normalizeStaffDisplayName(raw)).toEqual({ ok: true, name: null });
    }
  });

  test('trims the ends and turns every whitespace run, tab, line break or non-breaking space, into one space', () => {
    expect(normalizeStaffDisplayName('  Mike \t\n Neale  ')).toEqual({ ok: true, name: 'Mike Neale' });
  });

  test('stores an accented letter one way (NFC), whichever way it was typed', () => {
    const decomposed = 'José';
    const result = normalizeStaffDisplayName(decomposed);
    expect(result).toEqual({ ok: true, name: 'José' });
  });

  test('refuses a control character that is not whitespace', () => {
    expect(normalizeStaffDisplayName('Mike\u0007Neale')).toEqual({
      ok: false,
      error: 'A display name cannot contain control characters.',
    });
  });

  test(`counts characters, not UTF-16 units: ${STAFF_DISPLAY_NAME_MAX} accented or emoji characters pass, one more does not`, () => {
    expect(normalizeStaffDisplayName('é'.repeat(STAFF_DISPLAY_NAME_MAX))).toEqual({
      ok: true,
      name: 'é'.repeat(STAFF_DISPLAY_NAME_MAX),
    });
    expect(normalizeStaffDisplayName('\u{1F94A}'.repeat(STAFF_DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(normalizeStaffDisplayName('m'.repeat(STAFF_DISPLAY_NAME_MAX + 1))).toEqual({
      ok: false,
      error: 'A display name is at most 60 characters.',
    });
  });

  test('refuses invisible formatting and lone surrogates, keeps joiners', () => {
    for (const raw of ['Mike\u202eNeale', 'Mike\u200bNeale', 'Mike\ud800']) {
      expect(normalizeStaffDisplayName(raw)).toEqual({
        ok: false,
        error: 'A display name cannot contain invisible formatting characters.',
      });
    }
    expect(normalizeStaffDisplayName('\u0915\u094d\u200d\u0937').ok).toBe(true);
  });

  test('refuses anything that is not text', () => {
    expect(normalizeStaffDisplayName(42)).toEqual({ ok: false, error: 'A display name must be text.' });
    expect(normalizeStaffDisplayName({ name: 'Mike' })).toEqual({ ok: false, error: 'A display name must be text.' });
  });
});

describe('canCarryStaffDisplayName', () => {
  test('every adult who works in the gym', () => {
    for (const role of ['coach', 'staff', 'organization_admin', 'admin', 'volunteer']) {
      expect(canCarryStaffDisplayName(role)).toBe(true);
    }
  });

  test('not athletes, guardians, board members or the platform owner', () => {
    for (const role of ['athlete', 'parent', 'board', 'platform_owner', '']) {
      expect(canCarryStaffDisplayName(role)).toBe(false);
    }
  });
});
