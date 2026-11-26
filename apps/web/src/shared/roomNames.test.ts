import fs from 'node:fs';
import path from 'node:path';

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

  test('Q-B compares names as they read on screen: case, runs of spaces of any kind and invisible formatting aside', () => {
    const same = ['The Ring', 'the ring', ' THE RING ', 'The  Ring', 'The\u00a0Ring', 'The\u3000Ring', 'The Ring\u200b', 'The\u200d Ring'];
    for (const name of same) expect(roomNameCompareKey(name)).toBe('the ring');
    expect(roomNameCompareKey('The Rings')).not.toBe('the ring');
  });

  test('case is folded the Unicode way (Codex on #2214), and letters that read differently stay apart', () => {
    const same = (a: string, b: string) => roomNameCompareKey(a) === roomNameCompareKey(b);
    // Greek capital sigma, small sigma and final sigma.
    expect(same('\u039f\u03a3', '\u03bf\u03c3')).toBe(true);
    expect(same('\u03bf\u03c2', '\u03bf\u03c3')).toBe(true);
    // The sharp s folds to "ss".
    expect(same('Stra\u00dfe', 'STRASSE')).toBe(true);
    // The Turkish dotless i, an accent, and a different word do not fold together.
    expect(same('K\u0131l\u0131c', 'Kilic')).toBe(false);
    expect(same('Caf\u00e9', 'Cafe')).toBe(false);
    expect(same('Lobby', 'Lobbies')).toBe(false);
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

  test('a name made only of invisible formatting is blank, so it means the default too', () => {
    expect(normalizeRoomName('\u200b')).toEqual({ ok: true, name: null });
    expect(normalizeRoomName(' \u200d\u2060 ')).toEqual({ ok: true, name: null });
    expect(normalizeRoomName('Lobby\u200b')).toEqual({ ok: true, name: 'Lobby\u200b' });
  });

  test('refuses a lone surrogate, and anything that is not text', () => {
    expect(normalizeRoomName('A\ud83eB')).toEqual({ ok: false, error: 'A name cannot contain broken characters.' });
    for (const raw of [7, true, ['Lobby'], { name: 'Lobby' }]) {
      expect(normalizeRoomName(raw)).toEqual({ ok: false, error: 'A name must be text.' });
    }
  });
});

describe('the name rule and the table CHECK use the same characters, for every code point', () => {
  // The migration's own classes, read from the file, so a change to either side is seen here.
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../../../infra/azure/pilot_slice_postgres_organization_room_names_migration.sql'),
    'utf8',
  );
  const leading = /display_name !~ '\^\[([^\]]+)\]'/.exec(sql);
  const trailing = /display_name !~ '\[([^\]]+)\]\$'/.exec(sql);
  const control = /display_name !~ '\[([^\]^$]+)\]'\s*\n/.exec(sql);

  test('the migration states the three classes, the two trim classes the same', () => {
    expect(leading?.[1]).toBeDefined();
    expect(trailing?.[1]).toBe(leading?.[1]);
    expect(control?.[1]).toBeDefined();
  });

  test('the trim class is exactly what JavaScript\'s trim() removes, and the control class exactly Cc plus U+2028 and U+2029 (NUL aside, which text cannot hold)', () => {
    // Postgres ARE and JavaScript read these escapes the same way inside a class.
    const trimClass = new RegExp(`^[${leading?.[1]}]$`, 'u');
    const controlClass = new RegExp(`^[${control?.[1]}]$`, 'u');
    const jsControl = /^[\p{Cc}\u2028\u2029]$/u;
    const trimMismatch: string[] = [];
    const controlMismatch: string[] = [];
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (trimClass.test(ch) !== (ch.trim() === '')) trimMismatch.push(cp.toString(16));
      if (controlClass.test(ch) !== jsControl.test(ch)) controlMismatch.push(cp.toString(16));
    }
    expect(trimMismatch).toEqual([]);
    expect(controlMismatch).toEqual([]);
  });
});
