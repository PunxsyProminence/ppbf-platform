import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// WHY THE RULES BELOW ARE ON. Four files once held a literal backspace (0x08)
// inside a regex where a word boundary was meant. The two look identical in an
// editor and in a diff, and the pattern silently matched nothing: three test
// assertions that could never fail, and a role scanner that read no roles
// (#1411, #1420). The usual cause is a tool that collapses a doubled backslash
// on the way to disk.
//
// no-control-regex refuses a control character inside a regex, as the raw byte
// or as a backslash-x or backslash-u escape.
//
// The only files where it is switched off. Each one names control characters
// ON PURPOSE, as visible escapes (backslash-u-0000 and the like) that anyone
// can read in the source: eight strip or refuse them in what people type or
// upload, and generate.mjs marks the edge of the ASCII range.
//
// sourceControlCharacters.convention.test.ts asks ESLint which files the rule
// is not enforced for and expects exactly this list, so a tenth file cannot be
// added quietly. The same test fails on a raw control byte in any tracked file
// under apps/web and packages, these nine included.
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

// The same accident one step removed, which no-control-regex cannot see: a
// regex built from a string or a template. "backslash, b" inside a string IS a
// backspace, so a pattern assembled from it matches nothing either, and on disk
// it is two ordinary visible characters. Nothing in this app means a backspace,
// so one in a string or a template is refused outright. Only String.raw
// templates are left alone: there the two characters stay two characters.
// (Code that truly needs the character can spell it String.fromCharCode(8).)
//
// Spelled with fromCharCode so that this file holds no escape to collapse.
const BACKSPACE = String.fromCharCode(8);
const STRING_RAW = 'TaggedTemplateExpression[tag.object.name="String"][tag.property.name="raw"]';
const BACKSPACE_MESSAGE =
  "This holds a backspace character. If a regex word boundary was meant, the backslash before the b was lost: "
  + "double it inside a string, or build the pattern with String.raw.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-control-regex": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${BACKSPACE}/]`,
          message: BACKSPACE_MESSAGE,
        },
        {
          selector:
            `TemplateLiteral:not(${STRING_RAW} > TemplateLiteral) > TemplateElement[value.cooked=/${BACKSPACE}/]`,
          message: BACKSPACE_MESSAGE,
        },
      ],
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
