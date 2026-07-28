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
};
