// Convention gate: the platform baseline is written in exactly two ways.
//
// 1. An operator running the importer with PPBF_ORG_ID set to it (a script).
// 2. The platform owner, in the app, naming `shelf: 'platform'` on the Library
//    and evidence-review routes (OD-2026-10-02-013 answer 1B; worked from the
//    existing /research and /evidence pages, OD-2026-10-02-015 D2). The shelf
//    is resolved to the reserved organization on the server, in ONE place:
//    libraryShelf.ts. It refuses every other role.
//
// The database still makes a principal-derived write there impossible: no
// account, membership or athlete may reference `__platform__`, so no
// principal's own organization is ever the reserved one (proven against real
// Postgres in platformLibraryScope.pg.test.ts). The only way an authenticated
// request reaches it is through libraryShelf.ts, and platformShelfWrites.pg.test.ts
// proves that path end to end.
//
// This file guards what the database cannot: the application deliberately
// aiming at the reserved organization anywhere else. The read paths were
// widened on purpose and the write functions in shadowLibrary.ts stay on the
// one organization their caller resolved, and that asymmetry is invisible in
// review -- both are one helper call apart. A widened write would put a gym's
// uploads into the corpus every other tenant reads.
//
// Pinned in BOTH directions, the way the response validator's cases are: the
// writes must not widen, and the reads must not stop. A one-directional test
// here would pass just as happily against a build where retrieval quietly
// stopped returning the baseline at all.

import fs from 'node:fs';
import path from 'node:path';

const PILOT_DIR = __dirname;
const API_ROOT = path.resolve(__dirname, '../../../app/api');

const WIDENING_HELPER = 'libraryRetrievalOrganizationIds';
const PLATFORM_ID_CONSTANT = 'PLATFORM_LIBRARY_ORGANIZATION_ID';
const PLATFORM_ID_LITERAL = '__platform__';

function read(file: string): string {
  return fs.readFileSync(path.join(PILOT_DIR, file), 'utf8');
}

/**
 * The body of a top-level function, exported or not.
 *
 * `persistEvidenceBundle` is module-private, and an extractor that required
 * `export` silently skipped the single most important write path here --
 * reporting it as "not widened" when it is widened, correctly, three lines from
 * the insert. So the pattern admits both forms, and the vacuity test below
 * fails if any named function stops being found.
 *
 * Terminates on a line that is ONLY a closing brace. These signatures span
 * many lines and end `}): Promise<T> {`, which also begins at column zero, so
 * the naive "first line starting with }" ends the body at the parameter type.
 */
function functionBody(source: string, name: string): string | null {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^(export )?(async )?function ${name}\\b`).test(line));
  if (start === -1) return null;

  const end = lines.findIndex((line, index) => index > start && /^\}\s*$/.test(line));
  if (end === -1) return null;

  return lines.slice(start, end + 1).join('\n');
}

/**
 * Writes and reviewer-facing lists. Each is scoped to the actor's own
 * organization and must stay that way.
 *
 * listApprovedGlobalEvidenceForResearchBridge is here for a different reason
 * than the rest: it is an export, and including the baseline would ship the
 * platform corpus out as though it were one gym's evidence.
 */
const MUST_NOT_WIDEN: Array<[file: string, fn: string]> = [
  ['shadowLibrary.ts', 'createShadowLibrarySource'],
  ['shadowLibrary.ts', 'createShadowLibraryDocument'],
  ['shadowLibrary.ts', 'createShadowLibraryChunk'],
  ['shadowLibrary.ts', 'listShadowLibrarySources'],
  ['shadowLibrary.ts', 'reviewShadowLibrarySource'],
  ['shadowLibrary.ts', 'listShadowLibraryReviewQueue'],
  ['shadowLibrary.ts', 'upsertShadowCapabilityMap'],
  ['shadowLibrary.ts', 'listApprovedGlobalEvidenceForResearchBridge'],
];

/** Retrieval paths that must keep admitting the baseline. */
const MUST_WIDEN: Array<[file: string, fn: string]> = [
  ['shadowLibrary.ts', 'searchShadowLibrary'],
  ['shadowEvidence.ts', 'persistEvidenceBundle'],
  ['shadowEvidence.ts', 'hasRetrievableLibraryEvidence'],
];

describe('the library write paths stay inside one organization', () => {
  test.each(MUST_NOT_WIDEN)('%s#%s does not admit the platform baseline', (file, fn) => {
    const body = functionBody(read(file), fn);
    expect({ fn, found: body !== null }).toEqual({ fn, found: true });

    expect({ fn, widens: body!.includes(WIDENING_HELPER) }).toEqual({ fn, widens: false });
    expect({ fn, namesPlatform: body!.includes(PLATFORM_ID_CONSTANT) }).toEqual({ fn, namesPlatform: false });
    expect({ fn, hardCodesPlatform: body!.includes(PLATFORM_ID_LITERAL) }).toEqual({ fn, hardCodesPlatform: false });
  });

  // Guards the guard. If a rename made functionBody return a two-line stub,
  // every assertion above would pass on an empty string.
  test.each(MUST_NOT_WIDEN)('%s#%s was actually read, not silently missed', (file, fn) => {
    const body = functionBody(read(file), fn);
    expect(body).not.toBeNull();
    expect(body!.split('\n').length).toBeGreaterThan(10);
    expect(body).toContain('organizationId');
  });
});

describe('the retrieval paths still reach the baseline', () => {
  test.each(MUST_WIDEN)('%s#%s admits the platform baseline', (file, fn) => {
    const body = functionBody(read(file), fn);
    expect({ fn, found: body !== null }).toEqual({ fn, found: true });
    expect({ fn, widens: body!.includes(WIDENING_HELPER) }).toEqual({ fn, widens: true });
  });

  // rabbitHoles states it as a literal inside a shared SQL fragment rather than
  // calling the helper, because the join is a template string built once.
  test('the rabbit-hole citation join still admits platform documents', () => {
    const source = read('rabbitHoles.ts');
    expect(source).toContain(PLATFORM_ID_CONSTANT);
    expect(source).toMatch(/or d\.organization_id = /);
  });

  // The history join keys on library_organization_id rather than
  // organization_id. On the latter, a platform-cited message renders with a
  // null source title -- the citation is there and the reader cannot see what
  // it was.
  test('the conversation history join keys on the cited row owner', () => {
    const source = read('shadowConversations.ts');
    expect(source).toContain('ei.library_organization_id');
  });
});

describe('no authenticated route names the reserved organization', () => {
  function routeFiles(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) found.push(...routeFiles(full));
      else if (entry.name === 'route.ts' || entry.name === 'route.tsx') found.push(full);
    }
    return found;
  }

  const routes = routeFiles(API_ROOT);

  test('the sweep examines routes, rather than passing vacuously', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  // Every route derives organization_id from the authenticated principal, or
  // from a shelf name resolved by libraryShelf.ts. A route that named the
  // reserved organization itself would be reaching past both, whether to read
  // it or to write it.
  test('no route file mentions the reserved organization', () => {
    const offenders = routes
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes(PLATFORM_ID_CONSTANT) || source.includes(PLATFORM_ID_LITERAL);
      })
      .map((file) => path.relative(API_ROOT, file));

    expect(offenders).toEqual([]);
  });
});

// OD-2026-10-02-013 1B opened ONE in-app route to the platform shelf, and it is
// worth exactly as much as its being one. Every application file (app/, src/,
// components/, lib/; tests and test fixtures excluded, scripts live outside
// these roots) that names the reserved organization in code -- not in a
// comment -- must be on this list, with the reason it may. A second resolver
// for writes, anywhere, fails here before review has to notice it.
describe('libraryShelf.ts is the only in-app resolver of the platform shelf', () => {
  const WEB_ROOT = path.resolve(__dirname, '../../..');
  const ROOTS = ['app', 'src', 'components', 'lib'];

  const ALLOWED: Record<string, string> = {
    'src/server/pilot/platformLibraryScope.ts': 'defines the constant and the read helpers',
    'src/server/pilot/libraryShelf.ts': 'the one authenticated-request resolver: platform owner, shelf "platform"',
    'src/server/pilot/rabbitHoles.ts': 'read: the citation join admits platform documents',
    'src/server/pilot/contentImport/actor.ts': 'operator importer gate: refuses a non-owner loading the platform shelf',
  };

  function sourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'testing') continue;
        found.push(...sourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        found.push(full);
      }
    }
    return found;
  }

  // Comment lines are prose about the shelf, which is fine; code is the claim.
  function codeOnly(source: string): string {
    return source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
  }

  const files = ROOTS.flatMap((root) => sourceFiles(path.join(WEB_ROOT, root)));

  test('the sweep examines the application, rather than passing vacuously', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  test('only the listed files name the reserved organization in code', () => {
    const naming = files
      .filter((file) => {
        const code = codeOnly(fs.readFileSync(file, 'utf8'));
        return code.includes(PLATFORM_ID_CONSTANT) || code.includes(PLATFORM_ID_LITERAL);
      })
      .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'))
      .sort();

    expect(naming).toEqual(Object.keys(ALLOWED).sort());
  });

  test('libraryShelf.ts actually resolves the platform shelf to the constant, for the platform owner only', () => {
    const source = codeOnly(fs.readFileSync(path.join(PILOT_DIR, 'libraryShelf.ts'), 'utf8'));
    expect(source).toContain(`return ${PLATFORM_ID_CONSTANT};`);
    expect(source).toContain("principal.role !== 'platform_owner'");
  });
});

// OD-2026-10-02-015 D3: the platform owner no longer writes a gym's shelf. The
// refusal lives in ONE place, resolveLibraryShelf(..., 'write'), so it holds
// only on routes that go through it. #1115 wired sources, documents, chunks
// and evidence review; capability coverage, research submissions and review
// flags kept taking principal.organizationId straight from the session, and
// through those three the platform owner could still write a gym's Library
// records (the 2026-10-03 intake audit, finding S8). A route on this list
// that stops calling the resolver, or a new Library write route that never
// did, fails here before review has to notice it.
describe('every Library write route resolves its shelf through libraryShelf.ts', () => {
  const LIBRARY_WRITE_ROUTES = [
    'pilot/shadow/library/sources/route.ts',
    'pilot/shadow/library/documents/route.ts',
    'pilot/shadow/library/chunks/route.ts',
    'pilot/shadow/evidence/review/route.ts',
    'pilot/shadow/library/capability-coverage/route.ts',
    'pilot/shadow/library/review-flags/route.ts',
    'pilot/shadow/research-submissions/route.ts',
  ];

  function routeCode(file: string): string {
    return fs
      .readFileSync(path.join(API_ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
  }

  test.each(LIBRARY_WRITE_ROUTES)('%s picks its organization through resolveLibraryShelf', (file) => {
    const code = routeCode(file);
    expect({ file, resolves: code.includes('resolveLibraryShelf(') }).toEqual({ file, resolves: true });
  });

  // The bypass in its other form: a handler that calls the resolver for one
  // method and still hands principal.organizationId to a write in another.
  test.each(LIBRARY_WRITE_ROUTES)('%s never hands the session organization to a query directly', (file) => {
    const code = routeCode(file);
    expect({ file, readsPrincipalOrg: code.includes('principal.organizationId') }).toEqual({
      file,
      readsPrincipalOrg: false,
    });
  });
});
