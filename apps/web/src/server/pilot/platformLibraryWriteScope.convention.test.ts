// Convention gate: the platform baseline stays operator-only.
//
// The reserved organization is writable by exactly one thing -- an operator
// running the importer with PPBF_ORG_ID set to it. Nothing reached through an
// authenticated session may write there, and the database already makes that
// structurally true: no account, membership or athlete may reference
// `__platform__`, so no principal can exist there and no principal-derived
// write can land there (proven against real Postgres in
// platformLibraryScope.pg.test.ts).
//
// This file guards the other half, which the database cannot: the application
// deliberately aiming at the reserved organization. The read paths were widened
// on purpose and the write paths were deliberately left alone, and that
// asymmetry is invisible in review -- both are one helper call apart. A widened
// write would put a gym's uploads into the corpus every other tenant reads.
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

  // Every route derives organization_id from the authenticated principal. A
  // route that named the reserved organization at all would be reaching past
  // that, whether to read it or to write it -- and the only legitimate writer
  // is an operator running the importer, which is a script and not a route.
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
