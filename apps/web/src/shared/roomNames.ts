/**
 * THE NAMES A GYM MAY CHANGE, AND THE NAME EACH ONE SHIPS WITH (lane W4-9,
 * RN-1b). Read by the server store (src/server/pilot/roomNames.ts) and, from
 * RN-2, by the browser, so both use one list and one set of defaults.
 *
 * WHICH NAMES. Jason, OW27-11 (OD-2026-11-20-001): "these room should be able
 * to be changed in the app by the organization to relat e to it". OW27-40 A
 * (OD-2026-11-21-007): the Room Map rooms (and the 7 rooms while their names
 * still show), the OW27-15 names and "My Corner". Overwatch's Q-A A on #2212:
 * the family and staff forms ("Who they train with", "Coach Entry") are names
 * of their own. Nothing else is renamable: not Search's "Home" or "Lab", not
 * the job bar's sections, not ClusterNav's names (Q-F A), not other pages.
 *
 * THE DEFAULTS. The rooms' defaults are the tables that already name them
 * (ROOM_PLACE_LABEL, ROOM_LABEL), imported, not copied. The card names'
 * defaults are the words AS8-4 typed into their pages; RN-3 makes those pages
 * read them from here.
 *
 * THE KEYS are what pilot.organization_room_names stores (RN-1a): "place:",
 * "room:" or "card:", then lower-case words joined by hyphens. The table's
 * CHECK holds only that shape; this list is the closed list.
 *
 * THE NAME RULE (Overwatch's Q-C A): 1 to 40 characters, trimmed, no line
 * breaks or control characters. normalizeRoomName applies it before the
 * database's CHECK does, with the same character sets, so a name this accepts
 * is never refused by the database.
 */

import { ROOM_LABEL, ROOM_ORDER, type Room } from '@/components/buildingMap';
import { ROOM_PLACE_LABEL, ROOM_PLACE_ORDER, type RoomPlace } from '@/components/roomPlaces';

/** The card names, in the order a settings list would show them. */
export const CARD_NAME_DEFAULTS = {
  'your-profile': 'Your Profile',
  'my-corner': 'My Corner',
  'who-you-train-with': 'Who you train with',
  'who-they-train-with': 'Who they train with',
  'your-entry': 'Your entry',
  'coach-entry': 'Coach Entry',
} as const;

export type CardName = keyof typeof CARD_NAME_DEFAULTS;

/** The three lists. A duplicate name is refused only within one list (Q-B A). */
export type RoomNameList = 'place' | 'room' | 'card';

export type RoomNameKey = `place:${RoomPlace}` | `room:${Room}` | `card:${CardName}`;

const CARD_ORDER = Object.keys(CARD_NAME_DEFAULTS) as CardName[];

/** Every renamable name: the Room Map rooms in their order, the 7 rooms, then the card names. */
export const ROOM_NAME_KEYS: readonly RoomNameKey[] = [
  ...ROOM_PLACE_ORDER.map((place) => `place:${place}` as const),
  ...ROOM_ORDER.map((room) => `room:${room}` as const),
  ...CARD_ORDER.map((card) => `card:${card}` as const),
];

/** The name each key shows when the gym has not changed it. */
export const ROOM_NAME_DEFAULTS: Readonly<Record<RoomNameKey, string>> = Object.fromEntries([
  ...ROOM_PLACE_ORDER.map((place) => [`place:${place}`, ROOM_PLACE_LABEL[place]]),
  ...ROOM_ORDER.map((room) => [`room:${room}`, ROOM_LABEL[room]]),
  ...CARD_ORDER.map((card) => [`card:${card}`, CARD_NAME_DEFAULTS[card]]),
]) as Record<RoomNameKey, string>;

const KEY_SET: ReadonlySet<string> = new Set(ROOM_NAME_KEYS);

export function isRoomNameKey(value: unknown): value is RoomNameKey {
  return typeof value === 'string' && KEY_SET.has(value);
}

export function roomNameList(key: RoomNameKey): RoomNameList {
  return key.slice(0, key.indexOf(':')) as RoomNameList;
}

/**
 * The two forms of one card, for different readers (Q-A A: "the same rooms
 * seen by other roles"). Overwatch's Q-G A on #2214: for Q-B they count as one
 * card, so they may share a name; a clash with any other card or a room is
 * still refused.
 */
const OTHER_FORM: Readonly<Partial<Record<RoomNameKey, RoomNameKey>>> = {
  'card:who-you-train-with': 'card:who-they-train-with',
  'card:who-they-train-with': 'card:who-you-train-with',
  'card:your-entry': 'card:coach-entry',
  'card:coach-entry': 'card:your-entry',
};

/** Whether two keys are one card (the same key, or the two forms of one card). */
export function isSameCard(a: RoomNameKey, b: RoomNameKey): boolean {
  return a === b || OTHER_FORM[a] === b;
}

/** Q-C A: the longest name, in characters (code points, as the database counts). */
export const ROOM_NAME_MAX_LENGTH = 40;

// The control characters and line breaks Q-C refuses: Cc is exactly C0, DEL
// and C1 (U+0000 to U+001F, U+007F to U+009F), the set the database's CHECK
// writes as code points, plus U+2028 and U+2029. NUL is in Cc: Postgres text
// cannot hold it at all. JavaScript's trim() removes the same set the CHECK
// refuses at either end, so trimming first is what makes the two agree.
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\u2028\u2029]/u;
// A lone surrogate is not text: the database would store U+FFFD in its place.
const LONE_SURROGATE = /\p{Cs}/u;
// Invisible formatting (a zero-width space, a joiner, a direction mark). Kept
// in a stored name, but a name made of nothing else reads as blank, and two
// names that differ only by it read the same.
const INVISIBLE_FORMAT = /\p{Cf}/gu;

export type RoomNameInput =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * A gym's name as typed, made ready to store. null, undefined or a blank
 * string (blank includes a string of only invisible formatting) mean "use the
 * default" (name: null). Otherwise the name is trimmed and NFC-normalized (so
 * two spellings of the same letters compare equal), and refused if it is over
 * 40 characters or carries a control character or line break.
 */
export function normalizeRoomName(raw: unknown): RoomNameInput {
  if (raw === null || raw === undefined) return { ok: true, name: null };
  if (typeof raw !== 'string') return { ok: false, error: 'A name must be text.' };
  const name = raw.normalize('NFC').trim();
  if (!name.replace(INVISIBLE_FORMAT, '').trim()) return { ok: true, name: null };
  if (CONTROL_OR_LINE_BREAK.test(name)) {
    return { ok: false, error: 'A name cannot contain line breaks or control characters.' };
  }
  if (LONE_SURROGATE.test(name)) return { ok: false, error: 'A name cannot contain broken characters.' };
  if ([...name].length > ROOM_NAME_MAX_LENGTH) {
    return { ok: false, error: `A name can be at most ${ROOM_NAME_MAX_LENGTH} characters.` };
  }
  return { ok: true, name };
}

/**
 * Case folding, as Unicode's full case folding does it, from what JavaScript
 * has (Codex on #2214: toLowerCase alone lets "STRASSE" beside "Strasse" with
 * the sharp s, and two Greek sigma forms, through as different names).
 * Upper-casing first applies the special cases (the sharp s to "SS"); then
 * lower-casing. The Turkish dotless i is kept apart, as folding keeps it: it
 * reads differently from "i". NFC again after, as the fold can split letters.
 */
function foldCase(text: string): string {
  return text.replace(/\u0131/g, '\ue000').toUpperCase().toLowerCase().replace(/\ue000/g, '\u0131').normalize('NFC');
}

/**
 * How two names are compared for Q-B's duplicate rule (trimmed and
 * case-insensitive), so that two names that read the same on screen count as
 * one (Q-B A's own text: "two Search groups can never read the same"):
 * invisible formatting is dropped, every run of spaces of any kind (a browser
 * shows two spaces, or a non-breaking space, as one) becomes one space, and
 * case is folded. Only the comparison changes; the name is stored as given.
 */
export function roomNameCompareKey(name: string): string {
  return foldCase(name.normalize('NFC').replace(INVISIBLE_FORMAT, '').replace(/\s+/gu, ' ').trim());
}
