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
 * ADMIN AUTHENTICATION IS A TEST-HARNESS BOOTSTRAP, NOT A PRODUCT CLAIM.
 * org_admin_shadow is a Microsoft-provider account on an @ppbf.invalid address
 * that can never receive mail and has no PIN, so no interactive path can sign it
 * in. The spec writes one short-lived magic-link row (hash only) and lets the
 * application's own /auth/link page redeem it, so the SERVER sets the httpOnly
 * cookie through the real consume route. Nothing here proves Microsoft SSO works.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
let rawMagicToken = '';
let magicTokenHash = '';
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

  const account = await client.query<{ login_email: string; organization_id: string }>(
    'select login_email, organization_id from pilot.accounts where account_id = $1',
    [ADMIN_ACCOUNT],
  );
  rawMagicToken = randomBytes(32).toString('hex');
  magicTokenHash = sha256(rawMagicToken);
  await client.query(
    `insert into pilot.magic_link_tokens
       (token_hash, account_id, organization_id, sent_to_email, expires_at)
     values ($1, $2, $3, $4, now() + interval '20 minutes')`,
    [magicTokenHash, ADMIN_ACCOUNT, account.rows[0].organization_id, account.rows[0].login_email],
  );
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
  if (magicTokenHash) {
    await step('closure magic-link row removed', async () =>
      `${(await client.query('delete from pilot.magic_link_tokens where token_hash = $1', [magicTokenHash])).rowCount} row(s)`);
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
          where account_id in ($3,$4,$5) and created_at >= $6) as closure_sessions,
       (select count(*)::int from pilot.magic_link_tokens where token_hash = $7) as closure_magic_rows`,
    [attemptId || 'none', ATHLETE_ID, ATHLETE_ACCOUNT, COACH_ACCOUNT, ADMIN_ACCOUNT, startedAt, magicTokenHash || 'none'],
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

test('R1 -- the athlete renders their attempt and the coach disposition, with no reviewer identity', async ({ page }) => {
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
  await expect(page.getByText('/ target 10', { exact: false }).first(),
    'R1.2 the attempt is rendered').toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/film review shows twelve clean reps/i).first(),
    'R1.3 the current coach disposition is rendered').toBeVisible({ timeout: 20000 });

  // R1.4 no internal reviewer identity anywhere in the rendered surface.
  await assertNoReviewerIdentity(page, 'R1.4 athlete Attempts');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'r1-athlete-attempts.png'), fullPage: true });
});

test('R2/R3 -- an admin renders the attempt and its disposition, and is offered no review controls', async ({ page }) => {
  /* The application's own page redeems the link and the SERVER sets the cookie.
     No cookie is injected and no page script is evaluated by the harness. */
  await page.goto(`${BASE}/auth/link?token=${rawMagicToken}`);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/link'), { timeout: 30000 });

  const session = await page.request.get(`${BASE}/api/pilot/auth/session`);
  expect(session.status(), 'admin session resolves').toBe(200);
  const resolved = await session.json();
  expect(JSON.stringify(resolved), 'session is org_admin_shadow').toContain(ADMIN_ACCOUNT);
  expect(JSON.stringify(resolved), 'session role is organization_admin').toContain('organization_admin');

  await page.goto(`${BASE}/coach/attempt-log`);
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
});
