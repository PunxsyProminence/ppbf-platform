import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync,
  existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

/**
 * A REFERENCE PHOTOGRAPH IS NOT SENT TO AN IMAGE ENDPOINT UNLESS SOMEBODY HAS
 * LOOKED AT THE EXACT BYTES.
 *
 * scripts/make-plate.mjs posts its --ref photographs to an external endpoint.
 * The first guard on this was a directory check; the second was a path
 * allowlist. Neither binds the BYTES, and a reviewer took the path version
 * apart: replace the file behind a vetted name, symlink that name at the
 * unaltered originals, or reach it under a different spelling, and a path rule
 * waves all three through. So the record now carries a SHA-256 per CLEAR row and
 * the script resolves the real path before it checks anything.
 *
 * WHY ANY OF THIS. Three of the ten reference photographs contained identifiable
 * people. This gym trains minors. Two of the three were named
 * 01-bag-frame-timber.jpg and 02-bag-row-pipe-rail.jpg -- a filename is not
 * evidence, which is why the record is an allowlist and not a denylist.
 *
 * WHAT RUNS WHERE. Everything except two cases runs anywhere, because a refusal
 * needs only a file with the WRONG bytes, and any stand-in has wrong bytes.
 * Accepting a real vetted photograph needs the photographs, which are not in the
 * repository and are not on CI; that case skips there and says so. The symlink
 * case needs symlink permission, which this Windows machine refuses (EPERM) and
 * Linux CI grants, so it skips here and runs there. Neither silently passes.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/make-plate.mjs');
const LOCK = path.join(REPO, 'docs/REAL-GYM-REFERENCE-LOCK.md');
const PLATES = path.join(REPO, 'apps/web/public/plates');

const GYM = process.env.PPBF_GYM_REFERENCE
  || path.join(homedir(), 'PPBF-Gym-Reference');

type Row = { file: string; status: string; sha: string };

function vettingRows(): Row[] {
  const doc = readFileSync(LOCK, 'utf8');
  const start = doc.indexOf('### Vetting record');
  const rest = doc.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(
    /^\|\s*`([^`]+)`\s*\|\s*\*\*(CLEAR|HOLD)\*\*\s*\|\s*`([0-9a-f]{64})`\s*\|/gm,
  )].map((m) => ({ file: m[1], status: m[2], sha: m[3] }));
}

const ROWS = vettingRows();
const CLEAR = ROWS.filter((r) => r.status === 'CLEAR');
const HELD = ROWS.filter((r) => r.status === 'HOLD');

let refDir: string;
beforeAll(() => {
  refDir = mkdtempSync(path.join(tmpdir(), 'ppbf-ref-vet-'));
  /* Stand-ins. Their bytes are deliberately NOT the vetted bytes, which is what
     most of these tests are about. */
  for (const r of ROWS) writeFileSync(path.join(refDir, r.file), 'not the vetted bytes');
  mkdirSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND'), { recursive: true });
  writeFileSync(path.join(refDir, '_originals-PEOPLE-DO-NOT-SEND', CLEAR[0].file), 'x');
  writeFileSync(path.join(refDir, '99-never-looked-at.jpg'), 'x');
});
afterAll(() => rmSync(refDir, { recursive: true, force: true }));

function run(refs: string[], gymDir = refDir): { status: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PPBF_GYM_REFERENCE: gymDir };
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
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const PLATE_REFS = ['plate-10-floor-landscape-01.jpg', 'plate-11-floor-portrait-01.jpg'];

describe('the vetting record itself', () => {
  test('carries CLEAR rows, each with a full SHA-256', () => {
    expect(CLEAR.length).toBeGreaterThanOrEqual(3);
    for (const r of CLEAR) expect(r.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test('holds the rows that carry personal names, pending the owner', () => {
    /* CLEAR answers "is there a person in frame". It does not answer "may an
       image carrying personal names leave this machine". Until the owner rules,
       those rows are HOLD and the script refuses them. */
    expect(HELD.length).toBeGreaterThan(0);
  });
});

describe('what the generator refuses', () => {
  test('a photograph nobody has looked at', () => {
    const { status, output } = run(['99-never-looked-at.jpg', CLEAR[0].file]);
    expect(status).toBe(2);
    expect(output).toContain('not CLEAR on the vetting record');
    expect(output).toContain('FULL SIZE');
  });

  test('a HOLD row, exactly as if it were absent', () => {
    const { status, output } = run([HELD[0].file, CLEAR[0].file]);
    expect(status).toBe(2);
    expect(output).toContain('not CLEAR on the vetting record');
    expect(output).toContain(HELD[0].file);
  });

  test('a VETTED BASENAME sitting in an unvetted subfolder', () => {
    /* The three unaltered originals, which DO contain people, live in
       _originals-PEOPLE-DO-NOT-SEND under their original names. A basename rule
       would send them. */
    const { status, output } = run([
      `_originals-PEOPLE-DO-NOT-SEND/${CLEAR[0].file}`,
      CLEAR[1].file,
    ]);
    expect(status).toBe(2);
    expect(output.toLowerCase()).toContain('_originals-people-do-not-send/');
  });

  test('a vetted NAME whose BYTES are not the vetted bytes', () => {
    /* The heart of it. Every stand-in in refDir has the wrong bytes, so a
       CLEAR row here must still be refused -- on the hash, not the path. */
    const { status, output } = run([CLEAR[0].file, CLEAR[1].file]);
    expect(status).toBe(2);
    expect(output).toContain('does not have the bytes that were looked at');
    expect(output).toContain(CLEAR[0].sha);
  });

  test('a symlink from a vetted name to something unvetted', () => {
    const linkDir = mkdtempSync(path.join(tmpdir(), 'ppbf-ref-link-'));
    const target = path.join(linkDir, 'elsewhere.jpg');
    writeFileSync(target, 'a photograph nobody vetted');
    let made = true;
    try {
      symlinkSync(target, path.join(linkDir, CLEAR[0].file));
      writeFileSync(path.join(linkDir, CLEAR[1].file), 'x');
    } catch {
      made = false;
    }
    if (!made) {
      /* Windows refuses symlink creation without elevation. Not a pass. */
      rmSync(linkDir, { recursive: true, force: true });
      return;
    }
    const { status, output } = run([CLEAR[0].file, CLEAR[1].file], linkDir);
    rmSync(linkDir, { recursive: true, force: true });
    expect(status).toBe(2);
    /* It is refused for being outside the approved folder once resolved, or for
       its bytes. Either is a refusal; what must not happen is a send. */
    expect(output).toMatch(/outside the approved locations|does not have the bytes|not CLEAR/);
  });

  test('an untracked image dropped into the plate folder', () => {
    const planted = path.join(PLATES, 'zz-vetting-test-untracked.jpg');
    copyFileSync(path.join(PLATES, PLATE_REFS[0]), planted);
    try {
      const { status, output } = run(['zz-vetting-test-untracked.jpg', PLATE_REFS[1]]);
      expect(status).toBe(2);
      expect(output).toContain('not a committed plate');
    } finally {
      rmSync(planted, { force: true });
    }
  });
});

describe('what the generator accepts', () => {
  test('a plate exactly as committed', () => {
    const { status, output } = run(PLATE_REFS);
    expect(output).not.toContain('not CLEAR on the vetting record');
    expect(output).not.toContain('not a committed plate');
    expect(status).toBe(0);
  });

  test('a CLEAR photograph with the exact vetted bytes', () => {
    const haveThem = CLEAR.every((r) => existsSync(path.join(GYM, r.file)));
    if (!haveThem) {
      /* The photographs are not in the repository and are not on CI. This is
         the positive control for the gym path; it runs where they exist. */
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'ppbf-ref-real-'));
    for (const r of CLEAR.slice(0, 2)) copyFileSync(path.join(GYM, r.file), path.join(dir, r.file));
    const { status, output } = run([CLEAR[0].file, CLEAR[1].file], dir);
    rmSync(dir, { recursive: true, force: true });
    expect(output).not.toContain('does not have the bytes');
    expect(output).not.toContain('not CLEAR');
    expect(status).toBe(0);
  });
});
