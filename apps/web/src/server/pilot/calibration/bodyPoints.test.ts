// The pure half of bodyPoints.ts, and the one line the whole module exists to
// hold: nothing but this module reads the body-point tables.
//
// Everything that touches the database is in
// calibrationBodyPointsModule.pg.test.ts against a real Postgres.

import fs from 'node:fs';
import path from 'node:path';

import { resolveMomentTiming } from './bodyPoints';

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

describe('only bodyPoints.ts reads the body-point tables', () => {
  // Migrations, their runners and their tests may name the tables; runtime
  // code may not, so body points cannot become an input to gold.ts, an
  // export or a model without a change that shows up here.
  const TABLES = ['calibration_body_moments', 'calibration_body_points', 'calibration_event_stance_labels'];
  const ALLOWED = new Set([
    'src/server/pilot/calibration/bodyPoints.ts',
    'src/server/pilot/calibration/ontology.ts',
    'scripts/pilot-apply-calibration-body-points-migration.mjs',
    'scripts/pilot-apply-calibration-body-point-rules-migration.mjs',
  ]);

  function walk(dir: string, out: string[]): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  }

  test('no other runtime file names them', () => {
    const webRoot = path.resolve(__dirname, '../../../..');
    const files: string[] = [];
    walk(path.join(webRoot, 'src'), files);
    walk(path.join(webRoot, 'app'), files);
    walk(path.join(webRoot, 'scripts'), files);
    const offenders = files
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return TABLES.some((table) => text.includes(table));
      })
      .map((file) => path.relative(webRoot, file).replaceAll('\\', '/'))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });
});
