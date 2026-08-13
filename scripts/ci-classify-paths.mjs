import fs from 'node:fs';

const startsWithAny = (file, prefixes) =>
  prefixes.some((prefix) => file.startsWith(prefix));

const directComponentName = (file) => {
  const prefix = 'apps/web/components/';
  if (!file.startsWith(prefix)) return '';
  const name = file.slice(prefix.length);
  return name.includes('/') ? '' : name;
};

const isMigrationPath = (file) =>
  startsWithAny(file, [
    'infra/azure/',
    'apps/web/src/server/pilot/',
    'apps/web/scripts/pilot-',
  ]) ||
  [
    'apps/web/package.json',
    'package.json',
    '.github/workflows/apply-migrations.yml',
  ].includes(file);

const isBoardE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    startsWithAny(file, [
      'apps/web/app/board/',
      'apps/web/app/api/pilot/board/',
      'apps/web/components/roleSession',
      'apps/web/src/shared/pilotRoleRouting',
      'apps/web/src/server/pilot/auth',
      'apps/web/src/server/pilot/board',
    ]) || component.includes('Board')
  );
};

const isHomepageE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    startsWithAny(file, [
      'apps/web/app/page.',
      'apps/web/app/globals.css',
      'design-system/',
      'apps/web/components/roleSession',
      'apps/web/src/shared/pilotRoleRouting',
    ]) ||
    ['Home', 'Landing', 'Public'].some((token) => component.includes(token))
  );
};

export function classifyPaths(paths) {
  const files = paths.map((file) => file.trim()).filter(Boolean);
  const docsOnly =
    files.length > 0 &&
    files.every((file) => file.startsWith('docs/') || file.endsWith('.md'));
  const migrations = files.some(isMigrationPath);
  const boardE2e = files.some(isBoardE2ePath);
  const homepageE2e = files.some(isHomepageE2ePath);
  const unknownCode =
    !docsOnly &&
    files.length > 0 &&
    !migrations &&
    !boardE2e &&
    !homepageE2e;

  return { docsOnly, migrations, boardE2e, homepageE2e, unknownCode };
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
