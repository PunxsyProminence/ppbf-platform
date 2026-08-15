import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'pilot-check-seed-accounts.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

// The whole reason this check exists: production's live platform owner is
// Admin@ with a capital A while a lowercase row for the same human is
// retired, and reusing the wrong one stamps a retired account onto every
// seeded row without erroring. If the grouping stops folding case, the
// report degrades into a flat list and the collision becomes invisible
// again -- which is the state that made seed_account_id a blocker.
describe('seeder-account case-collision grouping', () => {
  const CAPITAL = '{account_id:"acc_live",login_email:"Admin@punxsyprominence.org",active_flag:true}';
  const LOWER = '{account_id:"acc_retired",login_email:"admin@punxsyprominence.org",active_flag:false}';

  test('two rows differing only by case land in one group', () => {
    const groups = evaluate(`m.groupByEmailFold([${CAPITAL}, ${LOWER}])`);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  test('the group key is the folded address, so it cannot inherit either casing', () => {
    const groups = evaluate(`m.groupByEmailFold([${CAPITAL}, ${LOWER}])`);
    expect(groups[0].fold).toBe('admin@punxsyprominence.org');
  });

  test('the collision group sorts first, ahead of accounts that have no twin', () => {
    const other = '{account_id:"acc_other",login_email:"coach@example.org",active_flag:true}';
    const groups = evaluate(`m.groupByEmailFold([${other}, ${CAPITAL}, ${LOWER}])`);
    expect(groups[0].members).toHaveLength(2);
    expect(groups[0].fold).toBe('admin@punxsyprominence.org');
  });

  test('distinct addresses are never merged', () => {
    const a = '{account_id:"a",login_email:"one@example.org",active_flag:true}';
    const b = '{account_id:"b",login_email:"two@example.org",active_flag:true}';
    const groups = evaluate(`m.groupByEmailFold([${a}, ${b}])`);
    expect(groups).toHaveLength(2);
    expect(groups.every((g: { members: unknown[] }) => g.members.length === 1)).toBe(true);
  });

  test('a null email does not throw and does not merge with a real address', () => {
    const nullEmail = '{account_id:"n",login_email:null,active_flag:false}';
    const real = '{account_id:"r",login_email:"x@example.org",active_flag:true}';
    const groups = evaluate(`m.groupByEmailFold([${nullEmail}, ${real}])`);
    expect(groups).toHaveLength(2);
  });

  test('two accounts with no email are NOT folded into a phantom collision', () => {
    // Regression for the review note: folding a missing email to '' put every
    // address-less row in one bucket, which then surfaced as a bogus
    // "collision" the operator would have to dismiss. Each gets its own group.
    const a = '{account_id:"na",login_email:null,active_flag:true}';
    const b = '{account_id:"nb",login_email:null,active_flag:false}';
    const groups = evaluate(`m.groupByEmailFold([${a}, ${b}])`);
    expect(groups).toHaveLength(2);
    expect(groups.every((g: { members: unknown[] }) => g.members.length === 1)).toBe(true);
  });

  test('a value with no @ is treated as address-less, not folded with real ones', () => {
    // login_email that is a non-empty string but not an address must not merge
    // with a genuine address that happens to lowercase to something similar.
    const junk = '{account_id:"j",login_email:"not-an-address",active_flag:true}';
    const junk2 = '{account_id:"j2",login_email:"also-not-one",active_flag:false}';
    const groups = evaluate(`m.groupByEmailFold([${junk}, ${junk2}])`);
    expect(groups).toHaveLength(2);
  });
});

describe('email masking', () => {
  // Same contract as the stranded-guardians check: recognisable in a CI
  // summary, not republishable.
  test('keeps the first character and the domain', () => {
    expect(evaluate('m.maskEmail("admin@punxsyprominence.org")'))
      .toBe('a****@punxsyprominence.org');
  });

  test('masks a one-character local part rather than emitting it bare', () => {
    expect(evaluate('m.maskEmail("a@example.org")')).toBe('a*@example.org');
  });

  test('a value that is not an address passes through instead of throwing', () => {
    expect(evaluate('m.maskEmail("not-an-address")')).toBe('not-an-address');
  });
});
