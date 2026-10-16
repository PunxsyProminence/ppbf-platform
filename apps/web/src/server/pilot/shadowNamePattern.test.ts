import fs from 'node:fs';
import path from 'node:path';

/* The copy that runs: scripts/pilot-cleanup-deleted-data.mjs, the only
   retention purge. The script runs its job on load, so it cannot be imported;
   namePattern is read out of its source and evaluated on its own (it uses no
   names from the script around it). */
const SCRIPT = fs.readFileSync(path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs'), 'utf8');
const start = SCRIPT.indexOf('\nfunction namePattern(');
const end = SCRIPT.indexOf('\n}\n', start);
if (start < 0 || end < 0) throw new Error('namePattern not found in the retention script');
const namePattern = new Function(`${SCRIPT.slice(start, end + 3)}\nreturn namePattern;`)() as (
  names: Array<string | null | undefined>,
  gymWide?: boolean,
) => string | null;

/* The scrub pattern the retention purge hands Postgres (regexp_replace, flags
   'gi') for a purged person's names: whole and by word, longest first, on
   word boundaries, regex metacharacters escaped, nothing shorter than two
   characters, null when nothing usable is known. */
describe('namePattern', () => {
  test('matches the whole name and each word, longest first, on word boundaries', () => {
    expect(namePattern(['Jordan Pike'])).toBe('\\m(Jordan Pike|Jordan|Pike)\\M');
  });

  test('escapes regex metacharacters, trims edge punctuation, splits on it, and skips single characters', () => {
    expect(namePattern(["Ann O'Brien (Jr.)", 'J', 'a@b.test'])).toBe(
      "\\m(Ann O'Brien \\(Jr|a@b\\.test|Brien|Ann|Jr)\\M",
    );
  });

  test('splits hyphenated names and takes an email local part, never its domain', () => {
    expect(namePattern(['Mary-Kate Lee'])).toBe('\\m(Mary-Kate Lee|Mary|Kate|Lee)\\M');
    expect(namePattern(['jordan.pike2013@example.test'])).toBe(
      '\\m(jordan\\.pike2013@example\\.test|jordan\\.pike2013|pike2013|jordan)\\M',
    );
  });

  test('returns null when no usable name is known', () => {
    expect(namePattern([])).toBeNull();
    expect(namePattern([null, undefined, '', '  ', 'X'])).toBeNull();
  });

  test('dedupes names that repeat across sources', () => {
    expect(namePattern(['Casey Pike', 'Casey Pike', 'Pike'])).toBe('\\m(Casey Pike|Casey|Pike)\\M');
  });

  test("gym-wide, a particle or a part under three letters is not a name on its own; the full name still is", () => {
    // The person's own notes and the ones about them: every part, particles included.
    expect(namePattern(['Maria de la Cruz'])).toBe('\\m(Maria de la Cruz|Maria|Cruz|de|la)\\M');
    // Everyone else's notes in the gym (Overwatch 2026-10-16): "of" or "de" in a coach's note stays.
    expect(namePattern(['Maria de la Cruz'], true)).toBe('\\m(Maria de la Cruz|Maria|Cruz)\\M');
    expect(namePattern(['Al Van Der Berg Jr.', 'Ed'], true)).toBe('\\m(Al Van Der Berg Jr|Berg)\\M');
    expect(namePattern(['Mac', 'Of'], true)).toBeNull();
  });
});
