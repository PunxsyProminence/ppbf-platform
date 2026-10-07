import fs from 'node:fs';
import path from 'node:path';

import type { PilotPrincipal } from './auth';
import { resolvePrincipal } from './auth';
import { requireRole as accessRequireRole } from './access';
import { requireRole as httpRequireRole } from './http';
import { requirePageRole } from './pageGuard';
import { roleEquals } from './roleAlias';

jest.mock('./auth', () => ({ resolvePrincipal: jest.fn() }));
jest.mock('next/headers', () => ({ headers: jest.fn(async () => new Headers()) }));
jest.mock('next/navigation', () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

// 'admin' is the legacy row name for organization_admin
// (ORGANIZATION_ROLE_MODEL.md). http.ts's requireRole used to match roles
// exactly while access.ts's aliased them, so a route that imported the http.ts
// one and listed ['coach', 'admin'] refused the real organization_admin account
// (multidiscipline, competence-cohorts). These tests keep one rule in force.

const webRoot = path.resolve(__dirname, '../../..');

function sourceFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(webRoot, file).split(path.sep).join('/');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return { role, accountId: 'acct', organizationId: 'org', athleteId: null } as unknown as PilotPrincipal;
}

describe('roleEquals', () => {
  test('admin and organization_admin satisfy each other', () => {
    expect(roleEquals('admin', 'organization_admin')).toBe(true);
    expect(roleEquals('organization_admin', 'admin')).toBe(true);
  });

  test('aliases nothing else', () => {
    expect(roleEquals('platform_owner', 'admin')).toBe(false);
    expect(roleEquals('platform_owner', 'organization_admin')).toBe(false);
    expect(roleEquals('coach', 'admin')).toBe(false);
    expect(roleEquals('admin', 'platform_owner')).toBe(false);
  });
});

describe.each([
  ['access.ts', accessRequireRole],
  ['http.ts', httpRequireRole],
])('%s requireRole', (_name, requireRole) => {
  test("organization_admin passes a gate that names only 'admin'", () => {
    expect(() => requireRole(principal('organization_admin'), ['coach', 'admin'])).not.toThrow();
  });

  test("legacy 'admin' passes a gate that names only organization_admin", () => {
    expect(() => requireRole(principal('admin'), ['coach', 'organization_admin'])).not.toThrow();
  });

  test('platform_owner is not widened into either spelling', () => {
    expect(() => requireRole(principal('platform_owner'), ['coach', 'admin'])).toThrow('Forbidden');
    expect(() => requireRole(principal('platform_owner'), ['organization_admin'])).toThrow('Forbidden');
  });

  test('an unlisted role is still refused', () => {
    expect(() => requireRole(principal('athlete'), ['coach', 'admin', 'organization_admin'])).toThrow('Forbidden');
  });
});

describe('pageGuard.ts requirePageRole', () => {
  const resolve = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;

  test("legacy 'admin' reaches a page that lists only organization_admin", async () => {
    resolve.mockResolvedValueOnce(principal('admin'));
    await expect(requirePageRole(['organization_admin'])).resolves.toMatchObject({ role: 'admin' });
  });

  test("organization_admin reaches a page that lists only 'admin'", async () => {
    resolve.mockResolvedValueOnce(principal('organization_admin'));
    await expect(requirePageRole(['admin'])).resolves.toMatchObject({ role: 'organization_admin' });
  });

  test('platform_owner is still sent away from an organization_admin page', async () => {
    resolve.mockResolvedValueOnce(principal('platform_owner'));
    await expect(requirePageRole(['organization_admin'])).rejects.toThrow('REDIRECT:');
  });
});

describe('role gates in source', () => {
  const files = [...sourceFilesUnder(path.join(webRoot, 'app')), ...sourceFilesUnder(path.join(webRoot, 'src'))];

  test('the scan sees the codebase', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  // A function named require...Role is a role gate. It either compares through
  // roleEquals or hands its list to a requireRole that does.
  test('every require...Role function compares through roleEquals or delegates to requireRole', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/function\s+(require\w*Role)\s*\(/g)) {
        seen += 1;
        const start = match.index ?? 0;
        const end = text.indexOf('\n}', start);
        const body = text.slice(start, end === -1 ? undefined : end);
        const callsAlias = /\broleEquals\(/.test(body);
        const delegates = /\brequireRole\(/.test(body.slice(match[0].length));
        if (!callsAlias && !delegates) offenders.push(`${relative(file)}:${lineOf(text, start)} ${match[1]}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });

  // `.includes(x.role)` is an exact match, the trap http.ts had. Each server
  // site is listed here with why exact is right. A new one fails until it uses
  // roleEquals or is added with its reason; an entry that no longer matches
  // anything fails too, so the list cannot rot.
  const EXACT_ROLE_INCLUDES: ReadonlyArray<{ file: string; expression: string; reason: string }> = [
    {
      file: 'src/server/pilot/adultPathway.ts',
      expression: 'PATHWAY_WRITE_ROLES',
      reason: "list names both 'organization_admin' and 'admin'",
    },
    {
      file: 'src/server/pilot/athleteContactCaps.ts',
      expression: 'CONTACT_CAP_ROLES',
      reason: "list names both 'organization_admin' and 'admin'",
    },
    {
      file: 'src/server/pilot/athleteMinorLimits.ts',
      expression: 'MINOR_LIMIT_ROLES',
      reason: "list names both 'organization_admin' and 'admin'",
    },
    {
      file: 'src/server/pilot/contentImport/actor.ts',
      expression: 'GYM_CONTENT_ROLES',
      reason: "list names both 'organization_admin' and 'admin'",
    },
    {
      file: 'src/server/pilot/shadowJobProcessor.ts',
      expression: "['coach', 'organization_admin', 'admin']",
      reason: 'inline list names both spellings',
    },
    {
      file: 'src/server/pilot/shadowJobProcessor.ts',
      expression: 'BOARD_SUMMARY_ROLES',
      reason: "shadowRoleSets.ts list names both 'organization_admin' and 'admin'",
    },
    {
      file: 'src/server/pilot/credentialPolicy.ts',
      expression: 'PASSWORD_ROLES',
      reason: 'credential choice, not a role gate: parent only',
    },
    {
      file: 'src/server/pilot/credentialPolicy.ts',
      expression: 'OFFLINE_LOCAL_PIN_ROLES',
      reason:
        "credential choice, not a role gate: BASE-03's offline PIN exception is scoped to organization_admin and coach " +
        'and no others; legacy admin keeps the production credential',
    },
    {
      file: 'src/server/pilot/staffProvisioning.ts',
      expression: 'callerInvitableRoles',
      reason: 'peer protection over roles an invite may assign, not a role gate on the caller',
    },
  ];

  test('every exact .includes(x.role) under app/api and src/server is accounted for', () => {
    const serverFiles = files.filter((file) => /^(app\/api|src\/server)\//.test(relative(file)));
    const found: Array<{ file: string; line: number; expression: string }> = [];
    for (const file of serverFiles) {
      const text = fs.readFileSync(file, 'utf8');
      // column.role is a content-import column's role, not an account's.
      for (const match of text.matchAll(/\.includes\(\s*(?!column\.)\w+\.role\s*\)/g)) {
        const index = match.index ?? 0;
        const lineStart = text.lastIndexOf('\n', index) + 1;
        found.push({ file: relative(file), line: lineOf(text, index), expression: text.slice(lineStart, index) });
      }
    }

    const unlisted = found
      .filter((hit) => !EXACT_ROLE_INCLUDES.some((entry) => entry.file === hit.file && hit.expression.includes(entry.expression)))
      .map((hit) => `${hit.file}:${hit.line} ${hit.expression.trim()}`);
    const stale = EXACT_ROLE_INCLUDES.filter(
      (entry) => !found.some((hit) => hit.file === entry.file && hit.expression.includes(entry.expression)),
    ).map((entry) => `${entry.file} ${entry.expression}`);

    expect(unlisted).toEqual([]);
    expect(stale).toEqual([]);
  });
});
