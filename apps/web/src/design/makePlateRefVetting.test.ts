import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A REFERENCE PHOTOGRAPH IS NOT SENT TO AN IMAGE ENDPOINT UNTIL A HUMAN HAS
 * OPENED IT.
 *
 * scripts/make-plate.mjs posts its --ref photographs to an external endpoint.
 * Until 2026-10-02 the only guard on what went out was a check that the file
 * sat in an approved DIRECTORY. A directory check is not a content check, and
 * the script's own usage example named 06-flag-and-mirror-wall.jpg, which has a
 * person reflected in its mirror. This gym trains minors.
 *
 * A FILENAME IS NOT EVIDENCE, which is the reason the guard is keyed the way it
 * is. Of the three photographs found to contain identifiable people, two were
 * called 01-bag-frame-timber.jpg and 02-bag-row-pipe-rail.jpg -- names that read
 * as pure equipment shots. Any rule keyed on names would have passed both.
 *
 * The record of who has looked lives in docs/REAL-GYM-REFERENCE-LOCK.md, not
 * here, so there is one list and it is the one a human maintains. These tests
 * pin the three properties that make it worth having: it fails CLOSED, it is
 * keyed on the RELATIVE PATH rather than the basename, and it does not reach
 * the committed plate library.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/make-plate.mjs');
const LOCK = path.join(REPO, 'docs/REAL-GYM-REFERENCE-LOCK.md');

/* A vetted name, taken from the lock itself rather than hardcoded, so this test
   cannot drift from the record it is checking. */
function clearRows(): string[] {
  const doc = readFileSync(LOCK, 'utf8');
  const start = doc.indexOf('### Vetting record');
  const rest = doc.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*CLEAR\s*\|/gm)].map((m) => m[1]);
}

const VETTED = clearRows();

let refDir: string;
beforeAll(() => {
  refDir = mkdtempSync(path.join(tmpdir(), 'ppbf-ref-vet-'));
  /* Stand-ins, not photographs. resolveRef checks existence and extension; the
     bytes are never read on a --dry-run, which exits before any request. */
  for (const name of VETTED) writeFileSync(path.join(refDir, name), 'x');
  mkdirSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND'), { recursive: true });
  writeFileSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND', VETTED[0]), 'x');
  writeFileSync(path.join(refDir, '99-never-looked-at.jpg'), 'x');
});
afterAll(() => rmSync(refDir, { recursive: true, force: true }));

function run(refs: string[]): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PPBF_GYM_REFERENCE: refDir };
  delete env.AZ_AI_KEY;
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--out', 'plate-99-test-landscape-01.jpg',
      '--room', 'floor',
      ...refs.flatMap((r) => ['--ref', r]),
      '--subject', 'a test subject',
      '--dry-run',
    ],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('make-plate reference vetting', () => {
  test('the lock carries a vetting record with CLEAR rows', () => {
    /* If this fails the table was reshaped and the generator will throw rather
       than silently stop checking. */
    expect(VETTED.length).toBeGreaterThanOrEqual(10);
    expect(VETTED).toContain('01-bag-frame-timber.jpg');
    expect(VETTED).toContain('06-flag-and-mirror-wall.jpg');
  });

  test('a photograph nobody has looked at is REFUSED', () => {
    const { status, output } = run(['99-never-looked-at.jpg', VETTED[1]]);
    expect(status).toBe(2);
    expect(output).toContain('not on the vetting record');
    expect(output).toContain('99-never-looked-at.jpg');
    /* The message has to tell the next person what to do, or the guard just
       gets worked around. */
    expect(output).toContain('FULL SIZE');
    expect(output).toContain('REAL-GYM-REFERENCE-LOCK.md');
  });

  test('a VETTED BASENAME in an unvetted subfolder is REFUSED', () => {
    /* The three unaltered originals, which DO contain people, sit in
       _originals-PEOPLE-DO-NOT-SEND under their original names. A guard keyed on
       the basename would wave them straight through to the endpoint. This is the
       single most important case in this file. */
    const { status, output } = run([`_originals-PEOPLE-DO-NOT-SEND/${VETTED[0]}`, VETTED[1]]);
    expect(status).toBe(2);
    expect(output).toContain('not on the vetting record');
    expect(output.toLowerCase()).toContain('_originals-people-do-not-send/');
  });

  test('vetted photographs are accepted', () => {
    const { status, output } = run([VETTED[0], VETTED[1]]);
    expect(output).not.toContain('not on the vetting record');
    expect(status).toBe(0);
  });

  test('the committed plate library is not subject to the record', () => {
    /* Plates are committed and public; they are not photographs of the gym and
       there is nobody in them to protect. Requiring a vetting row for each would
       be a rule nobody could comply with. */
    const { status, output } = run([
      'plate-10-floor-landscape-01.jpg',
      'plate-11-floor-portrait-01.jpg',
    ]);
    expect(output).not.toContain('not on the vetting record');
    expect(status).toBe(0);
  });
});
