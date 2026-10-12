import fs from 'node:fs';
import path from 'node:path';

/**
 * The schedule for the session-token cleanup (#1482 item 3). The script it
 * runs is proven on Postgres by sessionTokenCleanup.pg.test.ts; this pins
 * what the workflow hands it, because a workflow is the one place a wrong
 * expression deletes on a schedule without anybody having typed APPLY.
 *
 * METHOD, stated honestly: raw workflow text plus regex, the idiom
 * workflowResourceGroupContract.test.ts uses. It cannot evaluate GitHub's
 * expressions or prove the repository variable's value; it pins the text.
 */
const WORKFLOW = fs.readFileSync(
  path.resolve(__dirname, '../../../../../.github/workflows/session-token-cleanup.yml'),
  'utf8',
);
const PACKAGE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The expression that decides whether a run deletes, as it must read. */
const APPLY_EXPRESSION =
  "${{ (github.event_name == 'schedule' && vars.PPBF_SESSION_CLEANUP_SCHEDULED_APPLY == 'true') || inputs.apply == 'APPLY' }}";

describe('session-token-cleanup.yml', () => {
  test('runs nightly at 07:50 UTC, spaced after backup.yml and retention-cleanup.yml', () => {
    expect(WORKFLOW).toMatch(/^\s+- cron: '50 7 \* \* \*'$/m);
    const cronOf = (file: string) => /- cron: '(\d+) (\d+) /.exec(
      fs.readFileSync(path.resolve(__dirname, `../../../../../.github/workflows/${file}`), 'utf8'),
    );
    for (const earlier of ['backup.yml', 'retention-cleanup.yml']) {
      const [, minute, hour] = cronOf(earlier) ?? [];
      expect(Number(hour) * 60 + Number(minute)).toBeLessThan(7 * 60 + 50);
    }
  });

  test('deletes only when a person typed APPLY, or the schedule has been switched on by the variable', () => {
    const applyLines = WORKFLOW.split('\n').filter((line) => /PPBF_SESSION_CLEANUP_APPLY:|^\s+APPLY:/.test(line));
    expect(applyLines).toHaveLength(2);
    for (const line of applyLines) expect(line.trim().replace(/^[A-Z_]+: /, '')).toBe(APPLY_EXPRESSION);
    // The script's switch is set in exactly one place.
    expect(WORKFLOW.match(/^\s+PPBF_SESSION_CLEANUP_APPLY:/gm)).toHaveLength(1);
  });

  test('a dispatch defaults to a dry run', () => {
    expect(WORKFLOW).toMatch(/apply:\n(?:.*\n){1,3}\s+default: DRY_RUN\n/);
  });

  test('declares no environment, so the schedule is not parked waiting for a reviewer', () => {
    expect(WORKFLOW).not.toMatch(/^\s+environment:/m);
  });

  test('runs the session:cleanup script, under pipefail, and masks the connection string', () => {
    // --silent and 2>&1, so the summary shows the script's line, failure included.
    expect(WORKFLOW).toContain('npm --silent --prefix apps/web run session:cleanup 2>&1 | tee session-cleanup-result.json');
    expect(WORKFLOW).toMatch(/shell: bash\n(?:\s+#.*\n)*\s+run: \|\n\s+npm --silent --prefix apps\/web run session:cleanup/);
    expect(WORKFLOW).toContain('echo "::add-mask::$CONN"');
    expect(PACKAGE.scripts['session:cleanup']).toBe('tsx scripts/pilot-cleanup-sessions.ts');
  });
});
