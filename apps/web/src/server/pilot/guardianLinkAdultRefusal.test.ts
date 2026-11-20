/**
 * Lane GA: no NEW guardian link to an athlete who is 18 or over.
 *
 * The guardian link goes dormant at 18 (OD-2026-10-07-008), and an unknown
 * date of birth reads as a minor (OD-2026-10-04-010). Both link writers refuse
 * at the moment of the write with guardianAccess.refuseGuardianLinkToAdult,
 * the one rule (guardianLinkEnded), and the refusal is the existing
 * GUARDIAN_LINK_ENDED one (Overwatch, Q1 A).
 *
 * This file holds intake.ts's writer (linkGuardianAthlete, reached by
 * intake/domain-upsert and intake/review-action) and a source guard that every
 * insert into pilot.guardian_links in src/ and app/ is preceded by the refusal.
 * staffProvisioning.ts's writer is tested in staffProvisioning.test.ts; the
 * real-Postgres proofs are in intakeDomainUpsertAtomic.pg.test.ts,
 * guardianInviteLink.pg.test.ts and intakeLoginRefusals.pg.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';
import ts from 'typescript';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

import { GUARDIAN_LINK_ENDED_MESSAGE, GuardianLinkEndedError, refuseGuardianLinkToAdult } from './guardianAccess';
import { GuardianLinkEndedError as ReExportedGuardianLinkEndedError } from './guardianConsent';
import { jsonError } from './http';
import { linkGuardianAthlete } from './intake';

/* Dates of birth on the GYM's calendar day, as guardianAccess.test.ts pins
   them: calendar arithmetic on the gym-date string, never now + 24h (in the
   hour the clocks fall back that is still the same New York day). */
const gymYmd = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const nextDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
/* A Feb 29 has no birthday 18 years back: the adult takes Feb 28 (18 by today
   either way), the minor Mar 1 (still 17). */
const minus18 = (ymd: string, leapDay: '02-28' | '03-01') => {
  const year = Number(ymd.slice(0, 4)) - 18;
  const monthDay = ymd.slice(5);
  return `${year}-${monthDay === '02-29' ? leapDay : monthDay}`;
};
const GYM_TODAY = gymYmd(new Date());
/** Turned 18 today at the gym. */
const EIGHTEEN_TODAY = minus18(GYM_TODAY, '02-28');
/** Turns 18 tomorrow at the gym: a minor until local midnight. */
const EIGHTEEN_TOMORROW = minus18(nextDay(GYM_TODAY), '03-01');
const TEN_YEARS_OLD = `${Number(GYM_TODAY.slice(0, 4)) - 10}-01-15`;

const ORG = 'org-1';
const ATHLETE = 'ath-1';
const PARENT = 'par-1';

/** A transaction client that answers the date-of-birth read and records every statement. */
function fakeClient(athleteRows: Array<{ dob: string | null }>) {
  const query = jest.fn<Promise<{ rows: unknown[]; rowCount: number }>, [sql: string, params?: unknown[]]>(async (sql) => {
    if (/from pilot\.athletes/i.test(sql)) return { rows: athleteRows, rowCount: athleteRows.length };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, query };
}

const link = (client: PoolClient) => linkGuardianAthlete({
  organizationId: ORG,
  parentId: PARENT,
  athleteId: ATHLETE,
  relationshipToAthlete: 'mother',
}, client);

function statements(query: jest.Mock): string[] {
  return query.mock.calls.map(([sql]) => String(sql));
}
const isLinkInsert = (sql: string) => /insert\s+into\s+pilot\.guardian_links/i.test(sql);
const isDobRead = (sql: string) => /from pilot\.athletes/i.test(sql) && /to_char\(dob, 'YYYY-MM-DD'\) as dob/.test(sql);
const isExclusiveConsentSetLock = (sql: string) => /pg_advisory_xact_lock\(/.test(sql) && !/_shared\(/.test(sql);

describe('linkGuardianAthlete: no new link to an athlete who is 18 or over', () => {
  test('an athlete who turned 18 today is refused with GUARDIAN_LINK_ENDED, and no link is written', async () => {
    const { client, query } = fakeClient([{ dob: EIGHTEEN_TODAY }]);

    const error = await link(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GuardianLinkEndedError);
    expect((error as GuardianLinkEndedError).status).toBe(403);
    expect((error as GuardianLinkEndedError).code).toBe('GUARDIAN_LINK_ENDED');
    expect((error as Error).message).toBe('Forbidden: this athlete is 18 or older; guardian access has ended');
    expect(statements(query).filter(isLinkInsert)).toHaveLength(0);
  });

  test('an athlete who turns 18 tomorrow is still a minor today, and is linked', async () => {
    const { client, query } = fakeClient([{ dob: EIGHTEEN_TOMORROW }]);

    await expect(link(client)).resolves.toBeUndefined();

    const inserts = query.mock.calls.filter(([sql]) => isLinkInsert(String(sql)));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual([ORG, PARENT, ATHLETE, 'mother']);
  });

  test('a minor is linked, unchanged', async () => {
    const { client, query } = fakeClient([{ dob: TEN_YEARS_OLD }]);
    await expect(link(client)).resolves.toBeUndefined();
    expect(statements(query).filter(isLinkInsert)).toHaveLength(1);
  });

  test.each([
    ['no date of birth on file', null],
    ['an unreadable date of birth', 'not a date'],
  ])('%s reads as a minor (OD-2026-10-04-010), and is linked', async (_label, dob) => {
    const { client, query } = fakeClient([{ dob }]);
    await expect(link(client)).resolves.toBeUndefined();
    expect(statements(query).filter(isLinkInsert)).toHaveLength(1);
  });

  test('a missing athlete row is not this refusal: the insert is left to the foreign key, as before', async () => {
    const { client, query } = fakeClient([]);
    await expect(link(client)).resolves.toBeUndefined();
    expect(statements(query).filter(isLinkInsert)).toHaveLength(1);
  });

  test('the date of birth is read on the same client, after the exclusive consent-set lock and before the insert', async () => {
    const { client, query } = fakeClient([{ dob: EIGHTEEN_TOMORROW }]);
    await link(client);

    const sqls = statements(query);
    const lockAt = sqls.findIndex(isExclusiveConsentSetLock);
    const readAt = sqls.findIndex(isDobRead);
    const insertAt = sqls.findIndex(isLinkInsert);
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(lockAt);
    expect(insertAt).toBeGreaterThan(readAt);
    // Scoped to this gym and this athlete.
    expect(query.mock.calls[readAt][1]).toEqual([ORG, ATHLETE]);
  });
});

describe('refuseGuardianLinkToAdult: the one rule, and the existing refusal', () => {
  const NOW = new Date('2026-06-15T16:00:00Z'); // noon at the gym (EDT)

  test('refuses on and after the 18th birthday at the gym, not the day before', () => {
    expect(() => refuseGuardianLinkToAdult('2008-06-15', NOW)).toThrow(GuardianLinkEndedError);
    expect(() => refuseGuardianLinkToAdult('2008-06-14', NOW)).toThrow(GuardianLinkEndedError);
    expect(() => refuseGuardianLinkToAdult('2008-06-16', NOW)).not.toThrow();
  });

  test('an unknown or unreadable date of birth is a minor and is not refused', () => {
    expect(() => refuseGuardianLinkToAdult(null, NOW)).not.toThrow();
    expect(() => refuseGuardianLinkToAdult(undefined, NOW)).not.toThrow();
    expect(() => refuseGuardianLinkToAdult('not a date', NOW)).not.toThrow();
  });

  test('the refusal is the one the consent routes already use, re-exported unchanged from guardianConsent.ts', () => {
    expect(ReExportedGuardianLinkEndedError).toBe(GuardianLinkEndedError);
    const error = new GuardianLinkEndedError();
    expect(error.message).toBe(GUARDIAN_LINK_ENDED_MESSAGE);
    expect(error.code).toBe('GUARDIAN_LINK_ENDED');
  });

  test('a route answers it as 403 with the code', async () => {
    const response = jsonError(new GuardianLinkEndedError());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden: this athlete is 18 or older; guardian access has ended',
      code: 'GUARDIAN_LINK_ENDED',
    });
  });
});

/*
 * Every INSERT into pilot.guardian_links in src/ and app/ calls
 * refuseGuardianLinkToAdult earlier in an enclosing function. A third writer
 * that skipped it would mint a link to an adult. Same scanner shape as the
 * consent-set lock guard (guardianLinkLockOrderSource.test.ts): a textual
 * check that the call precedes the insert in an enclosing function, not that
 * it read the right athlete; the unit and pg suites prove that.
 */
const WEB_ROOT = path.resolve(__dirname, '../../..');
const INSERT_INTO_LINKS = /insert\s+into\s+pilot\.guardian_links/i;
const REFUSAL_CALL = /\brefuseGuardianLinkToAdult\(/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(?:tsx?|mjs)$/.test(entry.name) && !/\.test\.(?:tsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

/* The parser follows the file's extension. Parsed as TSX, a .ts file's generic
   arrow (`<T>(fn) => ...`, staffProvisioning.ts's inTransaction) reads as a
   JSX tag, the tree goes wrong from there, and the insert after it is never
   visited (both lane GA reviewers, #2012). `visited` counts the inserts the
   walk reached, so a file it cannot read is a failure, not an empty pass. */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.mjs') || fileName.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function scanLinkInserts(text: string, fileName = 'scan.ts'): { visited: number; offenders: string[] } {
  if (!/guardian_links/i.test(text)) return { visited: 0, offenders: [] };
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const offenders: string[] = [];
  let visited = 0;
  const visit = (node: ts.Node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node) ? node.head.text : null;
    if (literal !== null && INSERT_INTO_LINKS.test(literal)) {
      visited += 1;
      const scopes: ts.Node[] = [];
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isFunctionLike(up)) scopes.push(up);
      }
      // Comments stripped, so a comment naming the call does not count as making it.
      const before = (scope: ts.Node) => text
        .slice(scope.getStart(source), node.getStart(source))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (!scopes.some((scope) => REFUSAL_CALL.test(before(scope)))) {
        offenders.push(literal.replace(/\s+/g, ' ').slice(0, 80));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { visited, offenders };
}

const unrefusedLinkInserts = (text: string, fileName?: string) => scanLinkInserts(text, fileName).offenders;

describe('guardian_links inserts: the age refusal comes first', () => {
  test('the scanner flags an insert with no refusal before it, and passes one with', () => {
    expect(unrefusedLinkInserts("async function f(c) { await c.query('insert into pilot.guardian_links (a) values ($1)'); }")).toHaveLength(1);
    expect(unrefusedLinkInserts("async function f(c) { await c.query('insert into pilot.guardian_links (a) values ($1)'); refuseGuardianLinkToAdult(dob); }")).toHaveLength(1);
    expect(unrefusedLinkInserts("async function f(c) {\n // refuseGuardianLinkToAdult(dob)\n await c.query('insert into pilot.guardian_links (a) values ($1)'); }")).toHaveLength(1);
    expect(unrefusedLinkInserts("async function f(c) { refuseGuardianLinkToAdult(dob); await c.query(`insert into pilot.guardian_links (a) values ($1)`); }")).toHaveLength(0);
  });

  test('the scanner picks its parser from the file extension, and counts the inserts it reached', () => {
    expect(scriptKindFor('src/server/pilot/staffProvisioning.ts')).toBe(ts.ScriptKind.TS);
    expect(scriptKindFor('app/admin/people/page.tsx')).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor('scripts/x.mjs')).toBe(ts.ScriptKind.JS);
    expect(scanLinkInserts("async function f(c) { await c.query('insert into pilot.guardian_links (a) values ($1)'); }", 'writer.ts'))
      .toEqual({ visited: 1, offenders: [expect.stringContaining('insert into pilot.guardian_links')] });
  });

  test('every one in src/ and app/ is preceded by refuseGuardianLinkToAdult', () => {
    const files = ['src', 'app'].map((dir) => path.join(WEB_ROOT, dir)).flatMap(sourceFiles);
    const offenders = files.flatMap((file) => unrefusedLinkInserts(fs.readFileSync(file, 'utf8'), file).map(
      (literal) => `${path.relative(WEB_ROOT, file)}: ${literal}`,
    ));
    expect(offenders).toEqual([]);
    // Found at least the two shipped writers, so an empty list is not a scan that matched nothing.
    const found = files.filter((file) => INSERT_INTO_LINKS.test(fs.readFileSync(file, 'utf8')));
    expect(found.map((file) => path.relative(WEB_ROOT, file)).sort()).toEqual(expect.arrayContaining([
      'src/server/pilot/intake.ts',
      'src/server/pilot/staffProvisioning.ts',
    ]));
    // And the walk reached an insert in every file whose text names one, so a
    // file the parser misreads cannot pass by being invisible.
    const unread = found
      .filter((file) => scanLinkInserts(fs.readFileSync(file, 'utf8'), file).visited === 0)
      .map((file) => path.relative(WEB_ROOT, file));
    expect(unread).toEqual([]);
  });
});
