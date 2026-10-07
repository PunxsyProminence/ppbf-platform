// The pure half of bodyPoints.ts, and the one line the whole module exists to
// hold: nothing but this module reads the body-point tables.
//
// Everything that touches the database is in
// calibrationBodyPointsModule.pg.test.ts against a real Postgres.

import fs from 'node:fs';
import path from 'node:path';

import { AnnotationSetSubmittedError } from './annotations';
import { resolveMomentTiming, translateDatabaseRefusal } from './bodyPoints';

const PUNCH_WITH_CONTACT = { event_class: 'punch', start_ms: 1_000, end_ms: 1_400, contact_ms: 1_250 };
const MISSED_PUNCH = { event_class: 'punch', start_ms: 1_000, end_ms: 1_400, contact_ms: null };
const DEFENSE = { event_class: 'defense', start_ms: 1_000, end_ms: 1_400, contact_ms: null };
const DEFENSE_WITH_CONTACT = { event_class: 'defense', start_ms: 1_000, end_ms: 1_400, contact_ms: 1_300 };

describe('resolveMomentTiming: the server says when a moment is', () => {
  test('start and end are the event\'s own edges', () => {
    expect(resolveMomentTiming(PUNCH_WITH_CONTACT, 'start', undefined)).toEqual({ momentKind: 'start', observationMs: 1_000 });
    expect(resolveMomentTiming(PUNCH_WITH_CONTACT, 'end', null)).toEqual({ momentKind: 'end', observationMs: 1_400 });
  });

  test('a time sent for start or end is refused, not ignored', () => {
    expect(() => resolveMomentTiming(PUNCH_WITH_CONTACT, 'start', 1_000)).toThrow('Missing observation_ms');
    expect(() => resolveMomentTiming(DEFENSE, 'end', 1_400)).toThrow('Missing observation_ms');
  });

  test('the middle is the contact time whenever the event has one, punch or defence', () => {
    expect(resolveMomentTiming(PUNCH_WITH_CONTACT, 'middle', undefined)).toEqual({ momentKind: 'contact', observationMs: 1_250 });
    expect(resolveMomentTiming(DEFENSE_WITH_CONTACT, 'middle', undefined)).toEqual({ momentKind: 'contact', observationMs: 1_300 });
    expect(() => resolveMomentTiming(PUNCH_WITH_CONTACT, 'middle', 1_250)).toThrow('do not send a time');
  });

  test('a missed punch takes a coach-picked full extension inside the event', () => {
    expect(resolveMomentTiming(MISSED_PUNCH, 'middle', 1_200)).toEqual({ momentKind: 'full_extension', observationMs: 1_200 });
    expect(resolveMomentTiming(MISSED_PUNCH, 'middle', 1_000)).toEqual({ momentKind: 'full_extension', observationMs: 1_000 });
    expect(() => resolveMomentTiming(MISSED_PUNCH, 'middle', undefined)).toThrow('full extension');
    expect(() => resolveMomentTiming(MISSED_PUNCH, 'middle', 999)).toThrow('within the event');
    expect(() => resolveMomentTiming(MISSED_PUNCH, 'middle', 1_401)).toThrow('within the event');
    expect(() => resolveMomentTiming(MISSED_PUNCH, 'middle', 1_200.5)).toThrow('Missing observation_ms');
  });

  test('a defence with no contact takes a coach-picked furthest point', () => {
    expect(resolveMomentTiming(DEFENSE, 'middle', 1_399)).toEqual({ momentKind: 'furthest_point', observationMs: 1_399 });
    expect(() => resolveMomentTiming(DEFENSE, 'middle', null)).toThrow('furthest point');
  });
});

describe('the database\'s refusals come back in the repo\'s shapes', () => {
  // The shape pg raises: message = the trigger's text, code = the SQLSTATE,
  // constraint = the constraint's name. Each branch is driven here because
  // the pg suite can reach only the ones a test can race.
  function pgError(message: string, code?: string, constraint?: string) {
    return Object.assign(new Error(message), { code, constraint });
  }
  function translated(error: unknown): { name: string; message: string; status?: number; code?: string } {
    try {
      translateDatabaseRefusal(error);
    } catch (thrown) {
      const e = thrown as { name: string; message: string; status?: number; code?: string };
      return { name: e.name, message: e.message, status: e.status, code: e.code };
    }
    throw new Error('did not throw');
  }

  test('a submission that won the race is the submitted refusal', () => {
    expect(translated(pgError('CALIBRATION_ANNOTATION_SET_SUBMITTED', 'P0001'))).toMatchObject({ name: AnnotationSetSubmittedError.name });
  });

  test('the version gate and the version\'s point list', () => {
    expect(translated(pgError('CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION', '23514'))).toMatchObject({ status: 403, message: expect.stringMatching(/^Forbidden/) });
    expect(translated(pgError('CALIBRATION_BODY_POINT_NOT_IN_THIS_VERSION', '23514'))).toMatchObject({ message: expect.stringMatching(/^Missing point_code/) });
  });

  test('an event changed under a moment, an occupied slot, a deadlock: 409', () => {
    expect(translated(pgError('CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT', '23514'))).toMatchObject({ status: 409, code: 'CALIBRATION_BODY_MOMENT_EVENT_CHANGED' });
    expect(translated(pgError('duplicate key value', '23505', 'pilot_calibration_body_moments_one_per_slot'))).toMatchObject({ status: 409, code: 'CALIBRATION_BODY_MOMENT_SLOT_TAKEN' });
    expect(translated(pgError('deadlock detected', '40P01'))).toMatchObject({ status: 409, code: 'CALIBRATION_BODY_POINTS_WRITE_RACE' });
    expect(translated(pgError('could not serialize access', '40001'))).toMatchObject({ status: 409, code: 'CALIBRATION_BODY_POINTS_WRITE_RACE' });
  });

  test('a parent deleted under a write is Not found', () => {
    for (const constraint of [
      'pilot_calibration_body_moments_event_fk',
      'pilot_calibration_event_stance_labels_event_fk',
      'pilot_calibration_body_points_moment_fk',
    ]) {
      expect(translated(pgError('violates foreign key', '23503', constraint))).toMatchObject({ message: expect.stringMatching(/^Not found/) });
    }
  });

  test('anything else is rethrown as it came, for jsonError to hide', () => {
    const raw = pgError('connection to server at 10.0.0.1 lost', '08006');
    expect(() => translateDatabaseRefusal(raw)).toThrow(raw);
    const otherKey = pgError('duplicate key value', '23505', 'pilot_calibration_body_moments_pkey');
    expect(() => translateDatabaseRefusal(otherKey)).toThrow(otherKey);
    const otherFk = pgError('violates foreign key', '23503', 'pilot_calibration_body_moments_set_fk');
    expect(() => translateDatabaseRefusal(otherFk)).toThrow(otherFk);
  });
});

describe('only bodyPoints.ts reads the body-point tables, and only its routes read bodyPoints.ts', () => {
  // Two lines, so body points cannot become an input to gold.ts, an export or
  // a model without a change that shows up here: no runtime file but this
  // module names the three tables (migrations, their runners and tests may),
  // and no runtime file but the body-points routes imports the module.
  //
  // ONE EXCEPTION, held to one name: the events route imports
  // eventHoldsBodyMarks, a yes-or-no on whether an event holds a moment or a
  // stance type, so that replacing an event cannot delete its marks by
  // cascade. It may import nothing else from the module, and it still may not
  // name the tables.
  const TABLES = ['calibration_body_moments', 'calibration_body_points', 'calibration_event_stance_labels'];
  const MAY_NAME_TABLES = new Set([
    'apps/web/src/server/pilot/calibration/bodyPoints.ts',
    // A comment naming the stance-label table; it holds no SQL.
    'apps/web/src/server/pilot/calibration/ontology.ts',
    'apps/web/scripts/pilot-apply-calibration-body-points-migration.mjs',
    'apps/web/scripts/pilot-apply-calibration-body-point-rules-migration.mjs',
  ]);
  const MAY_IMPORT_MODULE = /^apps\/web\/app\/api\/pilot\/calibration\/body-points\//;
  const EVENTS_ROUTE = 'apps/web/app/api/pilot/calibration/events/route.ts';
  const IMPORTS_MODULE = /from\s+['"](?:@\/src\/server\/pilot\/calibration\/bodyPoints|\.{1,2}\/(?:calibration\/)?bodyPoints)['"]/;

  function walk(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) out.push(full);
    }
  }

  const repoRoot = path.resolve(__dirname, '../../../../../..');
  const files: string[] = [];
  walk(path.join(repoRoot, 'apps', 'web'), files);
  walk(path.join(repoRoot, 'packages'), files);
  const relative = (file: string) => path.relative(repoRoot, file).replaceAll('\\', '/');

  test('the walk covers the app', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map(relative)).toContain('apps/web/src/server/pilot/calibration/gold.ts');
  });

  test('no other runtime file names the tables', () => {
    const offenders = files
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return TABLES.some((table) => text.includes(table));
      })
      .map(relative)
      .filter((file) => !MAY_NAME_TABLES.has(file));
    expect(offenders).toEqual([]);
  });

  test('no runtime file outside the body-points routes imports the module, the events route apart', () => {
    const offenders = files
      .filter((file) => IMPORTS_MODULE.test(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .filter((file) => !MAY_IMPORT_MODULE.test(file) && file !== EVENTS_ROUTE);
    expect(offenders).toEqual([]);
  });

  test('the events route takes one function from the module, the yes-or-no on marks, and nothing else', () => {
    const text = fs.readFileSync(path.join(repoRoot, EVENTS_ROUTE), 'utf8');
    const taken = [...text.matchAll(/import\s+([^;]*?)\s+from\s+['"][^'"]*\/bodyPoints['"]/g)]
      .map((match) => match[1].replace(/\s+/g, ' '));
    expect(taken).toEqual(['{ eventHoldsBodyMarks }']);
    // No other way in: no require() and no dynamic import() of the module.
    expect(text).not.toMatch(/(?:require|import)\s*\(\s*['"][^'"]*bodyPoints['"]/);
  });
});
