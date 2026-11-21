/**
 * @jest-environment jsdom
 */

// /admin/system (WO-N7-03): a truthful, read-only inventory for the platform owner. What these pin:
// every audited route is listed and none claims a runtime status; the job list is exactly the
// workflow folder, each job's triggers are the file's own, and each says its status is unavailable
// with a link to its runs; the scripts no workflow runs say so; nothing on the page can run or
// change anything. Who may open it is pinned in page.guard.test.tsx.

import fs from 'node:fs';
import path from 'node:path';

import { render, screen, within } from '@testing-library/react';

import inventory from '@/src/server/pilot/apiRouteInventory.json';
import type { PilotRole } from '@/src/server/pilot/contracts';

import AdminSystemPage from './page';

const principal: { role: PilotRole | null } = { role: 'platform_owner' };

// jsdom has no Request, so the real guard runs in page.guard.test.tsx (node). Here it is faked.
jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: async () => ({ accountId: 'acct_1', organizationId: 'org_1', role: principal.role }),
}));

// The platform view reads no gym data; any call here fails the test.
const noGymRead = () => {
  throw new Error('the platform view read gym data');
};
jest.mock('@/src/server/pilot/localFindings', () => ({ listLocalFindings: () => noGymRead() }));
jest.mock('@/src/server/pilot/sourceCitationChecks', () => ({ getSourceCitationStatus: () => noGymRead() }));
jest.mock('@/src/server/pilot/sourceRetractionChecks', () => ({ getSourceRetractionStatus: () => noGymRead() }));

// The worker's setting comes from the same report GET /api/pilot/ops/readiness serves.
const readiness = { workerOn: false };
jest.mock('@/src/server/pilot/pilotOpsReadiness', () => ({
  buildPilotOpsReadinessReport: () => ({ shadowWorker: { enabled: readiness.workerOn } }),
}));

// Lane BT, BOA-13: the Stripe platform config the registration section reads (a yes or no).
const payment: { connectClientId: string | null; platformSecretKey: string | null; webhookSecret: string | null } = {
  connectClientId: null,
  platformSecretKey: null,
  webhookSecret: null,
};
jest.mock('@/src/server/pilot/paymentConnect', () => ({
  readPaymentPlatformConfig: () => ({ ...payment }),
}));

const WORKFLOWS_DIR = path.join(__dirname, '../../../../../.github/workflows');
const SCRIPTS_DIR = path.join(__dirname, '../../../scripts');

function workflowFiles(): string[] {
  return fs.readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/.test(file)).sort();
}

/** The triggers a workflow file declares under its top-level `on:` block. */
function fileTriggers(file: string): string[] {
  const lines = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  // Every workflow here writes `on:` as a block; an inline form must be read before it is listed.
  expect(start).toBeGreaterThan(-1);
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z_]+):/.exec(line);
    if (match) found.push(match[1]);
  }
  const words: Record<string, string> = {
    schedule: 'schedule',
    workflow_dispatch: 'manual',
    pull_request: 'pull request',
    push: 'push',
  };
  return found.map((key) => words[key] ?? key).sort();
}

async function renderAs(role: PilotRole) {
  principal.role = role;
  render(await AdminSystemPage());
}

function fileName(file: string): string {
  const line = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').split('\n').find((row) => /^name:/.test(row)) ?? '';
  return line.replace(/^name:\s*/, '').trim();
}

function tableRows(headingName: RegExp): HTMLElement[] {
  const section = screen.getByRole('heading', { name: headingName }).closest('section') as HTMLElement;
  return within(within(section).getByRole('table')).getAllByRole('row').slice(1);
}

beforeEach(() => {
  principal.role = 'platform_owner';
  readiness.workerOn = false;
  payment.connectClientId = null;
  payment.platformSecretKey = null;
  payment.webhookSecret = null;
});

test('every inventory route is listed, and none claims a runtime status', async () => {
  await renderAs('platform_owner');
  const rows = tableRows(/^Routes/);
  expect(rows).toHaveLength(inventory.length);
  expect(screen.getByRole('heading', { name: `Routes (${inventory.length})` })).toBeTruthy();
  inventory.forEach((route, index) => {
    const cells = within(rows[index]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells[0]).toBe(`${route.method} ${route.path}`);
    expect(cells[1]).toBe(route.gate);
    expect(cells[2]).toBe(route.rolesAdmitted.length > 0 ? route.rolesAdmitted.join(', ') : 'None listed');
    expect(cells[3]).toBe(route.writes ? 'Yes' : 'No');
    expect(cells[4]).toBe(route.athleteData ? 'Yes' : 'No');
    expect(cells[5]).toBe(route.notes);
    expect(cells[6]).toBe('No runtime status recorded');
  });
});

test('the job list is exactly the workflow folder, with each file\'s own triggers', async () => {
  await renderAs('platform_owner');
  const rows = tableRows(/^Jobs/).slice(0, -1);
  const files = workflowFiles();
  expect(rows).toHaveLength(files.length);
  rows.forEach((row, index) => {
    const cells = within(row).getAllByRole('cell');
    expect(cells[0].textContent).toBe(`${fileName(files[index])}${files[index]}`);
    const shown = (cells[2].textContent ?? '').split(', ').sort();
    expect(shown).toEqual(fileTriggers(files[index]));
  });
});

test('every job says its status is unavailable and links to its runs on GitHub', async () => {
  await renderAs('platform_owner');
  const files = workflowFiles();
  tableRows(/^Jobs/).slice(0, -1).forEach((row, index) => {
    const status = within(row).getAllByRole('cell')[3];
    expect(status.textContent).toBe('Status unavailable. Run history on GitHub (new tab)');
    expect(within(status).getByRole('link', { name: 'Run history on GitHub (new tab)' }).getAttribute('href')).toBe(
      `https://github.com/PunxsyProminence/ppbf-platform/actions/workflows/${files[index]}`,
    );
  });
});

test.each([false, true])('the in-app worker is listed with its setting (on: %s), and no run status', async (on) => {
  readiness.workerOn = on;
  await renderAs('platform_owner');
  const rows = tableRows(/^Jobs/);
  const cells = within(rows[rows.length - 1]).getAllByRole('cell').map((cell) => cell.textContent);
  expect(cells[0]).toBe('In-app workerinstrumentation.ts');
  expect(cells[3]).toBe(`Status unavailable. Setting: ${on ? 'on' : 'off'} in this deployment.`);
  expect(screen.getByRole('heading', { name: `Jobs (${workflowFiles().length + 1})` })).toBeTruthy();
});

test('the scripts listed as hand-run exist, no workflow runs them, and the page says so', async () => {
  await renderAs('platform_owner');
  const items = within(screen.getByRole('list', { name: 'Scripts no workflow runs' })).getAllByRole('listitem');
  expect(items.length).toBeGreaterThan(0);
  const runLines = workflowFiles()
    .flatMap((file) => fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8').split('\n'))
    .filter((line) => !line.trim().startsWith('#'));
  const npmScripts = (JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, '../package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }).scripts;
  for (const item of items) {
    const script = (item.textContent ?? '').split(':')[0];
    expect(fs.existsSync(path.join(SCRIPTS_DIR, script))).toBe(true);
    // Run directly, or through any package.json alias that calls it.
    const aliases = Object.entries(npmScripts).filter(([, command]) => command.includes(script)).map(([alias]) => alias);
    const ranBy = runLines.filter(
      (line) => line.includes(`scripts/${script}`) || aliases.some((alias) => new RegExp(`run ${alias}(\\s|$)`).test(line)),
    );
    expect(ranBy).toEqual([]);
    expect(item.textContent).toContain('No workflow runs this.');
  }
});

test('the page can run or change nothing, and prints no audit confidence or flag column', async () => {
  await renderAs('platform_owner');
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(document.querySelector('form')).toBeNull();
  expect(document.querySelector('input, select, textarea')).toBeNull();
  const headers = screen.getAllByRole('columnheader').map((header) => header.textContent ?? '');
  expect(headers.some((header) => /confidence|missing gate|looks wrong|certainty/i.test(header))).toBe(false);
});

// Lane BT, BOA-13 (Overwatch Q7 A): the Stripe platform registration steps moved here from the
// gym admin's Payment Accounts page. They are shown to the platform owner, on this server-rendered
// view, until all three Container App secrets are set; a configured value is never printed.
describe('Stripe platform account registration', () => {
  const HEADING = 'Platform account registration (done once by PPBF)';

  test('while unregistered, the platform owner gets the exact walkthrough, with no control', async () => {
    await renderAs('platform_owner');

    const section = screen.getByRole('heading', { name: HEADING }).closest('section') as HTMLElement;
    const steps = within(section).getAllByRole('listitem');
    expect(steps).toHaveLength(6);
    for (const name of ['PAYMENT_CONNECT_CLIENT_ID', 'PAYMENT_PLATFORM_SECRET_KEY', 'PAYMENT_PLATFORM_WEBHOOK_SECRET', 'account.application.deauthorized']) {
      expect(within(section).getByText(name)).toBeTruthy();
    }
    expect(steps[0].textContent).toContain('connect to it later from Payment Accounts.');
    expect(steps[5].textContent).toMatch(/^The Connect buttons on Payment Accounts now work\./);
    expect(section.textContent).not.toMatch(/buttons above|Reload this page/);
    expect(within(section).getByText(/nothing charges through these accounts yet\. Configuration only\s+opens onboarding\./)).toBeTruthy();
    expect(section.querySelector('a, button, form, input, select, textarea')).toBeNull();
  });

  test.each([
    ['one value set', { connectClientId: 'ca_value_never_shown', platformSecretKey: null, webhookSecret: null }],
    ['two values set', { connectClientId: 'ca_value_never_shown', platformSecretKey: 'sk_value_never_shown', webhookSecret: null }],
  ])('with %s it still shows, and prints no configured value', async (_label, config) => {
    Object.assign(payment, config);
    await renderAs('platform_owner');

    expect(screen.getByRole('heading', { name: HEADING })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/value_never_shown/);
  });

  test('once all three are set, the section is gone and no value is printed', async () => {
    Object.assign(payment, { connectClientId: 'ca_value_never_shown', platformSecretKey: 'sk_value_never_shown', webhookSecret: 'whsec_value_never_shown' });
    await renderAs('platform_owner');

    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
    expect(document.body.textContent).not.toMatch(/value_never_shown|PAYMENT_PLATFORM_SECRET_KEY/);
  });
});

// AS12-2, BOA-11 (OD-2026-10-17-001 ruling 1): the platform view's link to
// /admin/platform reads that page's title. The eyebrow above it is not a link.
test('the platform view links back to Omega by its title', async () => {
  await renderAs('platform_owner');
  expect(screen.getByRole('link', { name: 'Omega' }).getAttribute('href')).toBe('/admin/platform');
  expect(screen.queryByRole('link', { name: 'Platform Desk' })).toBeNull();
});
