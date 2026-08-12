import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'pilot-apply-drills-migration.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(await (${expression})));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

describe('drills readiness reporting', () => {
  // apply-migrations failed on this runner twice, seventeen hours apart, and
  // said only DRILLS_NOT_READY both times. The row already carried the answer.
  test('names the unmet check instead of hiding it', () => {
    const unmet = evaluate(
      `m.unmetReadinessChecks({ drills_ready: true, drill_name_unique_ready: false })`,
    );

    expect(unmet).toEqual(['drill_name_unique_ready=false']);
  });

  test('reports every unmet check, not just the first', () => {
    const unmet = evaluate(
      `m.unmetReadinessChecks({ a: false, b: true, c: false })`,
    );

    expect(unmet).toEqual(['a=false', 'c=false']);
  });

  // A readiness column that comes back null reads as "unmet" and must say so
  // rather than being indistinguishable from false -- null usually means the
  // sub-select found no row, which is a different fault from a failed test.
  test('distinguishes null from false', () => {
    expect(evaluate(`m.unmetReadinessChecks({ a: null })`)).toEqual(['a=null']);
  });

  test('an entirely absent row is reported, not treated as ready', () => {
    expect(evaluate(`m.unmetReadinessChecks(null)`)).toHaveLength(1);
  });

  test('a fully ready row yields nothing', () => {
    expect(evaluate(`m.unmetReadinessChecks({ a: true, b: true })`)).toEqual([]);
  });
});
