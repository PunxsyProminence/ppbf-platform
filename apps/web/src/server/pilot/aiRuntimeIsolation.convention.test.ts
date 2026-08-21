// Convention gate: core operation must survive an AI outage -- no route or
// server module outside the explicit SHADOW/ops allowlist below may import
// azureAiRuntime, so rosters, safety escalations, readiness, compliance, and
// every other operational surface keep working when the AI endpoint is down,
// misconfigured, or unfunded.
//
// Verified import graph at the time this gate was written (grep for
// azureAiRuntime across apps/web, test files excluded):
//
//   app/api/pilot/shadow/chat/route.ts        (SHADOW chat -- AI by design)
//   src/server/pilot/shadowJobProcessor.ts    (SHADOW background jobs)
//   src/server/pilot/shadowHeavyBag.ts        (SHADOW heavy-bag analysis)
//   src/server/pilot/pilotOpsReadiness.ts     (ops probe REPORTING on AI config)
//
// Nothing else -- no shadowFilmStudy/embedding/router chain member imports it
// directly. If a new module legitimately needs the AI runtime, it belongs on
// the SHADOW side of the line: add it to the allowlist with the reason, the
// way organizationScope.convention.test.ts records its exceptions.

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = [
  path.join(WEB_ROOT, 'app', 'api'),
  path.join(WEB_ROOT, 'src', 'server', 'pilot'),
];

/**
 * Any import shape that binds a module to the AI runtime: static `from`,
 * dynamic `import(...)`, and `require(...)`. Matched against the specifier
 * string so a re-export or deep path variant is caught too.
 */
const IMPORTS_AI_RUNTIME = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*azureAiRuntime['"]/;

/**
 * The SHADOW/ops surfaces that may depend on the AI runtime. Everything under
 * app/api/pilot/shadow is AI-facing by definition; the named modules are the
 * SHADOW processing chain plus the readiness probe whose job is to report on
 * the AI configuration, plus the runtime module itself.
 */
const ALLOWED_PREFIXES = ['app/api/pilot/shadow/'];
const ALLOWED_FILES = new Set([
  'src/server/pilot/azureAiRuntime.ts',
  'src/server/pilot/shadowJobProcessor.ts',
  'src/server/pilot/shadowHeavyBag.ts',
  'src/server/pilot/pilotOpsReadiness.ts',
]);

function isTestFile(name: string): boolean {
  return /\.test\.tsx?$/.test(name);
}

function collectSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !isTestFile(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Forward slashes always -- path.relative returns backslashes on Windows,
 * which would silently unmatch every allowlist entry there. Same
 * normalisation, for the same reason, as organizationScope.convention.test.ts.
 */
function relative(filePath: string): string {
  return path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
}

function isAllowed(rel: string): boolean {
  return ALLOWED_FILES.has(rel) || ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function findImporters(): string[] {
  const importers: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const filePath of collectSourceFiles(root)) {
      const source = fs.readFileSync(filePath, 'utf8');
      if (IMPORTS_AI_RUNTIME.test(source)) {
        importers.push(relative(filePath));
      }
    }
  }
  return importers;
}

test('no core route or server module imports the AI runtime', () => {
  const offenders = findImporters().filter((rel) => !isAllowed(rel));

  if (offenders.length > 0) {
    throw new Error(
      'These files import azureAiRuntime outside the SHADOW/ops allowlist. '
      + 'Core operation must survive an AI outage: an operational surface that '
      + 'imports the AI runtime inherits its configuration, its network '
      + 'dependency, and its failure modes. Move the AI call behind a SHADOW '
      + 'surface, or -- if this module genuinely belongs on the AI side of the '
      + 'line -- allowlist it above with the reason:\n  '
      + offenders.join('\n  '),
    );
  }
});

// The allowlist is the part that rots: an entry for a file that no longer
// exists is a standing permission nobody reviewed, and it would silently
// cover a different module if the path were ever reused.
test('every allowlisted file still exists', () => {
  const missing = [...ALLOWED_FILES].filter(
    (rel) => !fs.existsSync(path.join(WEB_ROOT, rel)),
  );

  expect(missing).toEqual([]);
});

// A detector that matches nothing would make the sweep vacuous -- green
// because nothing was recognised, not because nothing was wrong. The SHADOW
// chat route and job processor are known importers; the sweep must see them.
test('the sweep actually detects AI-runtime importers, rather than passing vacuously', () => {
  const importers = findImporters();

  expect(importers).toContain('app/api/pilot/shadow/chat/route.ts');
  expect(importers).toContain('src/server/pilot/shadowJobProcessor.ts');
});
