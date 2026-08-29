import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const startsWithAny = (file, prefixes) =>
  prefixes.some((prefix) => file.startsWith(prefix));

const directComponentName = (file) => {
  const prefix = 'apps/web/components/';
  if (!file.startsWith(prefix)) return '';
  const name = file.slice(prefix.length);
  return name.includes('/') ? '' : name;
};

/* Documentation, by the exact rule `docsOnly` below has always used, lifted
   into a named predicate so the unclassified-path list cannot drift from it.
   The list needs it: a diff of forty documentation files plus one server
   module should report the ONE module as unrecognised code, not all
   forty-one. Commit 814a5263 on `main` is precisely that shape -- 47 files
   under docs/capabilities/modules/ and a single .test.ts. */
const isDocumentationPath = (file) =>
  file.startsWith('docs/') || file.endsWith('.md');

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
      /* THE SHARED CHASSIS. board-governance.spec.ts drives a board session
         through the same session bar and standalone band every other role
         uses, so a change to either is a change to what this suite walks
         through -- and `board` is a role those components make decisions
         about. The Operations restriction is the case that exposed the gap:
         it removed a control from the board role's bar and put `board` on the
         refused side, and this predicate matched none of it, so the board
         journey stayed skipped on the exact commit that changed it. Same
         class of miss the comment above records for this predicate's own
         spec. Still narrower than isSignedInJourneyPath: the session gate and
         the server auth module are not surfaces a suite that never signs in
         touches. */
      'apps/web/components/GlobalRoleHeader',
      'apps/web/components/RoleStandaloneView',
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
      /* THE ROUTES THIS SUITE ASSERTS ARE CLOSED. public-homepage.spec.ts
         ends on a protected-routes block that opens /operations as an
         unauthenticated visitor and requires the redirect to /login -- so
         that route is a surface this suite covers, and it reached this
         predicate through nothing. The Operations restriction changed who
         that route admits and this suite, the one holding the signed-out
         assertion about it, stayed skipped. */
      'apps/web/app/operations/',
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
    /* The Card Catalog is how a signed-in person reaches most of this
       building, it mounts on every gated surface, and coach-journey.spec.ts
       now measures its rows. Without this line a change to the catalog itself
       ran none of the suites that assert it. */
    'apps/web/components/CardCatalog',
    /* THE SHARED STYLESHEETS, and this one is a policy change worth stating.
       `design-system/**` already set homepage_e2e and golden_era_e2e -- the
       Bell's resolved-style proof and the eight scope proofs. Neither of those
       suites looks at the chrome a signed-in person actually operates, so a
       stylesheet edit could break the catalog, the session bar or the
       standalone band on every gated route in the building and CI would have
       run no suite capable of noticing.

       That is not hypothetical either: `.catalog-row` shipped with a title
       column that collapsed to zero width on any narrow viewport, and it was
       found by a test written for an unrelated change, not by CI.

       The cost is the three signed-in journeys on stylesheet PRs. They need
       no database and Chromium is already installed for those PRs by the two
       flags above, so it is roughly ninety seconds -- against a class of
       regression that reaches every signed-in surface at once. */
    'design-system/',
  ]) || file === 'apps/web/playwright.config.ts';

/* THE GOLDEN-ERA RESOLVED-STYLE PROOFS (e2e/golden-era-scope-proofs.spec.ts).
   ------------------------------------------------------------------------

   One suite, eight scope classes, eight routes, and one deliberate rule about
   when it runs: A CHANGE TO THE GOLDEN-ERA SHEET MUST RUN EVERY SCOPE PROOF,
   not just the homepage one.

   That is why this predicate exists at all. `design-system/**` already sets
   homepage_e2e, and public-homepage.spec.ts is where the `.ge-bell` proof
   lives -- so before this, editing ppbf-golden-era.css ran the Bell's resolved
   -style check and nothing else, while the same file declares the ramp for
   `.ge-scripts`, `.ge-afterhours`, `.ge-scheduler`, `.ge-frontoffice`,
   `.ge-drillcase`, `.ge-locker` and `.ge-floorboard`. A regression on any of
   the other seven went out with its proof unexecuted.

   The surfaces below are the ones a scope proof actually reads:

     * the sheets that declare the ramps, and app/globals.css, whose `:root`
       token ALIASES (--accent, --accent-strong) are the source of a leak this
       suite records;
     * the routes that carry a scope class, plus the two workspace components
       mounted inside two of them;
     * the suite's own spec -- every other journey predicate matches the spec
       it runs, and the two that did not could not run themselves;
     * the signed-in plumbing, via isSignedInJourneyPath: seven of the eight
       scopes are behind a role gate, so the gate, the session cache, the role
       routing table, the shared sign-in helper and the Playwright config are
       all surfaces this suite stands on. */
const isGoldenEraE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    isSignedInJourneyPath(file) ||
    startsWithAny(file, [
      'design-system/',
      'apps/web/app/globals.css',
      'apps/web/app/admin/people/',
      'apps/web/app/admin/shadow/',
      'apps/web/app/athlete/dashboard/',
      'apps/web/app/coach/drills/',
      'apps/web/app/coach/environment/',
      'apps/web/app/coach/session-scripts/',
      'apps/web/app/schedule/',
      'apps/web/e2e/golden-era-scope-proofs',
    ]) ||
    ['CoachWorkspace', 'AthleteWorkspace'].some((token) => component.includes(token))
  );
};

const isCoachE2ePath = (file) => {
  const component = directComponentName(file);
  return (
    isSignedInJourneyPath(file) ||
    startsWithAny(file, [
      'apps/web/app/coach/',
      'apps/web/app/api/pilot/coach/',
      'apps/web/app/api/pilot/coach-reviews/',
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
      'apps/web/app/api/pilot/parent-tasks/',
      'apps/web/app/api/pilot/profile/',
      'apps/web/e2e/guardian-journey',
    ]) ||
    ['Parent', 'Guardian'].some((token) => component.includes(token))
  );
};

/* THE ACTIVATION JOURNEY (e2e/activation-journey.spec.ts).
   ------------------------------------------------------------------------

   Its own predicate rather than a few lines bolted onto isAthleteE2ePath, for
   one reason: this journey is UNAUTHENTICATED. Every surface it walks is
   reached by someone who holds no session at all -- a new athlete's account
   has pin_hash null and active_flag false until a code is redeemed, so they
   cannot be signed in while doing this. isSignedInJourneyPath, which the other
   three journeys all consult, is therefore not part of this one: the session
   gate, the role cache and the routing table are not on this path.

   What IS on it, and why each is here:

     * /activate and its route -- the journey itself.
     * /athlete/sign-in -- the door the athlete lands on and the only place
       linking to /activate. A change that drops that link strands them again,
       which is the defect this suite was written for, so the suite has to run
       on it.
     * pinPolicy -- the refusals the journey types into the form, and the
       sentence PIN_RULE_SUMMARY shows before they type. The suite asserts the
       sentence names the shapes the policy refuses.
     * the suite's own spec -- three predicates in this file previously did
       not match the spec they run, so an edit to a spec could not run itself.
       Stated here from the start rather than fixed later.

   Note that pinPolicy and app/athlete/ already reach isAthleteE2ePath, so a
   change to either runs both suites. That is correct rather than wasteful:
   they assert different things about the same file, and the athlete journey
   does not walk activation. */
const isActivationE2ePath = (file) =>
  startsWithAny(file, [
    'apps/web/app/activate/',
    'apps/web/app/athlete/sign-in/',
    'apps/web/app/api/pilot/auth/activate/',
    'apps/web/src/server/pilot/activation',
    'apps/web/src/server/pilot/pinPolicy',
    'apps/web/e2e/activation-journey',
    'apps/web/e2e/support/',
  ]) || file === 'apps/web/playwright.config.ts';

export function classifyPaths(paths) {
  const files = paths.map((file) => file.trim()).filter(Boolean);
  const docsOnly = files.length > 0 && files.every(isDocumentationPath);
  const migrations = files.some(isMigrationPath);
  const boardE2e = files.some(isBoardE2ePath);
  const homepageE2e = files.some(isHomepageE2ePath);
  const coachE2e = files.some(isCoachE2ePath);
  const athleteE2e = files.some(isAthleteE2ePath);
  const guardianE2e = files.some(isGuardianE2ePath);
  const goldenEraE2e = files.some(isGoldenEraE2ePath);
  const activationE2e = files.some(isActivationE2ePath);
  const unknownCode =
    !docsOnly &&
    files.length > 0 &&
    !migrations &&
    !boardE2e &&
    !homepageE2e &&
    !coachE2e &&
    !athleteE2e &&
    !guardianE2e &&
    !goldenEraE2e &&
    !activationE2e;

  /* WHICH files were unrecognised, not merely whether any were. The boolean
     alone cannot be reported usefully: "this diff touched code no predicate
     recognises" is only actionable if it names the code, because widening a
     predicate requires knowing the path that missed it.

     Populated only when `unknownCode` is true, so the list and the boolean
     always agree. `unknownCode` is a whole-diff verdict -- it is true only
     when NO file matched ANY predicate -- so when it fires, every
     non-documentation file in the diff is unrecognised, and that is the list.

     It is never empty when `unknownCode` is true: `unknownCode` requires
     `!docsOnly`, and `docsOnly` is false exactly when some file is not
     documentation. The self-test pins both directions. */
  const unclassifiedPaths = unknownCode
    ? files.filter((file) => !isDocumentationPath(file))
    : [];

  return {
    docsOnly,
    migrations,
    boardE2e,
    homepageE2e,
    coachE2e,
    athleteE2e,
    guardianE2e,
    goldenEraE2e,
    activationE2e,
    unknownCode,
    unclassifiedPaths,
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
    `golden_era_e2e=${result.goldenEraE2e}`,
    `activation_e2e=${result.activationE2e}`,
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

    /* The path list is multi-line, so it needs GITHUB_OUTPUT's heredoc form
       rather than key=value. The delimiter is randomised per run because a
       predictable one is how a crafted filename would close the block early
       and inject an output of its own. */
    const delimiter = `PPBF_UNCLASSIFIED_${randomUUID()}`;
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `unclassified_paths<<${delimiter}\n${result.unclassifiedPaths.join('\n')}\n${delimiter}\n`,
    );
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
        `- golden-era scope proofs E2E: ${result.goldenEraE2e}`,
        `- unknown/general code: ${result.unknownCode}`,
        '',
      ].join('\n'),
    );
  }
}
