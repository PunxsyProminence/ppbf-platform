import fs from 'node:fs';

const MATCHERS = {
  migrations: /^(infra\/azure\/|apps\/web\/src\/server\/pilot\/|apps\/web\/scripts\/pilot-|apps\/web\/package\.json$|package\.json$|\.github\/workflows\/apply-migrations\.yml$)/,
  boardE2e: /^(apps\/web\/app\/board\/|apps\/web\/app\/api\/pilot\/board\/|apps\/web\/components\/[^/]*Board|apps\/web\/components\/roleSession|apps\/web\/src\/shared\/pilotRoleRouting|apps\/web\/src\/server\/pilot\/(auth|board))/,
  homepageE2e: /^(apps\/web\/app\/page\.|apps\/web\/app\/globals\.css$|apps\/web\/components\/[^/]*(Home|Landing|Public)|design-system\/|apps\/web\/components\/roleSession|apps\/web\/src\/shared\/pilotRoleRouting)/,
};

const CRITICAL_ENTRYPOINT_DOCS = new Set([
  'README.md',
  'MASTER_INDEX.md',
]);

export function classifyPaths(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);

  const docsOnly =
    files.length > 0 &&
    files.every(
      (p) =>
        (p.startsWith('docs/') || p.endsWith('.md')) &&
        !CRITICAL_ENTRYPOINT_DOCS.has(p),
    );

  const migrations = files.some((p) => MATCHERS.migrations.test(p));
  const boardE2e = files.some((p) => MATCHERS.boardE2e.test(p));
  const homepageE2e = files.some((p) => MATCHERS.homepageE2e.test(p));

  const unknownCode =
    !docsOnly &&
    files.length > 0 &&
    !migrations &&
    !boardE2e &&
    !homepageE2e;

  return {
    docsOnly,
    migrations,
    boardE2e,
    homepageE2e,
    unknownCode,
  };
}

function verifyClassifierContracts() {
  if (classifyPaths(['README.md']).docsOnly) {
    throw new Error('README.md must not use the docs-only CI fast path');
  }

  if (classifyPaths(['MASTER_INDEX.md']).docsOnly) {
    throw new Error('MASTER_INDEX.md must not use the docs-only CI fast path');
  }

  if (!classifyPaths(['docs/example.md']).docsOnly) {
    throw new Error('ordinary docs should use the docs-only CI fast path');
  }
}

function outputLines(result) {
  return [
    `docs_only=${result.docsOnly}`,
    `migrations=${result.migrations}`,
    `board_e2e=${result.boardE2e}`,
    `homepage_e2e=${result.homepageE2e}`,
    `unknown_code=${result.unknownCode}`,
  ].join('\n');
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  verifyClassifierContracts();

  const inputPath = process.argv[2];

  if (!inputPath) {
    throw new Error(
      'usage: node scripts/ci-classify-paths.mjs <changed-files.txt>',
    );
  }

  const files = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/);
  const result = classifyPaths(files);
  const lines = outputLines(result);

  console.log(lines);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### CI surface classification',
        `- docs only: ${result.docsOnly}`,
        `- PostgreSQL migration suite: ${result.migrations}`,
        `- board E2E: ${result.boardE2e}`,
        `- homepage E2E: ${result.homepageE2e}`,
        `- unknown/general code: ${result.unknownCode}`,
        '',
      ].join('\n'),
    );
  }
}
