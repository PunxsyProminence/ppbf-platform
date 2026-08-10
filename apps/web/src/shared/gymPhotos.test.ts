import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  GYM_PHOTO_BASE_PATH,
  GYM_PHOTO_SLOTS,
  GYM_STAFF_CARDS,
  filledGymPhotoSlots,
  gymPhotoSlotsFor,
  gymPhotoSrc,
} from './gymPhotos';

/**
 * The manifest is the whole safety story for the gym's photography, so it is
 * tested as one: what it may point at, what it must never point at, and the
 * fact that every slot is empty today.
 */

describe('the gym photo manifest', () => {
  it('fills every slot with a placeholder illustration, honestly labeled', () => {
    // Updated deliberately (owner decision, 2026-08-06): the six building
    // slots carry commissioned placeholder ILLUSTRATIONS until the real
    // photographs are taken. Each file was drawn and checked -- building only,
    // no people -- and each alt text says out loud that it is an illustration,
    // because a frame must never claim a photograph it does not hold.
    expect(filledGymPhotoSlots().map((slot) => slot.key)).toEqual(
      GYM_PHOTO_SLOTS.map((slot) => slot.key),
    );
    for (const slot of GYM_PHOTO_SLOTS) {
      expect(slot.file).toMatch(/\.svg$/);
      expect(slot.alt.toLowerCase()).toContain('illustration');
      expect(slot.alt.toLowerCase()).toContain('placeholder');
    }
    // Staff cards are different: a drawn stand-in for a named real person
    // would be an invention, so they stay empty until a real photograph lands.
    expect(GYM_STAFF_CARDS.every((person) => person.photo === null)).toBe(true);
  });

  it('backs every named illustration with a real file in public/gym', () => {
    for (const slot of GYM_PHOTO_SLOTS) {
      expect(slot.file).not.toBeNull();
      const filePath = path.join(__dirname, '..', '..', 'public', 'gym', slot.file as string);
      expect({ slot: slot.key, exists: readFileSync(filePath, 'utf8').length > 0 }).toEqual({
        slot: slot.key,
        exists: true,
      });
    }
  });

  it('gives every slot alt text before it can ever hold a photograph', () => {
    for (const slot of GYM_PHOTO_SLOTS) {
      expect(slot.alt.trim().length).toBeGreaterThan(0);
      expect(slot.title.trim().length).toBeGreaterThan(0);
      expect(slot.caption.trim().length).toBeGreaterThan(0);
    }
    for (const person of GYM_STAFF_CARDS) {
      expect(person.alt.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses stable unique keys', () => {
    const keys = GYM_PHOTO_SLOTS.map((slot) => slot.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('serves a filled slot from the static folder and nowhere else', () => {
    expect(gymPhotoSrc('ring.jpg')).toBe(`${GYM_PHOTO_BASE_PATH}/ring.jpg`);
  });

  it('refuses anything that is not a plain file name', () => {
    // Each of these is a way a slot could be pointed somewhere it must not go:
    // another origin, a parent directory, or the session-scoped portrait route.
    expect(gymPhotoSrc('https://example.com/kid.jpg')).toBeNull();
    expect(gymPhotoSrc('../../../etc/passwd')).toBeNull();
    expect(gymPhotoSrc('/api/pilot/profile/photo/acct-1')).toBeNull();
    expect(gymPhotoSrc('sub/dir/ring.jpg')).toBeNull();
    expect(gymPhotoSrc('..\\windows\\file.jpg')).toBeNull();
    expect(gymPhotoSrc('')).toBeNull();
    expect(gymPhotoSrc('   ')).toBeNull();
    expect(gymPhotoSrc(null)).toBeNull();
  });

  it('gives each surface only the slots that named it', () => {
    const dashboard = gymPhotoSlotsFor('dashboard');
    const publicSlots = gymPhotoSlotsFor('public');

    expect(dashboard.length).toBeGreaterThan(0);
    expect(publicSlots.length).toBeGreaterThan(0);
    expect(dashboard.every((slot) => slot.surfaces.includes('dashboard'))).toBe(true);
    expect(publicSlots.every((slot) => slot.surfaces.includes('public'))).toBe(true);

    // The front door is a thing you show a stranger deciding whether to come
    // in, not a thing a member needs on their dashboard.
    expect(dashboard.map((slot) => slot.key)).not.toContain('entrance');
  });

  it('never reaches member media', () => {
    // The source-level guard. A dashboard module is a wider audience than a
    // profile page, and profileVisibility.ts refuses a minor's face to that
    // audience -- so the manifest must have no route to the portrait pipeline
    // at all rather than a rule beside the one that exists.
    const source = readFileSync(path.join(__dirname, 'gymPhotos.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    for (const forbidden of [
      'account_profiles',
      'photo_blob_path',
      'profile/photo',
      'portraitUrl',
      'downloadPilotProfilePhoto',
      'blob.core.windows.net',
    ]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});
