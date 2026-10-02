import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * SOMEBODY OPENS A PHOTOGRAPH BEFORE IT GOES TO AN IMAGE ENDPOINT.
 *
 * scripts/make-plate.mjs sends its --ref photographs out. Three of the ten in
 * the owner's reference folder contained identifiable people, and this gym
 * trains minors. Two of the three were called 01-bag-frame-timber.jpg and
 * 02-bag-row-pipe-rail.jpg -- a filename is not evidence, which is why the lock
 * holds a list of what was looked at rather than a list of suspicious names.
 *
 * WHAT THIS IS NOT. An earlier version bound each row to a SHA-256, resolved
 * symlinks and checked plates against git, with tests for each. The owner called
 * drift on it and was right: the LOOKING caught all three photographs, the
 * machinery caught one duplicate filename, and the symlink and git checks caught
 * nothing. The photographs themselves are now clean, which is what actually
 * protects anyone -- they are safe by any route, not only through this script.
 * What is left is the smallest rule that catches the real failure: a photograph
 * nobody has opened does not go.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/make-plate.mjs');
const LOCK = path.join(REPO, 'docs/REAL-GYM-REFERENCE-LOCK.md');

function listedPhotographs(): string[] {
  const doc = readFileSync(LOCK, 'utf8');
  const start = doc.indexOf('### Reference photographs: looked at');
  const rest = doc.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]);
}

const LISTED = listedPhotographs();

let refDir: string;
beforeAll(() => {
  refDir = mkdtempSync(path.join(tmpdir(), 'ppbf-ref-'));
  for (const f of LISTED) writeFileSync(path.join(refDir, f), 'stand-in');
  mkdirSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND'), { recursive: true });
  writeFileSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND', LISTED[0]), 'x');
  writeFileSync(path.join(refDir, '99-never-opened.jpg'), 'x');
});
afterAll(() => rmSync(refDir, { recursive: true, force: true }));

function run(refs: string[]): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PPBF_GYM_REFERENCE: refDir };
  delete env.AZ_AI_KEY;
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--out', 'plate-99-test-landscape-01.jpg',
      '--room', 'floor',
      ...refs.flatMap((x) => ['--ref', x]),
      '--subject', 'a test subject',
      '--dry-run',
    ],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('make-plate reference list', () => {
  test('the lock lists the photographs that were opened', () => {
    expect(LISTED.length).toBeGreaterThanOrEqual(10);
    expect(LISTED).toContain('01-bag-frame-timber.jpg');
  });

  test('a photograph nobody has opened is refused', () => {
    const { status, output } = run(['99-never-opened.jpg', LISTED[1]]);
    expect(status).toBe(2);
    expect(output).toContain('not on the list');
    /* The message has to say what to do, or it just gets worked around. */
    expect(output).toContain('full size');
  });

  test('the unaltered originals are refused, under their original names', () => {
    /* They sit in a subfolder keeping the names they always had, so this is
       about the path and not the filename. */
    const { status } = run([`_originals-PEOPLE-DO-NOT-SEND/${LISTED[0]}`, LISTED[1]]);
    expect(status).toBe(2);
  });

  test('a listed photograph is accepted', () => {
    const { status, output } = run([LISTED[0], LISTED[1]]);
    expect(output).not.toContain('not on the list');
    expect(status).toBe(0);
  });

  test('plates are not photographs of anyone, and stay exempt', () => {
    const { status, output } = run([
      'plate-10-floor-landscape-01.jpg',
      'plate-11-floor-portrait-01.jpg',
    ]);
    expect(output).not.toContain('not on the list');
    expect(status).toBe(0);
  });
});
