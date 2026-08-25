/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  // 'node' stays the default so the existing server-side suites keep their
  // startup cost. Component tests opt into a DOM per file with a
  // `@jest-environment jsdom` docblock -- see shadowMessageRender.test.tsx.
  testEnvironment: 'node',
  // .test.tsx was absent here, and the environment had no jsdom, so every file
  // under app/ and components/ was untestable by construction: the whole client
  // layer sat outside the suite while it reported green. The transform below
  // already handled tsx, so only the pattern and the DOM environment were
  // missing.
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  // The default is [rootDir] (this directory), so packages/ -- a sibling of
  // apps/, not a child of apps/web -- was invisible to every `npm test` run
  // and to CI. featureFlags.ts sat there throwing on every call, unit-tested
  // by nothing, because there was no way for a test next to it to ever run.
  // The package sources are plain TypeScript with no Next/React/DOM
  // dependency and no "@/" alias, so they need no additional mapping here.
  roots: ['<rootDir>', '<rootDir>/../../packages'],
  moduleNameMapper: {
    // Must mirror tsconfig.json's "paths", which resolves "@/*" against
    // ./src/* before ./*. Mapping only to the root meant any module importing
    // "@/lib/..." (which lives at src/lib) was resolvable by tsc and the Next
    // build but not by Jest, so such a module simply could not be unit tested.
    // The two directory sets do not overlap, so trying src first shadows
    // nothing at the root.
    '^@/(.*)$': ['<rootDir>/src/$1', '<rootDir>/$1'],
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
      },
    }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
  // 'default' is Jest's own output and is kept exactly as it was; the second
  // entry is added beside it. A suite that fails to LOAD reports as one failing
  // file while the assertions it owns vanish from the totals -- so the passing
  // count goes UP and no summary says a guard left. This reporter compares
  // src/testing/safetyCriticalSuites.json against what the run actually did and
  // fails the run by name when a named suite is missing, did not load, or
  // contributed fewer tests than its measured floor. It enforces nothing on a
  // narrowed run (a single file, -t, --onlyChanged) and says so. See the
  // docblock in the reporter for why this is not a test or a --listTests step.
  reporters: ['default', '<rootDir>/scripts/suiteAttendanceReporter.js'],
};
