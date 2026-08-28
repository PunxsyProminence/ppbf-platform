import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The module under test is real ESM consumed by a workflow step, and the
// default jest runner has no ESM loader (`npm test` does not pass
// --experimental-vm-modules). As in check-migration-declaration.test.ts, every
// expression is evaluated in one real `node` child process.
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'check-evidence-applicability.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }));
}

/** A record that passes every rule, as the object shape evaluateRecord takes. */
const SOUND_FIELDS: Record<string, string> = {
  CLAIM: 'the drill-library route refuses the board role',
  PROPERTY: 'GET returns 403 for a board principal and the read never runs',
  INSTRUMENT: 'a jest case that calls GET with a board principal',
  SUBJECT: 'commit 57308b3eabc0ad6d380cf7f3afcc8ed4cf5cb167, build container',
  'EXECUTION PATH': 'app/api/pilot/drill-library/route.ts GET, through requireRole',
  'POSITIVE CONTROL': 'a coach principal receives 200 and the read runs',
  'NEGATIVE CONTROL': 'admitting board in the policy constant reds this case',
  'EVIDENCE LEVEL': 'UNIT',
  'BLIND SPOTS': 'says nothing about the deployed build',
  VERDICT: 'APPLICABLE',
};

/** Grade a record built from SOUND_FIELDS with the given fields overridden. */
function gradeWith(overrides: Record<string, string | null>): string[] {
  const fields: Record<string, string> = { ...SOUND_FIELDS };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete fields[name];
    else fields[name] = value;
  }
  return evaluate(
    `m.evaluateRecord({ label: 'r', line: 1, fields: ${JSON.stringify(fields)} })`,
  ).failures;
}

/** Render SOUND_FIELDS as a markdown record, with overrides applied. */
function recordText(overrides: Record<string, string> = {}, label = 'a claim'): string {
  const fields = { ...SOUND_FIELDS, ...overrides };
  return [
    `### EVIDENCE APPLICABILITY — ${label}`,
    '',
    ...Object.entries(fields).map(([name, value]) => `- ${name}: ${value}`),
    '',
  ].join('\n');
}

describe('finding records in a body', () => {
  it('reads a record out of surrounding prose', () => {
    const body = `Some prose above.\n\n${recordText()}\n---\n\nMore prose.`;
    const records = evaluate(`m.parseRecords(${JSON.stringify(body)})`);

    expect(records).toHaveLength(1);
    expect(records[0].label).toBe('a claim');
    expect(records[0].fields.VERDICT).toBe('APPLICABLE');
  });

  it('finds every record when a body carries more than one', () => {
    const body = `${recordText({}, 'first')}\n${recordText({}, 'second')}`;
    const records = evaluate(`m.parseRecords(${JSON.stringify(body)})`);

    expect(records.map((r: { label: string }) => r.label)).toEqual(['first', 'second']);
  });

  it('joins a value written over two lines', () => {
    const body = [
      '### EVIDENCE APPLICABILITY — wrapped',
      '- CLAIM: a claim long enough that somebody',
      '  wrapped it onto a second line',
      '- VERDICT: UNVERIFIED',
    ].join('\n');

    expect(evaluate(`m.parseRecords(${JSON.stringify(body)})`)[0].fields.CLAIM)
      .toBe('a claim long enough that somebody wrapped it onto a second line');
  });

  it('ignores a heading that names the contract but declares no field', () => {
    // This file, AGENT_KERNEL.md and the contract itself all say the words
    // constantly. A heading is not a record.
    const body = '## The Evidence Applicability Record\n\nProse about it.\n\n## Next';

    expect(evaluate(`m.parseRecords(${JSON.stringify(body)})`)).toEqual([]);
  });

  it('ignores the record block while it is still inside the template comment', () => {
    // The pull request template ships the block commented out. An author who
    // has not filled it in has declared nothing, and grading ten placeholders
    // would punish them for leaving the template alone.
    const template = fs.readFileSync(
      path.resolve(__dirname, '../../../.github/pull_request_template.md'),
      'utf8',
    );

    expect(template).toContain('EVIDENCE APPLICABILITY');
    expect(evaluate(`m.parseRecords(${JSON.stringify(template)})`)).toEqual([]);
  });

  it('accepts the aliases the contract prose uses for the same field', () => {
    const body = [
      '### EVIDENCE APPLICABILITY — aliased',
      '- SUBJECT SHA / ENVIRONMENT: staging',
      '- NEGATIVE CONTROL / MUTATION: removing the lock reds the case',
      '- KNOWN BLIND SPOTS: nothing observed in production',
    ].join('\n');
    const fields = evaluate(`m.parseRecords(${JSON.stringify(body)})`)[0].fields;

    expect(fields.SUBJECT).toBe('staging');
    expect(fields['NEGATIVE CONTROL']).toBe('removing the lock reds the case');
    expect(fields['BLIND SPOTS']).toBe('nothing observed in production');
  });

  it('leaves an underscore in a value alone', () => {
    // Markdown emphasis in theory, COACHING_CONTENT_READER_ROLES in practice.
    const body = recordText({ 'NEGATIVE CONTROL': 'admitting board in ROLE_LIST reds it' });

    expect(evaluate(`m.parseRecords(${JSON.stringify(body)})`)[0].fields['NEGATIVE CONTROL'])
      .toContain('ROLE_LIST');
  });
});

describe('a body with no record', () => {
  it('passes, because the check is opt-in', () => {
    const result = evaluate(`m.evaluate('Just an ordinary pull request body.')`);

    expect(result.ok).toBe(true);
    expect(result.records).toEqual([]);
  });

  it('passes for an empty body', () => {
    expect(evaluate('m.evaluate(null)').ok).toBe(true);
  });
});

describe('grading a record', () => {
  it('accepts one that answers every field', () => {
    expect(gradeWith({})).toEqual([]);
  });

  it.each([
    'CLAIM',
    'PROPERTY',
    'INSTRUMENT',
    'SUBJECT',
    'EXECUTION PATH',
    'POSITIVE CONTROL',
    'NEGATIVE CONTROL',
    'EVIDENCE LEVEL',
    'BLIND SPOTS',
    'VERDICT',
  ])('fails when %s is missing', (field) => {
    expect(gradeWith({ [field]: null }).join('\n')).toContain(`missing ${field}`);
  });

  it('fails a bare waiver and accepts the same waiver with its reason', () => {
    expect(gradeWith({ 'NEGATIVE CONTROL': 'none' }).join('\n'))
      .toContain('a waiver needs its reason');
    expect(gradeWith({ 'NEGATIVE CONTROL': 'N/A' })).toHaveLength(1);
    expect(gradeWith({
      'NEGATIVE CONTROL': 'none — a production version read has no mutation to make',
    })).toEqual([]);
  });

  it('fails placeholder text left over from the template', () => {
    expect(gradeWith({ CLAIM: '<short label>' })).toHaveLength(1);
    expect(gradeWith({ PROPERTY: '' })).toHaveLength(1);
  });

  it('does not demand a reason after NONE, which is a real rung', () => {
    // Otherwise the rule pushes a record toward claiming a level it lacks.
    expect(gradeWith({ 'EVIDENCE LEVEL': 'NONE', VERDICT: 'UNVERIFIED' })).toEqual([]);
  });

  it('rejects an evidence level outside the ladder', () => {
    expect(gradeWith({ 'EVIDENCE LEVEL': 'PROBABLY_FINE' }).join('\n'))
      .toContain('is not one of');
    expect(gradeWith({ 'EVIDENCE LEVEL': '' })).toHaveLength(1);
  });

  it('rejects a verdict that is a hedge', () => {
    expect(gradeWith({ VERDICT: 'likely' }).join('\n')).toContain('are not verdicts');
    expect(gradeWith({ VERDICT: 'PARTIAL' })).toEqual([]);
    expect(gradeWith({ VERDICT: 'RETRACTED' })).toEqual([]);
  });

  it('refuses APPLICABLE when nothing measured it', () => {
    expect(gradeWith({ 'EVIDENCE LEVEL': 'NONE', VERDICT: 'APPLICABLE' }).join('\n'))
      .toContain('the verdict is UNVERIFIED');
  });

  it.each(['LOCAL_RUNTIME', 'STAGING', 'PRODUCTION'])(
    'requires %s to name the environment it ran against',
    (level) => {
      // Case A: a run cited without the state it ran against is the whole
      // defect. The gate passed; the table had not been widened yet.
      expect(gradeWith({
        'EVIDENCE LEVEL': level,
        SUBJECT: 'run 33199537359',
      }).join('\n')).toContain('SUBJECT names no environment');

      expect(gradeWith({
        'EVIDENCE LEVEL': level,
        SUBJECT: 'run 33202463204 against staging, after the widening migration',
      })).toEqual([]);
    },
  );

  it('does not demand an environment for a browser run', () => {
    // Playwright against a local dev server is a real browser instrument and
    // names no deployed environment.
    expect(gradeWith({ 'EVIDENCE LEVEL': 'BROWSER' })).toEqual([]);
  });

  it('rejects an abbreviated SHA in the subject', () => {
    expect(gradeWith({ SUBJECT: 'commit 6a17e2e, build container' }).join('\n'))
      .toContain('an abbreviated SHA');
    expect(gradeWith({
      SUBJECT: 'commit 6a17e2ea43b8c68a3003cd9dd3d77445c19de18f, build container',
    })).toEqual([]);
  });

  it('does not mistake a workflow run id or an English word for a SHA', () => {
    // 33202463204 is all decimal; "defaced" carries no digit. Requiring both a
    // hex letter and a digit is what keeps them out of the net.
    expect(evaluate(`m.abbreviatedShas('run 33202463204 defaced the staging database')`))
      .toEqual([]);
    expect(evaluate(`m.abbreviatedShas('commit 6a17e2e')`)).toEqual(['6a17e2e']);
  });

  it('reports every fault in a record rather than the first', () => {
    const failures = gradeWith({
      'EXECUTION PATH': 'none',
      'EVIDENCE LEVEL': 'VIBES',
      VERDICT: 'probably',
    });

    expect(failures).toHaveLength(3);
  });
});

describe('the checker as the workflow runs it', () => {
  const scriptPath = path.resolve(__dirname, 'check-evidence-applicability.mjs');

  function run(body: string) {
    try {
      const stdout = execFileSync(process.execPath, [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, PR_BODY: body },
      });
      return { code: 0, output: stdout };
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
    }
  }

  it('exits 0 and says what its silence does not mean when there is no record', () => {
    const { code, output } = run('An ordinary body.');

    expect(code).toBe(0);
    expect(output).toContain('pass on FORM only');
  });

  it('exits 0 on a sound record, and refuses to call it verified', () => {
    const { code, output } = run(recordText());

    expect(code).toBe(0);
    expect(output).toContain('NOT a finding that the evidence establishes the claims');
  });

  it('exits 1 and names the fault on a broken record', () => {
    const { code, output } = run(recordText({ 'EVIDENCE LEVEL': 'VIBES' }));

    expect(code).toBe(1);
    expect(output).toContain('is not one of');
    expect(output).toContain('that judgement is the');
  });
});
