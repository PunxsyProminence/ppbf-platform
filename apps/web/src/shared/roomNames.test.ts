import { ROOM_LABEL } from '@/components/buildingMap';
import { ROOM_PLACE_LABEL, ROOM_PLACE_ORDER } from '@/components/roomPlaces';

import {
  CARD_NAME_DEFAULTS,
  isRoomNameKey,
  normalizeRoomName,
  ROOM_NAME_DEFAULTS,
  ROOM_NAME_KEYS,
  ROOM_NAME_MAX_LENGTH,
  roomNameCompareKey,
  roomNameList,
  type RoomNameKey,
} from './roomNames';

/*
 * The closed list of names a gym may change, and the name rule (lane W4-9,
 * RN-1b; OW27-40 A; Overwatch's Q-A to Q-C on #2212). The database half is
 * roomNames.pg.test.ts, which also checks that this rule and the table's
 * CHECK agree.
 */

// The table's key CHECK (pilot_slice_postgres_organization_room_names_migration.sql).
const KEY_SHAPE = /^(place|room|card):[a-z]+(-[a-z]+)*$/;

describe('the closed list', () => {
  test('is the 17 Room Map rooms, the 7 rooms and the six card names (OW27-40 A, Q-A A), each once', () => {
    expect(ROOM_NAME_KEYS).toHaveLength(17 + 7 + 6);
    expect(new Set(ROOM_NAME_KEYS).size).toBe(ROOM_NAME_KEYS.length);
    expect(ROOM_NAME_KEYS.filter((key) => roomNameList(key) === 'place')).toEqual(ROOM_PLACE_ORDER.map((p) => `place:${p}`));
    expect(ROOM_NAME_KEYS.filter((key) => roomNameList(key) === 'room')).toEqual(Object.keys(ROOM_LABEL).map((r) => `room:${r}`));
    expect(ROOM_NAME_KEYS.filter((key) => roomNameList(key) === 'card')).toEqual([
      'card:your-profile', 'card:my-corner', 'card:who-you-train-with',
      'card:who-they-train-with', 'card:your-entry', 'card:coach-entry',
    ]);
  });

  test('every key has the shape the table stores', () => {
    for (const key of ROOM_NAME_KEYS) expect(key).toMatch(KEY_SHAPE);
  });

  test('the rooms default to the tables that already name them, and the cards to the words their pages show today', () => {
    for (const place of ROOM_PLACE_ORDER) expect(ROOM_NAME_DEFAULTS[`place:${place}`]).toBe(ROOM_PLACE_LABEL[place]);
    for (const [room, label] of Object.entries(ROOM_LABEL)) expect(ROOM_NAME_DEFAULTS[`room:${room}` as RoomNameKey]).toBe(label);
    expect(CARD_NAME_DEFAULTS).toEqual({
      'your-profile': 'Your Profile',
      'my-corner': 'My Corner',
      'who-you-train-with': 'Who you train with',
      'who-they-train-with': 'Who they train with',
      'your-entry': 'Your entry',
      'coach-entry': 'Coach Entry',
    });
  });

  test('no two defaults in one list read the same, so a gym on the defaults already meets Q-B', () => {
    for (const list of ['place', 'room', 'card'] as const) {
      const names = ROOM_NAME_KEYS.filter((key) => roomNameList(key) === list).map((key) => roomNameCompareKey(ROOM_NAME_DEFAULTS[key]));
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test('every default passes the name rule unchanged', () => {
    for (const key of ROOM_NAME_KEYS) {
      expect(normalizeRoomName(ROOM_NAME_DEFAULTS[key])).toEqual({ ok: true, name: ROOM_NAME_DEFAULTS[key] });
    }
  });

  test('isRoomNameKey accepts only keys on the list', () => {
    expect(isRoomNameKey('place:front-desk')).toBe(true);
    expect(isRoomNameKey('card:coach-entry')).toBe(true);
    for (const value of ['place:lobby', 'room:gym', 'card:your-corner', 'door:/profile', 'place:Front-desk', '', null, 7, {}]) {
      expect(isRoomNameKey(value)).toBe(false);
    }
  });
});

describe('normalizeRoomName (Q-C A)', () => {
  test('null, undefined and a blank name mean "use the default"', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n', '\u00a0\u3000']) {
      expect(normalizeRoomName(raw)).toEqual({ ok: true, name: null });
    }
  });

  test('trims every character JavaScript\'s trim() removes, and keeps spaces inside', () => {
    expect(normalizeRoomName('  Lobby  ')).toEqual({ ok: true, name: 'Lobby' });
    expect(normalizeRoomName('\u00a0Lobby\u3000')).toEqual({ ok: true, name: 'Lobby' });
    expect(normalizeRoomName('\ufeffThe Ring\n')).toEqual({ ok: true, name: 'The Ring' });
    expect(normalizeRoomName('Changing\u00a0Room')).toEqual({ ok: true, name: 'Changing\u00a0Room' });
  });

  test('stores the NFC spelling, so two spellings of the same letters are one name', () => {
    expect(normalizeRoomName('Cafe\u0301')).toEqual({ ok: true, name: 'Caf\u00e9' });
    expect(roomNameCompareKey('CAFE\u0301')).toBe(roomNameCompareKey('caf\u00e9'));
  });

  test('takes up to 40 characters, counted as code points', () => {
    expect(ROOM_NAME_MAX_LENGTH).toBe(40);
    expect(normalizeRoomName('x'.repeat(40))).toEqual({ ok: true, name: 'x'.repeat(40) });
    expect(normalizeRoomName('\ud83e\udd4a'.repeat(40))).toEqual({ ok: true, name: '\ud83e\udd4a'.repeat(40) });
    expect(normalizeRoomName('x'.repeat(41))).toEqual({ ok: false, error: 'A name can be at most 40 characters.' });
    expect(normalizeRoomName('\ud83e\udd4a'.repeat(41)).ok).toBe(false);
  });

  test('refuses a line break or control character inside the name', () => {
    for (const raw of ['Front\nDesk', 'Front\rDesk', 'Front\tDesk', 'A\u0000B', 'A\u0007B', 'A\u007fB', 'A\u0085B', 'A\u009fB', 'A\u2028B', 'A\u2029B']) {
      expect(normalizeRoomName(raw)).toEqual({ ok: false, error: 'A name cannot contain line breaks or control characters.' });
    }
  });

  test('refuses a lone surrogate, and anything that is not text', () => {
    expect(normalizeRoomName('A\ud83eB')).toEqual({ ok: false, error: 'A name cannot contain broken characters.' });
    for (const raw of [7, true, ['Lobby'], { name: 'Lobby' }]) {
      expect(normalizeRoomName(raw)).toEqual({ ok: false, error: 'A name must be text.' });
    }
  });
});
