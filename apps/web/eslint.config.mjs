import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The only files where no-control-regex is switched off. Each one strips or
// refuses control characters ON PURPOSE, and spells them as visible escapes
// (backslash-u-0000 and the like) that anyone can read in the source.
//
// The rule is on everywhere else because of the opposite case: an INVISIBLE
// control byte inside a regex. Four files once held a literal backspace (0x08)
// where a word boundary was meant, and each pattern silently matched nothing:
// three test assertions that could never fail, and a role scanner that read no
// roles (#1411, #1420).
//
// sourceControlCharacters.convention.test.ts asks ESLint which files the rule
// is not enforced for and expects exactly this list, so a tenth file cannot be
// added quietly. The same test fails on any raw control byte in ANY tracked
// source file, these nine included.
const CONTROL_CHARACTER_HANDLERS = [
  "app/api/pilot/quotes/route.ts",
  "app/shadow/page.tsx",
  "src/server/pilot/athleteMentalSkills.ts",
  "src/server/pilot/libraryPdfText.ts",
  "src/server/pilot/profileIdentity.ts",
  "src/server/pilot/profilePhotoPolicy.ts",
  "src/server/pilot/shadowUploadPolicy.ts",
  "src/server/pilot/videoUploadPolicy.ts",
  "src/testing/legacyLoaderGoldenData/generate.mjs",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-control-regex": "error",
    },
  },
  {
    files: CONTROL_CHARACTER_HANDLERS,
    rules: {
      "no-control-regex": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
