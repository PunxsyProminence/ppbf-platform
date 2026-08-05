import fs from 'node:fs';
import path from 'node:path';

/**
 * THE TWO PROPERTIES THAT ARE NOT ENFORCEABLE BY TYPES.
 *
 * 1. RECOGNITION CANNOT BE RANKED BETWEEN ATHLETES. A leaderboard between kids
 *    needs a comparable number per athlete. The defence is not a rule that
 *    somebody must remember -- it is that no query in this codebase computes
 *    one, and no route returns two athletes' achievements in a shape that could
 *    be sorted. A kid at the bottom of a visible list is a kid who quits, and
 *    the list only has to exist once for that to happen.
 *
 * 2. RECOGNITION CANNOT BECOME A BEHAVIOUR FILE. It is for catching people
 *    being good. The defences are structural: a closed positive vocabulary in
 *    two places, no severity or numeric column anywhere, no coach-private
 *    visibility, no edit, no delete, and a note capped short enough that it
 *    cannot be an incident report.
 *
 * Both are asserted against the SOURCE, because both fail silently. A
 * `group by athlete_id` added for a well-meant admin dashboard type-checks. A
 * check constraint widened with 'concern' type-checks. Neither breaks a build,
 * and both invert what this feature is.
 */

const repositoryRoot = path.resolve(__dirname, '../../../../..');

const modulePath = path.join(repositoryRoot, 'apps/web/src/server/pilot/achievements.ts');
const catalogPath = path.join(repositoryRoot, 'apps/web/src/shared/achievementPaths.ts');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_achievements_migration.sql',
);
const routeDir = path.join(repositoryRoot, 'apps/web/app/api/pilot/achievements');
const padPath = path.join(repositoryRoot, 'apps/web/components/CoachRecognitionPad.tsx');

const moduleSource = fs.readFileSync(modulePath, 'utf8');
const migration = fs.readFileSync(migrationPath, 'utf8');
const pad = fs.readFileSync(padPath, 'utf8');

/** Prose in this codebase DESCRIBES the shapes it refuses, so comments are stripped first. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/--[^\n]*/g, '');
}

function routeFiles(): string[] {
  return fs.readdirSync(routeDir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(routeDir, entry.name);
    if (entry.isDirectory()) {
      return fs.readdirSync(full)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => path.join(full, name));
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('recognition cannot be ranked between athletes', () => {
  const code = codeOnly(moduleSource);

  test('the guard is not vacuous', () => {
    // Every assertion below is a `not.toMatch` over a stripped file. If the
    // strip ate the file, all of them would pass while covering nothing.
    expect(code).toContain('export async function listRecognitionsForAthlete');
    expect(code).toContain('export async function createRecognition');
    expect(routeFiles().length).toBeGreaterThanOrEqual(3);
  });

  test('no query groups by, counts, or orders athletes', () => {
    expect(code).not.toMatch(/group\s+by\s+athlete_id/i);
    expect(code).not.toMatch(/count\s*\(\s*\*\s*\)[\s\S]{0,80}group\s+by/i);
    expect(code).not.toMatch(/order\s+by\s+count/i);
    expect(code).not.toMatch(/rank\s*\(\s*\)\s*over/i);
    expect(code).not.toMatch(/row_number\s*\(\s*\)\s*over/i);
    expect(code).not.toMatch(/dense_rank/i);
    // `athlete_id = any(...)` or `athlete_id in ($1, $2)` would be one query
    // returning several athletes' rows, which is the raw material of a
    // comparison even without an aggregate.
    expect(code).not.toMatch(/athlete_id\s*=\s*any/i);
    expect(code).not.toMatch(/athlete_id\s+in\s*\(/i);
  });

  test('every read of the recognition and milestone tables is scoped to one athlete', () => {
    // Each SELECT against these tables must carry `athlete_id = $n`. A read
    // without one returns the gym, and a read that returns the gym is a
    // leaderboard waiting for a sort.
    const selects = code.match(/select[\s\S]*?from\s+pilot\.(recognitions|athlete_milestones)[\s\S]*?(?=`)/gi) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const statement of selects) {
      expect(statement).toMatch(/athlete_id\s*=\s*\$\d/);
    }
  });

  test('the only exported recognition read takes exactly one athlete', () => {
    // Signature-level: a function that takes one athlete id cannot return two
    // athletes' rows, so a caller has nothing to line up.
    const exported = [...code.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    const recognitionReads = exported.filter((name) => /^list.*Recognition/i.test(name));
    expect(recognitionReads).toEqual(['listRecognitionsForAthlete']);

    expect(code).toMatch(
      /listRecognitionsForAthlete\(\s*organizationId: string,\s*athleteId: string,/,
    );
  });

  test('no route answers with more than one athlete\'s achievements', () => {
    for (const file of routeFiles()) {
      const source = codeOnly(fs.readFileSync(file, 'utf8'));
      // Every handler that reads resolves a single athlete_id and authorizes it.
      if (/export async function GET/.test(source)) {
        expect(source).toMatch(/athlete_id/);
        expect(source).toMatch(/assertActorCanAccessAthlete/);
      }
      expect(source).not.toMatch(/athlete_ids/);
      expect(source).not.toMatch(/leaderboard/i);
      expect(source).not.toMatch(/top_?\d/i);
    }
  });

  test('the coach pad shows no counts and sorts only by name', () => {
    const code_ = codeOnly(pad);
    // A roster annotated with "12 received" or "none in 3 weeks" is a
    // scoreboard the moment a kid looks over the coach's shoulder -- and a
    // prompt to top somebody up is a ranking with a kind face.
    expect(code_).not.toMatch(/localeCompare\((?!a\.full_name|b\.full_name)/);
    expect(code_).toMatch(/localeCompare/);
    expect(code_).not.toMatch(/recognition_count|received_count|last_recognized|needs_recognition/i);
    expect(code_).not.toMatch(/sort\(\(a, b\) => b\./);
  });

  test('no coach surface aggregates across athletes', () => {
    // Every coach panel works one athlete at a time. A whole-gym list is one
    // `sort` away from a ranking, and a ranking only has to be visible once for
    // a kid to find out they are at the bottom of it.
    for (const name of ['CoachMilestoneMarker.tsx', 'CoachMentorshipPairing.tsx']) {
      const source = codeOnly(fs.readFileSync(
        path.join(repositoryRoot, 'apps/web/components', name),
        'utf8',
      ));
      expect(source).toMatch(/athlete_id=|athlete_id:/);
      expect(source).not.toMatch(/\.length\s*\}/);
      expect(source).not.toMatch(/sort\(\(a, b\) => b\./);
      expect(source).not.toMatch(/reduce\(/);
      expect(source).not.toMatch(/leaderboard|ranking|top ?\d/i);
    }
  });

  test('the milestone award is unique per athlete, so no countable quantity accumulates', () => {
    expect(migration).toMatch(
      /primary key \(organization_id, athlete_id, milestone_key\)/i,
    );
    expect(codeOnly(moduleSource)).toMatch(
      /on conflict \(organization_id, athlete_id, milestone_key\) do nothing/i,
    );
  });

  test('no table carries a score, points, a rank or a weight', () => {
    const forbidden = /\b(score|points|rating|rank|tier|weight|ordinal|leaderboard)\b\s+(text|numeric|integer|int|bigint|real)/i;
    expect(codeOnly(migration)).not.toMatch(forbidden);
  });
});

describe('recognition cannot become a behaviour or disciplinary record', () => {
  const catalog = fs.readFileSync(catalogPath, 'utf8');

  test('the vocabulary is closed and positive in BOTH places', () => {
    // The TypeScript union gives the coach a sentence instead of SQLSTATE
    // 23514; the check constraint is the thing that cannot be bypassed. Both,
    // deliberately -- and a value added to one and not the other is caught by
    // the migration runner's readiness query.
    for (const kind of [
      'helped_someone', 'showed_up_hard_day', 'back_after_a_loss',
      'worked_when_it_was_hard', 'good_partner', 'took_the_correction',
      'in_early_and_ready', 'left_it_better', 'spoke_up_well',
      'looked_after_someone_new',
    ]) {
      expect(catalog).toContain(`'${kind}'`);
      expect(migration).toContain(`'${kind}'`);
    }

    const constraint = /pilot_recognitions_kind_check[\s\S]*?\)\);/.exec(migration)?.[0] ?? '';
    expect(constraint.length).toBeGreaterThan(100);
    for (const negative of ['concern', 'incident', 'warning', 'violation', 'discipline', 'behaviour', 'behavior']) {
      expect(constraint.toLowerCase()).not.toContain(negative);
    }
  });

  test('there is no severity, no rating and no numeric field to hold a judgement', () => {
    const table = /create table if not exists pilot\.recognitions[\s\S]*?\n\);/.exec(migration)?.[0] ?? '';
    expect(table).toContain('kind text not null');
    for (const column of ['severity', 'score', 'rating', 'points', 'level', 'flag']) {
      expect(table.toLowerCase()).not.toContain(`${column} `);
    }
  });

  test('the athlete always sees it — there is no coach-private recognition', () => {
    // A record whose subject reads every row of it cannot quietly become a file
    // kept on them. No visibility column, no draft state, no internal flag.
    const table = /create table if not exists pilot\.recognitions[\s\S]*?\n\);/.exec(migration)?.[0] ?? '';
    for (const column of ['visibility', 'private', 'internal', 'staff_only', 'hidden', 'draft']) {
      expect(table.toLowerCase()).not.toContain(column);
    }

    // And the athlete's own role is admitted to the read.
    const recognitionRoute = fs.readFileSync(
      path.join(routeDir, 'recognition/route.ts'),
      'utf8',
    );
    expect(recognitionRoute).toMatch(/RECOGNITION_READER_ROLES[\s\S]{0,160}'athlete'/);
  });

  test('nothing can be edited or withdrawn', () => {
    // A compliment that can be revoked is a lever. The route exposes no PATCH
    // and no DELETE, and the module exports no update or delete for either.
    const recognitionRoute = codeOnly(fs.readFileSync(path.join(routeDir, 'recognition/route.ts'), 'utf8'));
    expect(recognitionRoute).not.toMatch(/export async function (PATCH|DELETE|PUT)/);

    const code = codeOnly(moduleSource);
    expect(code).not.toMatch(/delete\s+from\s+pilot\.recognitions/i);
    expect(code).not.toMatch(/update\s+pilot\.recognitions/i);
    expect(code).not.toMatch(/delete\s+from\s+pilot\.athlete_milestones/i);
  });

  test('the note is capped short enough that it cannot be a report', () => {
    // Long enough for "best round you've had, kid" and far too short for an
    // incident write-up. Enforced in the database as well as the module, so a
    // future caller that skips the module still cannot write an essay.
    expect(migration).toMatch(/char_length\(note\) <= 140/);
    expect(fs.readFileSync(catalogPath, 'utf8')).toMatch(/RECOGNITION_NOTE_MAX = 140/);
  });

  test('the audit trail records that praise happened, never the words', () => {
    // Copying a coach's sentence into an operational log gives it a second life
    // in a surface the athlete never reads -- which is the shape of a file.
    const recognitionRoute = fs.readFileSync(path.join(routeDir, 'recognition/route.ts'), 'utf8');
    const details = /details: \{[^}]*\}/.exec(recognitionRoute)?.[0] ?? '';
    expect(details).toContain('kind');
    expect(details).not.toContain('note');
  });

  test('the signature cannot be forged', () => {
    // A name the sender supplies is a name any coach can put somebody else's
    // words under. It is derived server-side from the sender's own login.
    const recognitionRoute = codeOnly(fs.readFileSync(path.join(routeDir, 'recognition/route.ts'), 'utf8'));
    expect(recognitionRoute).toContain('getCoachDisplayName(principal.organizationId, principal.accountId)');
    expect(recognitionRoute).not.toMatch(/body\.coach_display_name/);
  });
});

describe('nothing in the achievement schema can punish an absence', () => {
  const sql = codeOnly(migration);

  test('no column can hold a streak, a cadence, a decay or an expiry', () => {
    for (const column of [
      'streak', 'consecutive', 'expires_at', 'expires', 'valid_until',
      'decay', 'last_seen', 'cadence', 'required_per_week', 'lapsed',
    ]) {
      expect(sql.toLowerCase()).not.toContain(`${column} `);
    }
  });

  test('nothing is ever removed on a schedule', () => {
    expect(sql).not.toMatch(/delete\s+from\s+pilot\.(athlete_milestones|recognitions)/i);
    expect(sql).not.toMatch(/on\s+delete\s+set\s+null/i);
  });

  test('a goal has no failed state and no overdue column', () => {
    // reached_at null means still working, which is the ordinary state of every
    // goal worth setting -- not a failure, and there is nowhere to record one.
    expect(sql).toMatch(/reached_at timestamptz null/);
    for (const column of ['failed_at', 'missed_at', 'overdue', 'abandoned']) {
      expect(sql.toLowerCase()).not.toContain(column);
    }
  });

  test('a goal is not forced to carry a deadline', () => {
    // "Show up on the days I don't want to" has no date, and a required one
    // turns a goal into something a calendar can fail.
    expect(sql).toMatch(/alter column target_date drop not null/i);
  });

  test('a closed mentorship records no outcome and no reason', () => {
    const table = /create table if not exists pilot\.mentorships[\s\S]*?\n\);/.exec(migration)?.[0] ?? '';
    expect(table).toContain('ended_on date null');
    for (const column of ['outcome', 'reason', 'result', 'success', 'failed']) {
      expect(table.toLowerCase()).not.toContain(column);
    }
  });

  test('the progression path is not derived from body data', () => {
    // pilot.athletes.gym_status is already classified as a record about a
    // person's body (wallDisplayPrivacy.test.ts). A progression read off it
    // would make a training path readable as a medical fact.
    const code = codeOnly(moduleSource);
    expect(code).not.toContain('gym_status');
    expect(code).not.toContain('weight_class');
    expect(sql).toMatch(/create table if not exists pilot\.athlete_programs/);
  });
});
