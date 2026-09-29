import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A PLATE FOR A NON-TRAINING ROOM IS NOT ASKED FOR A BOXING RING.
 *
 * OD-2026-09-28-009 item 5: the "ring and bags in every plate" DNA in
 * docs/REAL-GYM-REFERENCE-LOCK.md applies to training rooms only; other rooms
 * follow docs/ROOM-MAP.md. Before scripts/make-plate.mjs took --room, every
 * prompt carried the lock's whole DNA table, so a front-desk or clinic plate
 * was asked for the ring canvas, the corner posts and the bag frames.
 *
 * HOW THIS RUNS THE SCRIPT. make-plate.mjs does its work at module top level
 * (argument parsing, process.exit) and jest here transforms only .ts/.tsx, so
 * it cannot be imported. It is run as a child process with --dry-run, which
 * prints the prompt and exits before the key check and before any network
 * call. AZ_AI_KEY is removed from the child's environment as well, so even a
 * dry-run that stopped being honoured would stop at the key check rather than
 * post anything. PPBF_GYM_REFERENCE points at an empty directory: the
 * references are two committed plates, found in the plate library.
 *
 * What this proves is the PROMPT. Whether an image model obeys it is only
 * known by opening the plate it makes.
 */

const REPO = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO, 'scripts/make-plate.mjs');

const emptyReference = mkdtempSync(path.join(tmpdir(), 'ppbf-plate-ref-'));
afterAll(() => rmSync(emptyReference, { recursive: true, force: true }));

const DEFAULT_REFS = ['plate-10-floor-landscape-01.jpg', 'plate-11-floor-portrait-01.jpg'];

function run(extra: string[], refs: string[] = DEFAULT_REFS): { status: number; output: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PPBF_GYM_REFERENCE: emptyReference };
  delete env.AZ_AI_KEY;
  const args = [
    SCRIPT,
    '--out', 'plate-99-test-landscape-01.jpg',
    ...refs.flatMap((ref) => ['--ref', ref]),
    '--subject', 'a test subject',
    '--dry-run',
    ...extra,
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    stderr: result.stderr ?? '',
  };
}

function promptOf(output: string): string {
  const at = output.indexOf('PROMPT:\n');
  expect(at).toBeGreaterThan(-1);
  return output.slice(at + 'PROMPT:\n'.length);
}

/* The room list, as the script reads it from docs/ROOM-MAP.md: an unknown
   --room prints it, grouped. */
const listing = run(['--room', 'no-such-room']);
function slugsOn(label: string): string[] {
  const line = listing.output.split(/\r?\n/).find((l) => l.trim().startsWith(`${label}:`));
  return line ? line.split(':')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}
const trainingRooms = slugsOn('training rooms');
const otherRooms = slugsOn('other rooms');

/* The lock rows a non-training plate is not given: the training floor, and
   Extras, the gym's subject (glove shelving, treadmills, lockers, fight posters,
   a banner). Named here so a change to what a non-training plate is given shows
   up as a test change. */
const TRAINING_FLOOR_ROWS = ['Ring canvas:', 'Ring corners:', 'Floors:', 'Structure:', 'Bags:', 'Extras:'];
const BUILDING_ROWS = ['Ceiling:', 'Walls:', 'Light:', 'Atmosphere:'];

describe('make-plate --room', () => {
  jest.setTimeout(60_000);

  it('refuses a missing or unknown room and lists the rooms of the room map', () => {
    expect(listing.status).toBe(2);
    expect(listing.output).toContain('unknown --room no-such-room');

    const missing = run([]);
    expect(missing.status).toBe(2);
    expect(missing.output).toContain('need --room');
    expect(missing.output).not.toContain('PROMPT:');
  });

  it('reads the training rooms from the room map: the four on "The training side"', () => {
    /* Pinned on purpose: moving a room onto or off the training side changes
       what its plates are asked for, and that should be a visible change. */
    expect([...trainingRooms].sort()).toEqual(['drill-cabinet', 'film-room', 'floor', 'locker']);
    expect(otherRooms).toEqual(expect.arrayContaining([
      'bell', 'front-desk', 'family-room', 'clinic', 'file-room', 'board-room',
      'coachs-office', 'after-hours', 'workshop',
    ]));
    expect(otherRooms.length).toBeGreaterThanOrEqual(10);
  });

  it.each(trainingRooms.map((slug) => [slug]))('%s keeps the whole DNA and the IRON CITY exception', (slug) => {
    const result = run(['--room', slug]);
    expect(result.status).toBe(0);
    const prompt = promptOf(result.output);
    for (const row of [...TRAINING_FLOOR_ROWS, ...BUILDING_ROWS]) {
      expect(prompt).toContain(row);
    }
    expect(prompt).toContain('IRON CITY BREWERY, and only when the ring is in frame');
    expect(prompt).not.toContain('This room is not the training floor');
  });

  it.each(otherRooms.map((slug) => [slug]))('%s gets only the building rows and no lettering exception', (slug) => {
    const result = run(['--room', slug]);
    expect(result.status).toBe(0);
    const prompt = promptOf(result.output);
    for (const row of TRAINING_FLOOR_ROWS) {
      expect(prompt).not.toContain(row);
    }
    for (const row of BUILDING_ROWS) {
      expect(prompt).toContain(row);
    }
    expect(prompt).toContain('This room is not the training floor: no boxing ring, no punching bags, no training mats.');
    expect(prompt).toContain('ABSOLUTELY NO TEXT anywhere in the frame');
    expect(prompt).not.toContain('IRON CITY');
    expect(result.output).toContain(`room: ${slug} `);
    expect(result.output).toContain('left out, not a training room: Ring canvas, Ring corners, Floors, Structure, Bags, Extras');
    /* The prompt's own zero-lettering line is not contradicted by a kept row
       asking for posters, a banner or whiteboards. */
    expect(prompt).not.toMatch(/fight posters|Infantry Division banner|whiteboards of handwritten/);
  });

  it('warns when a non-training room is given a reference named for the ring, a bag or a mat', () => {
    const refs = ['plate-10-floor-landscape-01.jpg', 'plate-02b-floor-portrait-ring-01.jpg'];
    const offFloor = run(['--room', 'front-desk'], refs);
    expect(offFloor.status).toBe(0);
    expect(offFloor.stderr).toContain('WARNING: --ref plate-02b-floor-portrait-ring-01.jpg is named for a ring, a bag or a mat');
    expect(offFloor.stderr).not.toContain('plate-10-floor-landscape-01.jpg');

    const onFloor = run(['--room', 'floor'], refs);
    expect(onFloor.status).toBe(0);
    expect(onFloor.stderr).not.toContain('WARNING');
  });

  it.each([['family-room'], ['window']])('%s prints the T7 note (warm ground or no plate)', (slug) => {
    const result = run(['--room', slug]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`NOTE: ${slug} falls under T7`);
  });

  it('prints no T7 note for a room outside it', () => {
    expect(run(['--room', 'workshop']).stderr).not.toContain('T7');
  });
});
