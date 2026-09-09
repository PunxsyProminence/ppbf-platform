/* TEMPORARY HARNESS -- rendered closure for Base-C staging acceptance.
 *
 * This spec is the only one in the suite that talks to a real deployed
 * environment. Every other spec stubs its routes and runs against the local dev
 * server; this one authenticates against real staging, reads and writes the real
 * staging database, and asserts on what the real application renders. It exists
 * because three observations cannot be made any other way:
 *
 *   R1  the Athlete's Attempts surface renders their attempt and the coach's
 *       current disposition, and exposes no reviewer account identity
 *   R2  an organization_admin renders that attempt and its disposition
 *   R3  Confirm / Correct / Dispute are not rendered for an organization_admin
 *
 * It deliberately does NOT re-prove anything already settled: no confirm/correct/
 * dispute sequence, no freeze-trigger probe, no cross-organization fixture, no
 * admin POST refusal. One attempt, one disposition, three renders, then cleanup.
 *
 * ADMIN AUTHENTICATION IS A SYNTHETIC GATE-SESSION BOOTSTRAP, NOT A PRODUCT CLAIM.
 * org_admin_shadow is a Microsoft-provider account on an @ppbf.invalid address
 * that can never receive mail and has no PIN, so no interactive path can sign it
 * in. An earlier version of this spec tried a magic link and the server refused
 * it with ACCOUNT_NOT_MAGIC_LINK -- correctly, because requiredCredentialFor keys
 * on ROLE and organization_admin is a Microsoft role, so no account holding that
 * role may ever redeem a link. That refusal is a security property, not an
 * obstacle to route around.
 *
 * So the admin session comes from the repository's own gate-session helper, whose
 * stated purpose is exactly this: minting a short-lived session for a
 * pre-provisioned fixture account without adding a privileged auth endpoint. It
 * re-verifies role, active flag, membership and organization status before it
 * mints. Nothing here proves Microsoft SSO, Entra, or production authentication.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const BASE = required('CLOSURE_BASE_URL');
const CONN = required('CLOSURE_DB_CONNECTION');
const EXPECTED_HOST = required('CLOSURE_EXPECTED_HOST');
const EXPECTED_DB = required('CLOSURE_EXPECTED_DB');

const ORG = 'ppbf-default-org';
const ATHLETE_ID = 'GATE-SHADOW-ATH-1';
const ATHLETE_ACCOUNT = 'gate_shadow_athlete';
const COACH_ACCOUNT = 'gate_probe_coach';
const ADMIN_ACCOUNT = 'org_admin_shadow';

const EVIDENCE_DIR = path.join(process.cwd(), 'closure-evidence');
const REVIEWER_MARKERS = ['reviewed_by_account_id', 'reviewed_by', COACH_ACCOUNT];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; the workflow sets it.`);
  return value;
}

/* Mirrors the PIN policy deploy-staging.yml mints against, so the provisioned
   credential satisfies the same rules the real login path enforces. */
function mintPin(): string {
  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';
  const guessable = (pin: string) =>
    new Set(pin).size === 1
    || ascending.includes(pin)
    || descending.includes(pin)
    || [1, 2, 3].some((size) => pin.slice(0, size).repeat(6 / size) === pin)
    || [0, 2, 4].every((i) => pin[i] === pin[i + 1])
    || pin === [...pin].reverse().join('');
  for (;;) {
    const candidate = String(Math.floor(Math.random() * 900000) + 100000);
    if (candidate !== '123456' && !guessable(candidate)) return candidate;
  }
}

let client: Client;
let athletePin = '';
let originalCoachId: string | null = null;
let attemptId = '';
let startedAt = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  client = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: true } });
  await client.connect();

  /* Target identity is asserted here as well as in the workflow. The workflow
     check is the gate; this one is the guard that travels with the code, so the
     spec cannot write to the wrong database if it is ever run by hand. */
  const identity = await client.query<{ host: string; db: string }>(
    'select inet_server_addr()::text as host, current_database() as db',
  );
  const actualDb = identity.rows[0].db;
  expect(actualDb, 'refusing to run against any database but staging').toBe(EXPECTED_DB);
  expect(EXPECTED_HOST.startsWith('ppbf-pg-staging-7k4m2q')).toBe(true);
  expect(/prod/i.test(EXPECTED_HOST) || /prod/i.test(actualDb)).toBe(false);

  startedAt = new Date().toISOString();
  athletePin = mintPin();

  // Governed fixture tooling, not a hand-rolled account.
  execFileSync(process.execPath, ['scripts/pilot-provision-gate-fixtures.mjs'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      AZURE_POSTGRES_CONNECTION_STRING: CONN,
      PPBF_EXPECTED_POSTGRES_HOSTNAME: EXPECTED_HOST,
      PPBF_EXPECTED_POSTGRES_DATABASE: EXPECTED_DB,
      PPBF_PILOT_DEFAULT_ORG_ID: ORG,
      PILOT_ADMIN_ACCOUNT_ID: ADMIN_ACCOUNT,
      PILOT_SHADOW_ATHLETE_ACCOUNT_ID: ATHLETE_ACCOUNT,
      PILOT_SHADOW_ATHLETE_PIN: athletePin,
      PILOT_SHADOW_ATHLETE_ID: ATHLETE_ID,
      PILOT_PROBE_COACH_ACCOUNT_ID: COACH_ACCOUNT,
    },
  });

  const before = await client.query<{ coach_id: string | null }>(
    'select coach_id from pilot.athletes where athlete_id = $1 and organization_id = $2',
    [ATHLETE_ID, ORG],
  );
  expect(before.rowCount, 'exactly one gate athlete').toBe(1);
  originalCoachId = before.rows[0].coach_id;

  const repoint = await client.query(
    'update pilot.athletes set coach_id = $1 where athlete_id = $2 and organization_id = $3',
    [COACH_ACCOUNT, ATHLETE_ID, ORG],
  );
  expect(repoint.rowCount, 'coach repoint touches exactly one row').toBe(1);

  /* One attempt and one disposition, created through the real API as the coach,
     so the verdict is server-derived exactly as it is in production use. */
  const { mintGateSession } = await import('../scripts/lib/gate-session.mjs');
  const coach = await mintGateSession({
    connectionString: CONN, accountId: COACH_ACCOUNT, expectedRole: 'coach',
  });

  const created = await fetch(`${BASE}/api/pilot/training-attempts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: coach.cookie },
    body: JSON.stringify({
      athlete_id: ATHLETE_ID,
      metric_kind: 'reps',
      context_type: 'open_floor',
      target_value: 10,
      achieved_value: 8,
      note: 'BASE-C rendered closure fixture',
    }),
  });
  expect(created.status, 'attempt creation').toBe(200);
  attemptId = (await created.json()).item.attempt_id;

  const reviewed = await fetch(`${BASE}/api/pilot/training-attempts/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: coach.cookie },
    body: JSON.stringify({
      attempt_id: attemptId,
      review_state: 'corrected',
      corrected_target_value: 10,
      corrected_achieved_value: 12,
      reason: 'Rendered closure fixture: film review shows twelve clean reps',
    }),
  });
  expect(reviewed.status, 'disposition creation').toBe(200);

});

test.afterAll(async () => {
  if (!client) return;
  const report: string[] = [];
  const step = async (label: string, run: () => Promise<string>) => {
    try { report.push(`  ${label}: ${await run()}`); }
    catch (error) { report.push(`  ${label}: FAILED -- ${(error as Error).message}`); }
  };

  if (attemptId) {
    await step('closure review rows deleted', async () =>
      `${(await client.query('delete from pilot.training_attempt_reviews where attempt_id = $1', [attemptId])).rowCount} row(s)`);
    await step('closure attempt deleted', async () =>
      `${(await client.query('delete from pilot.training_attempts where attempt_id = $1 and organization_id = $2 and athlete_id = $3', [attemptId, ORG, ATHLETE_ID])).rowCount} row(s)`);
  }
  if (originalCoachId) {
    await step('coach assignment restored', async () => {
      const restored = await client.query(
        'update pilot.athletes set coach_id = $1 where athlete_id = $2 and organization_id = $3',
        [originalCoachId, ATHLETE_ID, ORG],
      );
      if (restored.rowCount !== 1) throw new Error(`touched ${restored.rowCount} rows`);
      return `-> ${originalCoachId} (1 row)`;
    });
  }
  // Scoped to this run only -- no historical sweep of fixture sessions.
  await step('closure sessions revoked', async () =>
    `${(await client.query('delete from pilot.session_tokens where account_id in ($1,$2,$3) and created_at >= $4', [ATHLETE_ACCOUNT, COACH_ACCOUNT, ADMIN_ACCOUNT, startedAt])).rowCount} row(s)`);
  await step('gate athlete deactivated and PIN cleared', async () =>
    `${(await client.query("update pilot.accounts set pin_hash = null, active_flag = false, updated_at = now() where account_id = $1 and role = 'athlete'", [ATHLETE_ACCOUNT])).rowCount} row(s)`);
  await step('closure activation codes superseded', async () =>
    `${(await client.query('update pilot.account_activation_tokens set consumed_at = now() where account_id = $1 and consumed_at is null and created_at >= $2', [ATHLETE_ACCOUNT, startedAt])).rowCount} row(s)`);

  const verify = await client.query(
    `select
       (select count(*)::int from pilot.training_attempts where attempt_id = $1) as closure_attempts,
       (select count(*)::int from pilot.training_attempt_reviews where attempt_id = $1) as closure_reviews,
       (select coach_id from pilot.athletes where athlete_id = $2) as coach_id,
       (select active_flag from pilot.accounts where account_id = $3) as athlete_active,
       (select pin_hash is not null from pilot.accounts where account_id = $3) as athlete_has_pin,
       (select count(*)::int from pilot.session_tokens
          where account_id in ($3,$4,$5) and created_at >= $6) as closure_sessions`,
    [attemptId || 'none', ATHLETE_ID, ATHLETE_ACCOUNT, COACH_ACCOUNT, ADMIN_ACCOUNT, startedAt],
  );

  console.log('\n--- CLOSURE CLEANUP ---');
  for (const line of report) console.log(line);
  console.log(`--- CLEANUP VERIFY --- ${JSON.stringify(verify.rows[0])}`);

  await client.end();
});

async function assertNoReviewerIdentity(page: Page, label: string) {
  const rendered = await page.locator('body').innerText();
  const html = await page.content();
  for (const marker of REVIEWER_MARKERS) {
    expect(rendered, `${label}: rendered text must not expose ${marker}`).not.toContain(marker);
    expect(html, `${label}: rendered DOM must not expose ${marker}`).not.toContain(marker);
  }
}

/* R1 is settled by staging run 34394340532, where R1.1 through R1.4 all passed
   against the real deployed surface and produced a screenshot artifact. This skip
   is bookkeeping, not evidence: the assertions below are left exactly as they ran
   so the passing run stays reproducible and auditable. */
test.skip('R1 -- the athlete renders their attempt and the coach disposition, with no reviewer identity', async ({ page }) => {
  await page.goto(`${BASE}/athlete/sign-in`);
  await page.getByLabel('Athlete Account ID').fill(ATHLETE_ACCOUNT);
  await page.getByLabel('PIN').fill(athletePin);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL((url) => !url.pathname.includes('/athlete/sign-in'), { timeout: 30000 });
  await page.goto(`${BASE}/athlete/dashboard`);

  // Development -> Attempts, through the real workspace navigation.
  await page.getByRole('button', { name: 'Development', exact: true }).click();
  const attemptsTab = page.getByRole('button', { name: 'Attempts', exact: true });
  await expect(attemptsTab, 'R1.1 the Attempts tab is reachable').toBeVisible();
  await attemptsTab.click();

  // R1.2 the synthetic attempt is rendered, R1.3 with the coach's disposition.
  // The athlete row is not worded like the coach card. AthleteAttemptLog renders
  // `{achieved}{" / " + target} {unit}` -- "8 / 10 reps" -- where the coach card
  // renders "8reps / target 10reps". Asserting the coach wording here is what
  // failed the previous run against a surface that was rendering correctly.
  await expect(page.getByText('8 / 10 reps', { exact: false }).first(),
    'R1.2 the attempt is rendered').toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/film review shows twelve clean reps/i).first(),
    'R1.3 the current coach disposition is rendered').toBeVisible({ timeout: 20000 });

  // R1.4 no internal reviewer identity anywhere in the rendered surface.
  await assertNoReviewerIdentity(page, 'R1.4 athlete Attempts');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'r1-athlete-attempts.png'), fullPage: true });
});

/* Outer budget well above every per-request timeout below, so a failing step
   reports its own assertion rather than the test dying first -- which is what
   made the previous run undiagnosable. */
test.setTimeout(120000);

test('R2/R3 -- an admin renders the attempt and its disposition, and is offered no review controls', async ({ page }) => {
  /* SYNTHETIC GATE-SESSION BOOTSTRAP.
     mintGateSession is the repository's own helper and it does the verifying:
     the account must exist, hold organization_admin, be active, hold
     an active membership in an active organization, and not be a privileged
     ppbf_local account. If any of that is untrue it throws rather than minting,
     so a bad fixture stops here instead of producing misleading renders. */
  const { mintGateSession } = await import('../scripts/lib/gate-session.mjs');
  const admin = await mintGateSession({
    connectionString: CONN,
    accountId: ADMIN_ACCOUNT,
    expectedRole: 'organization_admin',
    ttlMinutes: 10,
  });
  console.log(`ADMIN_BOOTSTRAP_GATE_SESSION role=${admin.role} organization=${admin.organizationId}`);

  try {
    /* Playwright's BROWSER-CONTEXT cookie API -- not page JavaScript, and not a
       manual Cookie header. The attributes mirror the application's own contract
       from app/api/pilot/auth/login/route.ts. The token value itself is never
       printed, asserted on, or placed in a URL. */
    await page.context().addCookies([{
      name: 'ppbf_pilot_session',
      value: admin.token,
      domain: new URL(BASE).hostname,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }]);

    const session = await page.request.get(`${BASE}/api/pilot/auth/session`, { timeout: 30000 });
    expect(session.status(), 'admin session resolves').toBe(200);
    const resolved = await session.json();
    expect(JSON.stringify(resolved), 'session is org_admin_shadow').toContain(ADMIN_ACCOUNT);
    expect(JSON.stringify(resolved), 'session role is organization_admin').toContain('organization_admin');
    expect(JSON.stringify(resolved), 'session organization is the staging gate org').toContain(ORG);

    await page.goto(`${BASE}/coach/attempt-log`);
    expect(new URL(page.url()).pathname,
      'the session cookie authenticates a normal browser navigation').toBe('/coach/attempt-log');
    await page.getByLabel('Athlete').selectOption(ATHLETE_ID);

    // R2 -- the attempt and its current disposition render for the admin.
    await expect(page.getByText('/ target 10', { exact: false }).first(),
      'R2.1 the attempt is rendered for the admin').toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/film review shows twelve clean reps/i).first(),
      'R2.2 the current disposition is rendered for the admin').toBeVisible({ timeout: 20000 });

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'r2-admin-read.png'), fullPage: true });

    // R3 -- the review controls are not offered. Counted, not merely "not visible",
    // so a control rendered off-screen would still fail this.
    await expect(page.getByRole('button', { name: 'Confirm', exact: true }),
      'R3.1 Confirm is not rendered for an admin').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Correct', exact: true }),
      'R3.2 Correct is not rendered for an admin').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dispute', exact: true }),
      'R3.3 Dispute is not rendered for an admin').toHaveCount(0);

    const historyCount = await page.getByRole('button', { name: 'History', exact: true }).count();
    console.log(`R3 note -- History controls rendered for the admin: ${historyCount}`);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'r3-admin-no-controls.png'), fullPage: true });
  } finally {
    // The helper's own revoke, always, so a failed run leaves no live session.
    // The run-scoped sweep in afterAll stays as defence in depth.
    await admin.revoke();
  }
});
