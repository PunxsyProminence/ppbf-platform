import fs from 'node:fs';
import path from 'node:path';

/**
 * DR-25 reader guard (Overwatch GO on PR #2133: "Every PR shows a diff check that no reader was
 * added: the near-misses route and the SHADOW feed select no new column").
 *
 * The pain report note and its review live on pilot.shadow_near_misses
 * (pilot_slice_postgres_pain_report_review_migration.sql). They are a minor's health information,
 * and the ruled readers are exactly the coach pain list's: coach, organization_admin and admin,
 * per athlete. So:
 *   - only the files listed in NOTE_AND_REVIEW_FILES may name the new columns at all;
 *   - no source may read pilot.shadow_near_misses with a star, which would carry a new column to
 *     whatever reader it feeds without naming it;
 *   - the near-misses reader (shadowNearMisses.ts) and the SHADOW feed (shadowReadModels.ts),
 *     which athletes and parents reach, name none of them.
 * A later PR that writes or reads the columns adds its file here, in the diff, where review sees it.
 */

const webRoot = path.resolve(__dirname, '../../..');

/** Non-test source files allowed to name the new columns. Empty in PR 1 (schema only). */
const NOTE_AND_REVIEW_FILES: readonly string[] = [];

const NEW_COLUMN = /\b(athlete_note|athlete_note_admin_only)\b/;
/** reviewed_at and reviewed_by_account_id are common names; they matter where the near-miss table is named. */
const REVIEW_COLUMN = /\b(reviewed_by_account_id|reviewed_at)\b/;
const NEAR_MISS_TABLE = /shadow_near_misses/;
const STAR_SELECT = /select\s+(?:distinct\s+)?(?:\w+\.)?\*[\s\S]{0,400}?from\s+pilot\.shadow_near_misses/i;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const relative = (file: string) => path.relative(webRoot, file).split(path.sep).join('/');
const files = ['app', 'components', 'src', 'lib', 'scripts']
  .map((directory) => path.join(webRoot, directory))
  .filter((directory) => fs.existsSync(directory))
  .flatMap(sourceFiles)
  // The migration's own runner names the columns to check them; it reads no row.
  .filter((file) => relative(file) !== 'scripts/pilot-apply-pain-report-review-migration.mjs');

describe('pain report note and review: no new reader (DR-25)', () => {
  test('only the allowed files name the note columns', () => {
    const naming = files.filter((file) => NEW_COLUMN.test(fs.readFileSync(file, 'utf8'))).map(relative);
    expect(naming.sort()).toEqual([...NOTE_AND_REVIEW_FILES].sort());
  });

  test('only the allowed files name the review columns beside the near-miss table', () => {
    const naming = files
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return NEAR_MISS_TABLE.test(source) && REVIEW_COLUMN.test(source);
      })
      .map(relative);
    expect(naming.filter((file) => !NOTE_AND_REVIEW_FILES.includes(file))).toEqual([]);
  });

  test('nothing reads pilot.shadow_near_misses with a star', () => {
    const star = files.filter((file) => STAR_SELECT.test(fs.readFileSync(file, 'utf8'))).map(relative);
    expect(star).toEqual([]);
  });

  test('the near-misses reader and the SHADOW feed name none of the new columns', () => {
    for (const file of ['src/server/pilot/shadowNearMisses.ts', 'src/server/pilot/shadowReadModels.ts']) {
      const source = fs.readFileSync(path.join(webRoot, file), 'utf8');
      expect(source).not.toMatch(NEW_COLUMN);
      expect(source).not.toMatch(/reviewed_by_account_id/);
    }
  });

  test('the star guard would catch a star read', () => {
    expect(STAR_SELECT.test('select * from pilot.shadow_near_misses where organization_id = $1')).toBe(true);
    expect(STAR_SELECT.test('select n.* from pilot.shadow_near_misses n')).toBe(true);
    expect(STAR_SELECT.test('select near_miss_id, severity from pilot.shadow_near_misses')).toBe(false);
  });
});
