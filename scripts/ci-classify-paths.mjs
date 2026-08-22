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
      /* The suite's own spec. The other four journey predicates match the
         spec they run; this one was the last that did not, so an edit to
         board-governance.spec.ts could not run itself. The homepage case was
         fixed in #555 and the board case was missed in the same pass -- the
         assertion block that caught it stopped at four. */
      'apps/web/e2e/board-governance',
      /* The sign-in door. Every one of this suite's three tests is an
         unauthenticated redirect check that lands on /login and asserts the
         'The Bell' heading is visible, and SignInPanel is the only thing that
         renders it. So the front door is a surface this suite covers, and it
         reached only the homepage and signed-in predicates before. Narrower
         than isSignedInJourneyPath on purpose: this suite never signs in, so
         the session gate and server auth module are not surfaces it touches. */
      'apps/web/app/login/',
      'apps/web/components/SignInPanel',
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
      /* The suite's own spec. Every other journey predicate matches the spec
         it runs; this one did not, so an edit to public-homepage.spec.ts
         could not run itself -- the suite stayed skipped on the exact commit
         that changed what it asserts. */
      'apps/web/e2e/public-homepage',
      /* The sign-in door. public-homepage.spec.ts opens /login and asserts on
         the methods it offers, so SignInPanel and its route are surfaces this
         suite covers -- they were reachable only through the three SIGNED-IN
         predicates, which do not run this one. A change to the front door
         went out with the homepage journey skipped. Deliberately narrower
         than isSignedInJourneyPath: the rest of that plumbing (the page
         guard, the session gate, the server auth module) is not something an
         unauthenticated visitor's journey touches. */
      'apps/web/app/login/',
      'apps/web/components/SignInPanel',
    ]) ||
    ['Home', 'Landing', 'Public'].some((token) => component.includes(token))
  );
};

/* The plumbing every SIGNED-IN journey stands on, regardless of role: the
   sign-in panel and its route, the client role cache, the gate that asks the
   server who you are, the shell those gated pages render inside, the server
   page guard, the routing table that decides where a role lands, the shared
   e2e sign-in helper, and the Playwright config itself. A change to any of
   these can break the coach, athlete and guardian journeys at once, so all
   three predicates below consult this rather than restating it three times
   and drifting. */
const isSignedInJourneyPath = (file) =>
  startsWithAny(file, [
    'apps/web/app/login/',
    'apps/web/components/SignInPanel',
    'apps/web/components/roleSession',
    'apps/web/components/RoleSessionGate',
    'apps/web/components/RoleStandaloneView',
    'apps/web/src/shared/pilotRoleRouting',
    'apps/web/src/server/pilot/auth',
    'apps/web/src/server/pilot/pageGuard',
    'apps/web/app/api/pilot/auth/',
    'apps/web/e2e/support/',
  ]) || file === 'apps/web/playwright.config.ts';

const isCoachE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    isSignedInJourneyPath(file) ||
    startsWithAny(file, [
      'apps/web/app/coach/',
      'apps/web/app/api/pilot/coach/',
      'apps/web/app/api/pilot/shadow/',
      'apps/web/app/api/pilot/athletes/',
      'apps/web/e2e/coach-journey',
    ]) ||
    component.includes('Coach')
  );
};

const isAthleteE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    isSignedInJourneyPath(file) ||
    startsWithAny(file, [
      'apps/web/app/athlete/',
      'apps/web/app/api/pilot/athlete/',
      'apps/web/app/api/pilot/progression/',
      'apps/web/src/server/pilot/credentialPolicy',
      'apps/web/src/server/pilot/pinPolicy',
      'apps/web/e2e/athlete-journey',
    ]) ||
    component.includes('Athlete')
  );
};

/* 'parent' is the canonical guardian role in this codebase, and /guardian
   redirects into the Parent Hub -- so the guardian journey moves whenever
   either name does. */
const isGuardianE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    isSignedInJourneyPath(file) ||
    startsWithAny(file, [
      'apps/web/app/parent/',
      'apps/web/app/guardian/',
      'apps/web/app/api/pilot/parent/',
      'apps/web/app/api/pilot/profile/',
      'apps/web/e2e/guardian-journey',
    ]) ||
    ['Parent', 'Guardian'].some((token) => component.includes(token))
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
  const coachE2e = files.some(isCoachE2ePath);
  const athleteE2e = files.some(isAthleteE2ePath);
  const guardianE2e = files.some(isGuardianE2ePath);
  const unknownCode =
    !docsOnly &&
    files.length > 0 &&
    !migrations &&
    !boardE2e &&
    !homepageE2e &&
    !coachE2e &&
    !athleteE2e &&
    !guardianE2e;

  return {
    docsOnly,
    migrations,
    boardE2e,
    homepageE2e,
    coachE2e,
    athleteE2e,
    guardianE2e,
    unknownCode,
  };
}

function outputLines(result) {
  return [
    `docs_only=${result.docsOnly}`,
    `migrations=${result.migrations}`,
    `board_e2e=${result.boardE2e}`,
    `homepage_e2e=${result.homepageE2e}`,
    `coach_e2e=${result.coachE2e}`,
    `athlete_e2e=${result.athleteE2e}`,
    `guardian_e2e=${result.guardianE2e}`,
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
        `- coach journey E2E: ${result.coachE2e}`,
        `- athlete journey E2E: ${result.athleteE2e}`,
        `- guardian journey E2E: ${result.guardianE2e}`,
        `- unknown/general code: ${result.unknownCode}`,
        '',
      ].join('\n'),
    );
  }
}
