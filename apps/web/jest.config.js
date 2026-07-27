/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
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
