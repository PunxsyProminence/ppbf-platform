/**
 * ONE RETENTION PURGE. scripts/pilot-cleanup-deleted-data.mjs, dispatched by
 * .github/workflows/retention-cleanup.yml, is the only code that hard-deletes
 * an athlete or a video row, and it deletes the athlete's videos, files and
 * portrait with the rows (#1268). A second copy, dataDeletion.ts
 * purgeExpiredDeletedData, had no caller and deleted athletes without their
 * files; wiring it up would have left a child's footage in storage with
 * nothing naming it, for the next child given the same athlete_id to
 * inherit. It was removed.
 *
 * This fails if a hard delete of pilot.athletes or pilot.video_sessions
 * appears in any source in the repository's apps, packages or scripts other
 * than the cleanup script, or if the script loses the file purge. Tests are
 * not scanned: they stage their own rows. Comments are blanked before the
 * scan (they describe a statement, they do not run it), and a statement may
 * span lines. Migrations (infra/**.sql) are not scanned: they create tables,
 * they do not purge. Not caught: a table name assembled at run time
 * (`delete from pilot.${table}`); the script's own loops are the only ones.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = 'apps/web/scripts/pilot-cleanup-deleted-data.mjs';
const SCANNED_ROOTS = ['apps', 'packages', 'scripts'];
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'build', 'out']);
const SOURCE = /\.(?:[cm]?[jt]sx?|ps1|py|sh)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const HARD_DELETE =
  /\b(?:delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:"?pilot"?\s*\.\s*)?"?(?:athletes|video_sessions)"?(?![\w"])/gi;

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(full));
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments replaced by spaces, newlines kept, so a match keeps its line number. */
function withoutComments(text: string, file: string): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, ' ');
  if (/\.(?:ps1|py|sh)$/.test(file)) return text.replace(/(^|\s)#[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\w])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function hardDeletesIn(text: string, file = 'x.ts'): number[] {
  const code = withoutComments(text, file);
  return [...code.matchAll(HARD_DELETE)].map((match) => code.slice(0, match.index).split('\n').length);
}

describe('the retention purge has one source', () => {
  test('no source but the cleanup script hard-deletes an athlete or a video row', () => {
    const found: string[] = [];
    let scanned = 0;
    const files = SCANNED_ROOTS.flatMap((root) =>
      fs.existsSync(path.join(REPO_ROOT, root)) ? sourcesUnder(path.join(REPO_ROOT, root)) : [],
    );
    for (const entry of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
      if (entry.isFile() && SOURCE.test(entry.name)) files.push(path.join(REPO_ROOT, entry.name));
    }
    for (const file of files) {
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      scanned += 1;
      if (relative === SCRIPT) continue;
      for (const line of hardDeletesIn(fs.readFileSync(file, 'utf8'), file)) found.push(`${relative}:${line}`);
    }
    expect(found).toEqual([]);
    // Not vacuous: the walk reached the app, the script and a package.
    expect(scanned).toBeGreaterThan(500);
    expect(files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))).toEqual(
      expect.arrayContaining([SCRIPT, 'apps/web/src/server/pilot/dataDeletion.ts']),
    );
  });

  test('the scan sees the statements it is looking for (not vacuous)', () => {
    // The script's own two deletes, athletes and video rows.
    expect(hardDeletesIn(fs.readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8')).length).toBeGreaterThanOrEqual(2);
    for (const statement of [
      "q('delete from pilot.athletes where organization_id = $1')",
      'q(`delete from pilot.athletes ath using x`)',
      'q("DELETE FROM athletes")',
      'q(`truncate table pilot.athletes`)',
      'q(`delete from only "pilot"."athletes"`)',
      "q('delete from pilot.video_sessions where video_session_id = $1')",
      '/* note */ q(`delete from pilot.athletes`)',
    ]) {
      expect(hardDeletesIn(statement)).toEqual([1]);
    }
    // Across lines, reported at the line the statement starts on.
    expect(hardDeletesIn('const a = 1;\nawait q(`delete\n  from\n  pilot.athletes\n  where x`);')).toEqual([2]);
    expect(hardDeletesIn('Invoke-Sql "delete from pilot.athletes"', 'x.ps1')).toEqual([1]);
    for (const other of [
      'q(`delete from pilot.athletes_archive`)',
      'q(`delete from pilot.athlete_goals`)',
      '// delete from pilot.athletes',
      '/* a bare `delete from pilot.athletes`\n   relies on cascades */',
      '/**\n * delete from pilot.video_sessions\n */',
    ]) {
      expect(hardDeletesIn(other)).toEqual([]);
    }
    expect(hardDeletesIn('# delete from pilot.athletes', 'x.py')).toEqual([]);
  });

  test("the cleanup script deletes a purged athlete's videos and portrait with the rows", () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8');
    // The files to delete are the athlete's videos and their login's portrait...
    expect(script).toMatch(/\.\.\.videoPaths\.map\(\(blobPath\) => \[VIDEO_CONTAINER, blobPath\]\)/);
    expect(script).toMatch(/\.\.\.portraitPaths\.map\(\(blobPath\) => \[PROFILE_CONTAINER, blobPath\]\)/);
    // ...deleted from storage when the run applies...
    expect(script).toMatch(/await blobStore\.deleteIfExists\(container, blobPath\)/);
    // ...and with no storage, the athlete is not purged at all.
    expect(script).toMatch(/if \(!blobStore\) throw new StorageRefusal\('STORAGE_CREDENTIAL_MISSING'\)/);
    // In the same place as the athlete delete: after it, before the athlete's savepoint is released.
    const athleteDelete = script.indexOf("'delete from pilot.athletes where organization_id = $1 and athlete_id = $2");
    const fileDelete = script.indexOf('await blobStore.deleteIfExists(container, blobPath)');
    const release = script.indexOf('release savepoint purge_athlete', fileDelete);
    expect(athleteDelete).toBeGreaterThan(0);
    expect(fileDelete).toBeGreaterThan(athleteDelete);
    expect(release).toBeGreaterThan(fileDelete);
  });
});
